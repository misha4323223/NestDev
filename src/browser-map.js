"use strict";

/* ─── Карта страницы и поиск элементов ───────────────────────────────────────
   Вынесено из browser-tools.js (часть 39, заход 4). Здесь всё, что превращает
   живую страницу в понятный агенту список: классификация слоёв поверх страницы
   (перевод, cookie, юридическое согласие, диалог), сама карта (collectMap поверх
   collectInPage, который исполняется ВНУТРИ страницы) и умный поиск цели —
   списки кандидатов для клика и для полей, ожидание появления элемента, поиск
   ПО ВСЕМ фреймам и человеческий текст промаха с подсказками.

   Зависимости: dom-map.js (роли, имена, ref, подсказки) и collectInPage из
   browser-inpage.js. Одна вещь приходит мостом из ядра — sleep: он общий для
   всего модуля браузера, поэтому остался в browser-tools.js. Состояние сессии
   (вкладки, CDP) модуль за собой не тянет.
*/

const dom = require("./dom-map.js"); // карта интерфейса: роли, имена, ref, подсказки
const { collectInPage } = require("./browser-inpage.js"); // снимок страницы исполняется ВНУТРИ неё

// Общий помощник ядра — только мостом (см. шапку).
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setBrowserMapDeps(d) {
  if (d && typeof d.sleep === "function") sleep = d.sleep;
  return true;
}

// Сколько ждём появления элемента, прежде чем сказать «не нашёл». Раньше провал был
// мгновенным: если SPA ещё не дорисовала кнопку, модель получала ошибку и тратила
// ходы на browserWait и повторный browserSnapshot. Теперь ждём сами.
const FIND_TIMEOUT = 3000;
const FIND_POLL_MS = 200;
// По ref ждать почти нечего: либо элемент на месте, либо ref устарел после перехода.
const FIND_TIMEOUT_REF = 800;

// ── Карта страницы и умный поиск элементов ────────────────────────────────

// Классификация слоя поверх страницы по имени/классу/тексту. Чистая функция —
// используется и инструментом, и тестами.
function overlayKind(o) {
  const hay = ((o && o.name) || "") + " " + ((o && o.cls) || "") + " " + ((o && o.text) || "");
  const s = String(hay).toLowerCase();
  if (/goog-te|skiptranslate|goog-gt/.test(s)) return "translate";
  if (/terms of service|terms and conditions|пользовательск|условия использования|i agree|я согласен|лицензионн|безопасност/.test(s)) return "terms";
  if (/cookie|печень|куки|accept all|принять все/.test(s)) return "cookie";
  if (/перевести|перевод страницы|translate this page|не сейчас|no thanks|never translate/.test(s)) return "translate";
  if (/dismiss|закрыть|понятно|got it|позже|later|больше не показывать/.test(s)) return "noise";
  return "dialog";
}

const OVERLAY_LABEL = {
  translate: "окно перевода Google",
  terms: "юридическое согласие (terms of service)",
  cookie: "баннер cookie",
  noise: "информационный баннер",
  dialog: "диалоговое окно",
};

// Элементы диалога с человеческими пометками: что это (галочка/кнопка/поле),
// как называется и как по нему действовать.
function overlayItems(map, dialogName) {
  const items = (map && map.items) || [];
  return items.filter((it) => it.inDialog && (!dialogName || it.dialogName === dialogName));
}

// Собрать карту страницы и превратить её в элементы для агента (роли и имена — из dom-map).
async function collectMap(page) {
  const raw = await page.evaluate(collectInPage);
  const items = [];
  let order = 0;
  for (const r of (raw && raw.items) || []) {
    if (!dom.isInteractive(r)) continue;
    order += 1;
    items.push({
      ref: r.ref,
      role: dom.roleOf(r),
      name: dom.accessibleName(r),
      tag: r.tag,
      type: r.type,
      id: r.id,
      cls: r.cls,
      placeholder: r.placeholder,
      href: r.href ? String(r.href).slice(0, 200) : "",
      disabled: !!r.disabled,
      checked: !!r.checked,
      secret: r.type === "password",
      inViewport: r.inViewport !== false,
      inDialog: !!r.inDialog,
      dialogName: r.dialogName || "",
      hiddenInput: !!r.hiddenInput,
      peNone: !!r.peNone,
      order,
    });
  }
  // Элементы открытого диалога — В НАЧАЛЕ карты: он перекрывает страницу,
  // поэтому работать надо с ним, а обычные элементы подождут (сортировка
  // стабильная, порядок внутри групп сохраняется).
  items.sort((a, b) => (b.inDialog ? 1 : 0) - (a.inDialog ? 1 : 0));
  return {
    url: (raw && raw.url) || "",
    title: (raw && raw.title) || "",
    items,
    overlays: (raw && raw.overlays) || [],
  };
}

// Селектор может прийти как CSS, text=… или xpath=… — поддерживаем все виды.
function cssOrTextLocator(page, s) {
  const t = String(s || "").trim();
  if (/^xpath=/i.test(t)) return page.locator("xpath=" + t.slice(6).trim());
  return page.locator(t);
}

// Первый подходящий локатор: сначала ВИДИМЫЙ, иначе — просто существующий
// (элемент может появиться чуть позже — нативная авто-догрузка Playwright).
async function firstUsable(candidates) {
  let fallback = null;
  for (const c of candidates) {
    if (!c || !c.loc) continue;
    let loc = c.loc;
    try {
      if (typeof loc.first === "function") loc = loc.first();
    } catch {}
    let n = 0;
    try { n = await loc.count(); } catch { n = 0; }
    if (!n) continue;
    let vis = false;
    try { vis = await loc.isVisible(); } catch { vis = false; }
    if (vis) return { loc, desc: c.desc };
    if (!fallback) fallback = { loc, desc: c.desc };
  }
  return fallback;
}

const CLICK_ROLES = ["button", "link", "menuitem", "tab", "checkbox", "radio", "option", "switch", "treeitem"];
const FIELD_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];

// Кандидаты для клика — от самого надёжного (ref) к самому общему (текст).
function clickCandidates(page, q) {
  const out = [];
  if (q.ref) out.push({ loc: page.locator(dom.refSelector(q.ref)), desc: "ref " + q.ref });
  if (q.selector) {
    out.push({ loc: cssOrTextLocator(page, q.selector), desc: q.selector });
    if (!/^(text|xpath)=/i.test(q.selector)) {
      out.push({ loc: page.getByText(q.selector, { exact: false }), desc: "текст «" + q.selector + "»" });
    }
  }
  if (q.role) {
    out.push({
      loc: page.getByRole(q.role, q.name ? { name: q.name } : {}),
      desc: "role=" + q.role + (q.name ? ' name="' + q.name + '"' : ""),
    });
  }
  // Поиск по имени идёт всегда, даже если роль задана: так запрос по роли из карты
  // («clickable» у div) все равно найдёт кнопку, если роль не совпала.
  const nm = q.name || q.label || q.text;
  if (nm) {
    for (const role of CLICK_ROLES) {
      out.push({ loc: page.getByRole(role, { name: nm }), desc: "role=" + role + ' name="' + nm + '"' });
    }
    out.push({ loc: page.getByText(nm, { exact: false }), desc: "текст «" + nm + "»" });
  }
  return out;
}

// Кандидаты для полей ввода: ref, selector, подпись, placeholder, role+name.
function fieldCandidates(page, q) {
  const out = [];
  if (q.ref) out.push({ loc: page.locator(dom.refSelector(q.ref)), desc: "ref " + q.ref });
  if (q.selector) {
    out.push({ loc: cssOrTextLocator(page, q.selector), desc: q.selector });
    if (!/^(text|xpath)=/i.test(q.selector)) {
      out.push({ loc: page.getByLabel(q.selector, { exact: false }), desc: "подпись «" + q.selector + "»" });
      out.push({ loc: page.getByText(q.selector, { exact: false }), desc: "текст «" + q.selector + "»" });
    }
  }
  if (q.label) out.push({ loc: page.getByLabel(q.label, { exact: false }), desc: "подпись «" + q.label + "»" });
  if (q.placeholder) {
    out.push({ loc: page.getByPlaceholder(q.placeholder, { exact: false }), desc: "placeholder «" + q.placeholder + "»" });
  }
  if (q.role) {
    out.push({
      loc: page.getByRole(q.role, q.name ? { name: q.name } : {}),
      desc: "role=" + q.role + (q.name ? ' name="' + q.name + '"' : ""),
    });
  }
  const nm = q.name;
  if (nm) {
    out.push({ loc: page.getByLabel(nm, { exact: false }), desc: "подпись «" + nm + "»" });
    out.push({ loc: page.getByPlaceholder(nm, { exact: false }), desc: "placeholder «" + nm + "»" });
    for (const role of FIELD_ROLES) {
      out.push({ loc: page.getByRole(role, { name: nm }), desc: "role=" + role + ' name="' + nm + '"' });
    }
  }
  return out;
}

// Текущая вертикальная прокрутка страницы (для ожидания сдвига вместо паузы).
function readScrollY(page) {
  return page
    .evaluate(() => {
      const d = document.scrollingElement || document.documentElement;
      return d ? d.scrollTop : window.scrollY || 0;
    })
    .catch(() => null);
}

// Все «окна» страницы: сама страница + вложенные фреймы (вход через iframe,
// платёжные и капча-виджеты, ленивые консоли). Поиск по фреймам снимает
// половину «не нашёл» — раньше такой элемент был для агента невидимым.
function frameList(page) {
  const out = [page];
  try {
    if (page && typeof page.frames === "function") {
      for (const f of page.frames()) if (f && out.indexOf(f) < 0) out.push(f);
    }
  } catch {}
  return out;
}

function frameLabel(page, fr) {
  if (!fr || fr === page) return "";
  let u = "";
  try { u = fr.url() || ""; } catch {}
  if (!u) {
    try { if (typeof fr.name === "function") u = fr.name() || ""; } catch {}
  }
  return u ? " (фрейм " + String(u).slice(0, 70) + ")" : " (фрейм)";
}

async function visibleNow(loc) {
  try { return await loc.isVisible(); } catch { return false; }
}

// Поиск цели по ВСЕМ фреймам и с ожиданием появления. Если ничего не нашли сразу —
// опрашиваем страницу до timeout (по умолчанию 3 с), вместо мгновенного провала.
// Возвращает { loc, desc, frame } или невидимый запасной вариант (клик попробует
// прокрутить его и нажать силой).
async function resolveTarget(page, q, kind, opts) {
  const o = opts || {};
  const asked = parseInt(o.timeout, 10);
  const waitMs = q.ref
    ? (isNaN(asked) ? FIND_TIMEOUT_REF : Math.min(asked, 10000))
    : (isNaN(asked) ? FIND_TIMEOUT : Math.max(0, Math.min(asked, 30000)));
  const deadline = Date.now() + waitMs;
  let fallback = null;
  // Адаптивный опрос: только что появившийся элемент находится за ~80 мс,
  // а не за фиксированные 200 (к медленному сайту интервал растёт до FIND_POLL_MS).
  let findPoll = 80;
  for (;;) {
    fallback = null;
    for (const fr of frameList(page)) {
      let cands = [];
      try {
        cands = kind === "field" ? fieldCandidates(fr, q) : clickCandidates(fr, q);
      } catch (e) {
        cands = [];
      }
      const t = await firstUsable(cands);
      if (!t) continue;
      const rc = { loc: t.loc, desc: t.desc + frameLabel(page, fr), frame: fr };
      if (await visibleNow(t.loc)) return rc;
      if (!fallback) fallback = rc;
    }
    // Что-то нашли (пусть и невидимое) — не ждём: дальше решает клик (force/прокрутка).
    if (fallback) return fallback;
    if (Date.now() >= deadline) break;
    await sleep(findPoll);
    findPoll = Math.min(Math.round(findPoll * 1.6), FIND_POLL_MS);
  }
  return null;
}

// Что искать в подсказках: человеческое имя, а не CSS-селектор.
function suggestQuery(q) {
  const human = q.name || q.label || q.placeholder || q.text;
  if (human) return human;
  const s = String(q.selector || "").replace(/^(text|xpath)=/i, "");
  const stripped = s.replace(/[#.\[\]>+~*:=()'"|]/g, " ").replace(/\s+/g, " ").trim();
  return stripped || s;
}

// Промах: не молчим, а присылаем карту похожих элементов с ref — агент
// делает следующий шаг сразу, без перебора селекторов.
async function missText(page, what, q, reason) {
  let map = { items: [] };
  try { map = await collectMap(page); } catch {}
  const why = /не найден|not found|no element|Timeout|timed out/i.test(String(reason || ""))
    ? ""
    : String(reason || "").slice(0, 150);
  return (
    "Ошибка " + what + ":\n" +
    dom.suggestText({ items: map.items || [], query: suggestQuery(q), reason: why })
  );
}

module.exports = {
  setBrowserMapDeps,
  overlayKind,
  OVERLAY_LABEL,
  overlayItems,
  collectMap,
  cssOrTextLocator,
  firstUsable,
  CLICK_ROLES,
  FIELD_ROLES,
  clickCandidates,
  fieldCandidates,
  readScrollY,
  frameList,
  frameLabel,
  visibleNow,
  resolveTarget,
  suggestQuery,
  missText,
};

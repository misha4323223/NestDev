"use strict";

/* ─── Прокрутка, наведение и ленивая догрузка ────────────────────────────────
   Вынесено из browser-tools.js (часть 39, заход 5). Здесь всё, что нужно на
   тяжёлых сайтах: честное колесо мыши (`wheelAt`), состояние прокрутки строкой
   для агента (`posLine`), «что видно в кадре» с ref (`revealText`), список имён
   элементов для сравнения «что появилось после наведения» (`namesOnPage`),
   приведение запроса к ref/селектору/имени (`queryFromSpec`), ключ «что
   изменилось» (`lazyKeyOf`), догрузка ленивого списка до упора (`loadAllScroll`)
   и сами инструменты `browserScroll` (scroll) и `browserHover` (hover).

   Зависимости: dom-map.js (формат карты, разбор запроса), browser-inpage.js
   (функции, исполняемые в странице) и browser-map.js (карта и поиск цели).
   Мостом из ядра приходят: needTab (вкладка сессии), sleep/waitUntil (общий
   помощник и ожидание события) и boxOf/ACTION_TIMEOUT — координаты элемента и
   общий таймаут действия. Состояние браузера модуль за собой не тянет.
*/

const dom = require("./dom-map.js"); // карта интерфейса: роли, имена, ref, подсказки
const {
  scrollStateInPage,
  scrollPageInPage,
  scrollInnerInPage,
  hoverInPage,
  itemsKeyInPage,
  scrollItemIntoViewInPage,
} = require("./browser-inpage.js"); // функции, исполняемые в странице
const { collectMap, resolveTarget, missText } = require("./browser-map.js"); // карта и поиск цели

// Живое состояние и общие помощники ядра — только мостом (см. шапку).
let needTab = () => ({ error: "browser-scroll: needTab не подключён" });
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let waitUntil = async () => false;
let boxOf = async () => null;
let ACTION_TIMEOUT = 12000;
function setBrowserScrollDeps(d) {
  if (d && typeof d.needTab === "function") needTab = d.needTab;
  if (d && typeof d.sleep === "function") sleep = d.sleep;
  if (d && typeof d.waitUntil === "function") waitUntil = d.waitUntil;
  if (d && typeof d.boxOf === "function") boxOf = d.boxOf;
  if (d && typeof d.ACTION_TIMEOUT === "number") ACTION_TIMEOUT = d.ACTION_TIMEOUT;
  return true;
}

// ── Скорость на сложных сайтах: прокрутка, наведение, сеть, ожидание покоя ──
// Всё это агент раньше делал «на ощупь»: элементы были за экраном, меню не
// раскрывались, а после клика он гадал по DOM, что ответил сервер.

function posLine(st) {
  const st1 = st || {};
  const max = Number(st1.max) || 0;
  const y = Number(st1.y) || 0;
  const percent = max > 0 ? Math.round((y / max) * 100) : 100;
  let out = "Прокрутка: " + y + " из " + max + " (" + percent + "%)";
  if (Array.isArray(st1.inner) && st1.inner.length) {
    out += ". Со своим скроллом: " + st1.inner.map((i) => "«" + (i.cls || "блок") + "» " + i.top + "/" + i.max).join(", ");
  }
  if (max > 0 && y >= max - 2) out += ". Это низ — ниже ничего нет.";
  return out;
}

// Что видно в кадре СЕЙЧАС: с ref, чтобы сразу кликать без повторной карты.
async function revealText(page, limit) {
  const map = await collectMap(page);
  const shown = map.items.filter((it) => it.inViewport && !it.inDialog);
  const off = map.items.filter((it) => !it.inViewport).length;
  const text = dom.formatSnapshot({
    items: shown,
    url: map.url,
    title: map.title,
    filter: "",
    limit: Math.min(Math.max(parseInt(limit, 10) || 10, 3), 30),
  });
  return text + (off ? "\n(вне экрана ещё " + off + " — прокрути browserScroll или ищи по имени)" : "");
}

// Имена интерактивных элементов страницы — для сравнения «что появилось после наведения».
async function namesOnPage(page) {
  try {
    const map = await collectMap(page);
    return map.items.map((it) => it.role + " «" + it.name + "»");
  } catch (e) {
    return [];
  }
}

// {"click":"Войти"} или {ref:"e2"} или CSS — приводим к виду, понятному поиску.
function queryFromSpec(spec) {
  const s = String(spec == null ? "" : spec).trim();
  if (!s) return null;
  if (/^e\d+$/i.test(s)) return { ref: s };
  if (/^[#.\[]/.test(s)) return { selector: s };
  if (/^text=|^xpath=/i.test(s)) return { selector: s };
  return { name: s, text: s };
}

async function wheelAt(page, dx, dy, times, box) {
  let vp = null;
  try { vp = page.viewportSize ? page.viewportSize() : null; } catch (e) { vp = null; }
  const w = (vp && vp.width) || 1024;
  const h = (vp && vp.height) || 768;
  const cx = box ? Math.round(box.x + box.width / 2) : Math.round(w / 2);
  const cy = box ? Math.round(box.y + box.height / 2) : Math.round(h / 2);
  try { if (page.mouse && page.mouse.move) await page.mouse.move(cx, cy); } catch (e) {}
  if (!page.mouse || !page.mouse.wheel) return { ok: false };
  // Прокрутка «долетела» — идём дальше, не выжидая всю фиксированную паузу.
  const readPos = () =>
    page
      .evaluate(() => {
        const d = document.scrollingElement || document.documentElement;
        return (d ? d.scrollTop : window.scrollY || 0) + ":" + (d ? d.scrollLeft : window.scrollX || 0);
      })
      .catch(() => null);
  for (let i = 0; i < times; i++) {
    const before = box ? null : await readPos();
    try {
      await page.mouse.wheel(dx, dy);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
    }
    // Внутренний контейнер прогресс по документу не показывает — короткая пауза.
    if (box) {
      await sleep(180);
      continue;
    }
    const moved = await waitUntil(async () => {
      const now = await readPos();
      return now != null && now !== before;
    }, 220, 45);
    // Небольшая страховка на инерцию/плавную прокрутку, чтобы следующий щелчок
    // колеса не наложился на ещё идущую анимацию.
    await sleep(moved ? 90 : 140);
  }
  return { ok: true };
}

// ── Ленивая подгрузка (ВК, ленты, истории переписки) ────────────────────────
// Ключ «что изменилось»: позиция прокрутки + счётчик внутреннего контейнера +
// длина текста страницы. Пока ключ меняется — список догружается.
function lazyKeyOf(st, textLen) {
  const s = st || {};
  const inner = Array.isArray(s.inner) ? s.inner.map((i) => i.max).join(",") : "";
  // Только СОДЕРЖИМОЕ: высота документа (и внутренних контейнеров) + длина текста.
  // Позицию прокрутки сюда НЕ берём: пока страница едет по уже загруженному,
  // «роста» нет — иначе список считался бы растущим до самого низа, и цикл
  // догрузки никогда не остановился бы сам.
  return (s.docH || s.max || 0) + "|" + inner + "|" + (textLen || 0);
}

// Догрузить ленивый список/историю: крутим, пока появляется новое содержимое, и
// останавливаемся сами. Раньше агент крутил по одному шагу за ход и не понимал,
// когда хватит (список диалогов ВК: в DOM только ~15 видимых чатов).
async function loadAllScroll(page, args) {
  args = args || {};
  const how = String(args.how || args.direction || "down").toLowerCase();
  const up = how === "up" || how === "top";
  const maxSteps = Math.max(1, Math.min(parseInt(args.times, 10) || 12, 40));
  const dyBase = Math.max(300, Math.round(Number(args.by != null ? args.by : args.dy) || 0) || 700);
  // item — селектор СТРОКИ списка. С ним рост считается по уникальным ключам
  // строк (а не по длине текста страницы, где перемешаны меню и реклама), а
  // последняя строка прокручивается в кадр: именно это движение запускает
  // IntersectionObserver, который и подгружает следующую пачку. Прокрутка «на
  // глаз» крупным шагом промахивается мимо него — строки проскакивают.
  const itemSel = String(args.item || args.items || "").trim();
  let box = null;
  let boxDesc = "";
  if (args.container) {
    const cq = queryFromSpec(args.container);
    const t = cq ? await resolveTarget(page, cq, "click") : { error: "укажи container — имя, ref или селектор" };
    if (t && t.error) return t.error;
    box = await boxOf(t.loc);
    boxDesc = t.desc;
  }
  const readState = async () => (await page.evaluate(scrollStateInPage).catch(() => ({}))) || {};
  const textLen = async () =>
    page.evaluate(() => String((document.body && document.body.innerText) || "").length).catch(() => 0);
  const itemState = async () =>
    itemSel ? await page.evaluate(itemsKeyInPage, { item: itemSel }).catch(() => null) : null;
  let lastItems = null; // состояние строк последнего шага (сколько их и сколько всего)
  const mark = async () => {
    if (itemSel) {
      const s = await itemState();
      lastItems = s;
      if (s) return "items:" + s.count + ":" + s.joined;
    }
    lastItems = null;
    return lazyKeyOf(await readState(), await textLen());
  };

  let prev = await mark();
  // Сколько строк всего обещает список: по этой цифре понимаем, что «два пустых
  // шага» — это не конец, а переиспользование узлов виртуальным списком.
  const target = lastItems && Number(lastItems.setsize) ? Number(lastItems.setsize) : 0;
  let steps = 0;
  let grew = 0;
  let sameRuns = 0;
  for (let i = 0; i < maxSteps; i++) {
    const dy = up ? -dyBase : dyBase;
    if (itemSel) {
      // Строка списка: прокручиваем ЕЁ в кадр (а не страницу «на глаз»).
      const sc = await page.evaluate(scrollItemIntoViewInPage, { item: itemSel, up: up }).catch(() => null);
      if (!sc || !sc.ok) {
        const w = await wheelAt(page, 0, dy, 1, box);
        if ((!w.ok || w.error) && !box) {
          await page.evaluate(scrollPageInPage, { how: up ? "up" : "down", dy: dy, dx: 0 }).catch(() => null);
        }
      }
    } else if (box) {
      await wheelAt(page, 0, dy, 1, box);
    } else {
      const w = await wheelAt(page, 0, dy, 1, null);
      if (!w.ok || w.error) {
        await page.evaluate(scrollPageInPage, { how: up ? "up" : "down", dy: dy, dx: 0 }).catch(() => null);
      }
    }
    steps++;
    // Ждём подгрузку: содержимое или позиция должны измениться (иначе список кончился).
    await waitUntil(async () => (await mark()) !== prev, 800, 70);
    await sleep(140);
    const now = await mark();
    if (now === prev) {
      sameRuns++;
    } else {
      grew++;
      sameRuns = 0;
    }
    prev = now;
    // «Пусто дважды» — конец только если список не обещал больше строк.
    if (sameRuns >= 2 && (!target || (lastItems && lastItems.uniq >= target))) break;
  }
  const st = await readState();
  const atEnd = up ? Number(st.y || 0) <= 2 : Number(st.max || 0) - Number(st.y || 0) <= 2;
  const its = itemSel ? await itemState() : null;
  // Список не кончился, хотя прокрутка буксовала: виртуальный список обещает
  // больше строк, чем успел показать. Молчать нельзя — иначе агент соберёт
  // 16 диалогов из 110 и будет считать работу законченной.
  const short = !!(target && its && its.uniq < target);
  let out =
    "OK — " + (box ? "догрузил контейнер «" + boxDesc + "» " : "догрузил страницу ") + how + ", шагов: " + steps +
    ". Новое содержимое появилось на " + grew + " " + (grew === 1 ? "шаге" : "шагах") +
    (short
      ? ", но список НЕ кончился: в DOM " + its.uniq + " строк из ~" + target + " (aria-setsize) — виртуальный список переиспользует узлы. Собери данные запросом (browserReplay) или вызови browserScroll ещё раз."
      : sameRuns >= 2
        ? ", дальше пусто — это конец списка."
        : atEnd
          ? ", похоже, это конец списка."
          : ", упёрся в предел " + maxSteps + " шагов — вызови ещё раз, если нужно больше.");
  if (its) {
    out += "\nСтрок в списке: " + its.count + " (уникальных: " + its.uniq + (target ? " из ~" + target : "") + ").";
    if (!its.count) {
      out += "\nСелектор строки ничего не нашёл — проверь его через browserDOM (в ВК строки диалога: .ConvoListItem, старый клиент — .convo-item).";
    }
    if (its.sample && its.sample.length) out += "\nВидно: " + its.sample.join(" · ");
  }
  out += "\n" + posLine(st);
  if (args.read || args.text) {
    const txt = await page
      .evaluate(() => String((document.body && document.body.innerText) || "").replace(/\n{3,}/g, "\n\n"))
      .catch(() => "");
    if (txt) {
      const cap = Math.min(Math.max(parseInt(args.limit, 10) || 4000, 500), 12000);
      out += "\n\nТекст страницы (начало):\n" + String(txt).slice(0, cap);
      if (String(txt).length > cap) out += "\n… (текст длиннее — читай нужный кусок через browserText)";
    }
  } else {
    out += "\n" + (await revealText(page, args.limit));
  }
  return out;
}
// browserScroll: страница, внутренние контейнеры, «до элемента» (+ что появилось в кадре).
async function scroll(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const page = t.tab.page;

  // «Прокрути до элемента»: ищем так же, как для клика (ref/имя/селектор, фреймы).
  const toSpec = args.to != null ? args.to : args.toText != null ? args.toText : null;
  if (toSpec != null && String(toSpec).trim()) {
    const q = queryFromSpec(toSpec);
    const target = await resolveTarget(page, q, "click");
    if (!target) return missText(page, "browserScroll", q, "не нашёл элемент для прокрутки");
    if (target.error) return target.error;
    try {
      await target.loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
    } catch (e) {
      try { await target.loc.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" })); } catch (e2) {}
    }
    await sleep(150);
    const st = await page.evaluate(scrollStateInPage).catch(() => ({}));
    return (
      "OK — прокрутил до «" + target.desc + "»" + ".\n" +
      posLine(st) + "\n" + (await revealText(page, args.limit))
    );
  }

  // Ленивая подгрузка списка/истории: крутим до упора и останавливаемся сами.
  if (args.loadAll || args.all || args.untilEnd) return await loadAllScroll(page, args);

  const how = String(args.how || args.direction || (Number(args.by || args.dy) < 0 ? "up" : "down")).toLowerCase();
  const times = Math.max(1, Math.min(parseInt(args.times, 10) || 1, 20));
  const stBefore = await page.evaluate(scrollStateInPage).catch(() => ({}));
  const vh = Number(stBefore && stBefore.vh) || 800;
  const step = Math.round(Number(args.by != null ? args.by : args.dy) || Math.round(vh * 0.8));

  // Контейнер (список API, таблица, выпадающее меню): крутим его, а не страницу.
  if (args.container) {
    const cq = queryFromSpec(args.container);
    const box = cq ? await resolveTarget(page, cq, "click") : { error: "укажи container — имя, ref или селектор" };
    if (box.error) return box.error;
    const rect = await boxOf(box.loc);
    const wheel = await wheelAt(page, 0, how === "up" ? -step : step, times, rect || null);
    let res = null;
    if (!wheel.ok || wheel.error) {
      res = await box.loc.evaluate(scrollInnerInPage, { dy: how === "up" ? -step : step, how: how === "top" || how === "bottom" ? how : "down" }).catch(() => null);
    }
    const st = await page.evaluate(scrollStateInPage).catch(() => ({}));
    return (
      "OK — прокрутил контейнер «" + box.desc + "» " + how +
      (wheel.error ? " (колесо не сработало: " + wheel.error + ")" : "") +
      (res ? " → " + res.mode + " " + res.y + "/" + res.max : "") +
      ".\n" + posLine(st) + "\n" + (await revealText(page, args.limit))
    );
  }

  // Страница: сначала честное колесо мыши (ленивые ленты и SPA реагируют именно на него).
  const dy = how === "top" ? 0 : how === "bottom" ? 0 : how === "up" ? -step : step;
  const wheel = await wheelAt(page, Number(args.dx) || 0, dy * times, 1, null);
  let inPage = null;
  if (how === "top" || how === "bottom") {
    inPage = await page.evaluate(scrollPageInPage, { how: how, dx: Number(args.dx) || 0, dy: 0 }).catch(() => null);
  }
  const st = await page.evaluate(scrollStateInPage).catch(() => ({}));
  const moved = Number(st.y || 0) - Number(stBefore.y || 0);
  if (!how.match(/^(top|bottom)$/) && Math.abs(moved) < 2) {
    // Колесо не сдвинуло страницу (SPA со своим скроллом) — прокручиваем программно.
    inPage = await page.evaluate(scrollPageInPage, { how: "down", dy: dy * times, dx: Number(args.dx) || 0 }).catch(() => null);
  }
  const stAfter = await page.evaluate(scrollStateInPage).catch(() => st);
  let out =
    "OK — прокрутил " + how + (times > 1 ? " ×" + times : "") + " (" + step + "px за раз" +
    (wheel.error ? ", колесо не сработало: " + wheel.error : "") + ").\n" + posLine(stAfter);
  if (inPage && inPage.mode) out += "\nРежим: " + inPage.mode + " (сдвинуто " + inPage.moved + "px)";
  if (how !== "top" && how !== "bottom" && Math.abs(Number(stAfter.y || 0) - Number(stBefore.y || 0)) < 2) {
    out += "\n⚠️ Страница не сдвинулась: похоже, прокручивается внутренний контейнер — укажи его: browserScroll { container: \"список\" }";
  }
  out += "\n" + (await revealText(page, args.limit));
  return out;
}

// browserHover: навести мышь (меню и подсказки, которые раскрываются по hover).
async function hover(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const page = t.tab.page;
  const before = await namesOnPage(page);
  const target = await resolveTarget(page, dom.parseQuery(args), "click");
  if (target.error) return target.error;
  let how = "";
  try {
    await target.loc.hover({ timeout: ACTION_TIMEOUT });
    how = "мышью";
  } catch (e) {
    try {
      await target.loc.hover({ force: true, timeout: ACTION_TIMEOUT });
      how = "мышью в обход перекрытия";
    } catch (e2) {
      try {
        await target.loc.evaluate(hoverInPage);
        how = "событиями из DOM";
      } catch (e3) {
        return "Ошибка browserHover: " + String((e3 && e3.message) || e3).slice(0, 150);
      }
    }
  }
  // Ждём ПОЯВЛЕНИЯ новых элементов событием, а не «слепой» паузой 400 мс:
  // меню/подсказка обычно отрисованы за 60-150 мс — идём дальше сразу.
  await waitUntil(async () => {
    const now = await namesOnPage(page);
    for (const n of now) if (before.indexOf(n) < 0) return true;
    return false;
  }, 400, 70);
  const after = await namesOnPage(page);
  const fresh = [];
  for (const n of after) {
    if (before.indexOf(n) < 0 && fresh.indexOf(n) < 0) fresh.push(n);
  }
  let out = "OK — навёл " + how + " на «" + target.desc + "».";
  if (fresh.length) {
    out += "\nПоявилось " + fresh.length + ": " + fresh.slice(0, 8).join(" · ") + "\nДальше: browserSnapshot (ref появившихся пунктов) или browserClick { name: \"…\" }.";
  } else {
    out += "\nНовых элементов не появилось — на этом сайте меню не по наведению. Работай кликом (browserClick) или JS (browserEval).";
  }
  return out;
}

module.exports = {
  setBrowserScrollDeps,
  posLine,
  revealText,
  namesOnPage,
  queryFromSpec,
  wheelAt,
  lazyKeyOf,
  loadAllScroll,
  scroll,
  hover,
};

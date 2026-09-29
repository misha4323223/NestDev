"use strict";
/* ─── Группа «Интерфейс: поиск кусков, ref, панели паролей и плана, страж загрузки» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 6.

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
  selected,
  tmpdir,
  uiAll,
  uiFile,
  uiFind,
} = H;

// Помощник обязан понимать и модули, и app.js: иначе он бесполезен на середине
// разбора. Раздвоенный маркер — ошибка, а не догадка: молча взять первый попавшийся
// кусок опаснее, чем упасть.
async function testUiSearch() {
  await test("поиск кусков интерфейса: uiFind находит код в модуле, в app.js и не угадывает", () => {
    const inModule = uiFind("    loadDashboard: ycLoadDashboard,");
    assert.strictEqual(inModule.file, "yc-panel.js", "код модуля не найден через uiFind");
    const inShell = uiFind("  const YcPanel = window.YcPanel({");
    assert.strictEqual(inShell.file, "app.js", "проводка панели не найдена в app.js");
    assert.ok(inShell.code.includes("getSettings: () => settings"), "кусок найден неверно");
    assert.throws(() => uiFind("window."), /ровно в одном файле/, "uiFind не заметил раздвоенный маркер");
    assert.throws(() => uiFind("такого кода в интерфейсе нет"), /ровно в одном файле/, "uiFind не заметил отсутствующий маркер");
    assert.ok(uiAll().length > uiFile("app.js").length, "uiAll не собирает интерфейс целиком");
    assert.ok(uiAll().indexOf("root.YcPanel = factory") > 0, "в uiAll нет вынесенных модулей");
  });
}

// ── 1c. app-инструменты: стабильные ref вместо номеров [N] ──────────────────
// Мини-DOM: проверяем, что клик идёт по ref (номер ломается при перерисовке),
// промах возвращает свежую карту, разрушительное блокируется, пароли не утекают.
async function testAppUiRefs() {
  const appUi = require(path.join(ROOT, "src", "app-ui-tools.js"));

  const matches = (el, sel) => {
    sel = String(sel).trim();
    if (sel.indexOf(",") !== -1) return sel.split(",").some((s) => matches(el, s));
    const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const v = el.getAttribute(attr[1]);
      return attr[2] === undefined ? v !== null : v === attr[2];
    }
    const tag = sel.match(/^[a-zA-Z][\w-]*/);
    const id = sel.match(/#([\w-]+)/);
    const cls = sel.match(/\.([\w-]+)/);
    if (!tag && !id && !cls) return false;
    if (tag && String(el.tagName).toLowerCase() !== tag[0].toLowerCase()) return false;
    if (id && el.id !== id[1]) return false;
    if (cls && String(el.className).split(/\s+/).indexOf(cls[1]) < 0) return false;
    return true;
  };

  class El {
    constructor(tag, attrs, opts) {
      const a = Object.assign({}, attrs || {});
      const o = opts || {};
      this.tagName = tag.toUpperCase();
      this._attrs = a;
      this.id = a.id || "";
      this.className = a.class || "";
      this.innerText = o.text != null ? o.text : a.__text || "";
      this.textContent = this.innerText;
      this.placeholder = a.placeholder || "";
      this.title = a.title || "";
      this.type = a.type || "";
      this._v = a.value || "";
      this.disabled = !!o.disabled;
      this.checked = !!o.checked;
      this.isContentEditable = !!o.ce;
      this.labels = o.labels || [];
      this.onclick = o.onclick || null;
      this.clicks = 0;
      this.events = [];
      this._parent = o.parent || null;
      this._gone = !!o.gone;
      this.rect = o.rect || { width: 90, height: 24, top: 10, left: 10, bottom: 34, right: 100 };
    }
    get value() { return this._v; }
    set value(v) { this._v = v; }
    getAttribute(n) { return n in this._attrs ? String(this._attrs[n]) : null; }
    setAttribute(n, v) { this._attrs[n] = String(v); }
    getBoundingClientRect() { return Object.assign({}, this.rect); }
    scrollIntoView() { this.scrolled = true; }
    click() { this.clicks++; }
    dispatchEvent(e) { this.events.push(e && e.type); return true; }
    closest(sel) {
      let n = this._parent;
      while (n) {
        if (matches(n, sel)) return n;
        n = n._parent;
      }
      return null;
    }
  }
  function Proto() {}
  Object.defineProperty(Proto.prototype, "value", {
    get() { return this._v; },
    set(v) { this._v = v; },
    configurable: true,
  });
  class FakeEvent { constructor(type) { this.type = type; } }

  const makeWin = (elements, title) => {
    const doc = {
      title: title || "NestDev",
      body: { innerText: "Текст окна для агента" },
      activeElement: null,
      querySelectorAll: (sel) => elements.filter((el) => !el._gone && matches(el, sel)),
      querySelector: (sel) => elements.filter((el) => !el._gone && matches(el, sel))[0] || null,
    };
    const win = {
      __aiAppRefSeq: 0,
      document: doc,
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: (code) =>
          Promise.resolve(
            new Function(
              "document", "window", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "Event",
              "return " + code + ";"
            )(doc, win, () => ({ display: "block", visibility: "visible", opacity: "1" }), Proto, Proto, FakeEvent)
          ),
        capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("png") }),
      },
    };
    return win;
  };

  await test("appRead: карта с ref, ролями, именами, id; значения полей и .hidden не утекают", async () => {
    const hiddenBox = new El("div", { class: "hidden" });
    const els = [
      new El("button", { id: "btn-settings", __text: "Настройки" }),
      new El("button", { id: "btn-secrets", __text: "Секреты" }),
      new El("input", { id: "s-token", type: "password", value: "СЕКРЕТ-ТОКЕН" }),
      new El("input", { id: "s-model", placeholder: "Модель", value: "gpt-4o" }),
      new El("button", { id: "btn-hidden", __text: "Внутри скрытого" }, { parent: hiddenBox }),
    ];
    const out = await appUi.read({}, makeWin(els));
    assert.ok(/e1\s+button\s+«Настройки»\s+#btn-settings/.test(out), out.slice(0, 400));
    assert.ok(/значение скрыто/.test(out), "нет пометки скрытого значения:\n" + out);
    assert.ok(!/СЕКРЕТ-ТОКЕН/.test(out), "значение секретного поля попало в карту!");
    assert.ok(!/gpt-4o/.test(out), "значение обычного поля попало в карту:\n" + out);
    assert.ok(!/Внутри скрытого/.test(out), "элемент из .hidden попал в карту:\n" + out);
    assert.ok(/действуй по ref/.test(out), "нет подсказки про ref:\n" + out.slice(0, 300));
  });

  await test("appClick: ref переживает перерисовку окна (номер [N] — нет)", async () => {
    const els = [
      new El("button", { id: "btn-settings", __text: "Настройки" }),
      new El("button", { id: "btn-secrets", __text: "Секреты" }),
    ];
    const win = makeWin(els);
    await appUi.read({}, win);
    // Перерисовка: сверху появилась кнопка «↻» — позиции сдвинулись, ref остались.
    els.unshift(new El("button", { id: "btn-refresh", __text: "↻" }));
    const r = await appUi.click({ ref: "e2" }, win);
    assert.ok(/^OK — клик по ref e2/.test(r), r);
    assert.strictEqual(els[2].clicks, 1, "клик ушёл не в тот элемент");
    assert.strictEqual(els[0].clicks, 0, "клик попал в новую кнопку");
  });

  await test("appClick: устаревший ref НЕ кликает наугад — отдаёт свежую карту", async () => {
    const els = [new El("button", { id: "btn-a", __text: "Первая" }), new El("button", { id: "btn-b", __text: "Вторая" })];
    const win = makeWin(els);
    await appUi.read({}, win);
    els[1]._gone = true;
    const r = await appUi.click({ ref: "e2" }, win);
    assert.ok(/Ошибка appClick/.test(r) && /ref устарел/.test(r), r.slice(0, 200));
    assert.ok(/«Первая»/.test(r), "нет свежей карты:\n" + r);
    assert.strictEqual(els[0].clicks + els[1].clicks, 0, "клик всё-таки прошёл");
  });

  await test("appClick: номер [N] работает, но предупреждает; промах подсказывает ref", async () => {
    const els = [new El("button", { id: "btn-a", __text: "Настройки" }), new El("button", { id: "btn-b", __text: "Секреты" })];
    const win = makeWin(els);
    const byIndex = await appUi.click({ index: 2 }, win);
    assert.ok(/^OK/.test(byIndex) && /НОМЕРУ/.test(byIndex), byIndex);
    assert.strictEqual(els[1].clicks, 1);
    const miss = await appUi.click({ text: "Секретики" }, win);
    assert.ok(/Ошибка appClick/.test(miss) && /Похожие элементы/.test(miss), miss.slice(0, 240));
    assert.ok(/appRead/.test(miss) && !/browserSnapshot/.test(miss), "подсказка про чужой инструмент:\n" + miss);
  });

  await test("appClick: разрушительное блокируется и по ref/селектору, не только по тексту", async () => {
    const els = [new El("button", { id: "btn-del", __text: "Удалить аккаунт" })];
    const win = makeWin(els);
    const byRef = await appUi.click({ ref: "e1" }, win);
    assert.ok(/⛔/.test(byRef), byRef.slice(0, 160));
    const bySel = await appUi.click({ selector: "#btn-del" }, win);
    assert.ok(/⛔/.test(bySel), bySel.slice(0, 160));
    assert.strictEqual(els[0].clicks, 0, "опасный клик прошёл");
  });

  // Окно и рабочий стол — своим модулем (часть 40, заход 8). Проверяем ПО ФАКТУ:
  // инструменты берут ЖИВОЕ окно из моста (а не копию), скриншоты уходят событием в
  // ленту, а системные отказы объясняются словами. Текстовый сторож здесь не стоил
  // бы ничего: тела перенесены байт в байт.
  await test("окно и рабочий стол: живое окно, скриншоты окна и экрана, буфер и открытие пути", async () => {
    const { createAppTools } = require(path.join(ROOT, "src", "agent-tools-app.js"));
    // Сторож ПРОВОДКИ: отказ сборки (без живого моста) сам набор не увидел бы — он
    // собирает модуль своими руками. Так этот промах и нашёлся контролем A.
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    assert.ok(/const appTools = createAppTools\(deps, live\);/.test(shellSrc), "модуль окна собран БЕЗ живого моста — окно будет копией");
    for (const n of ["appRead", "appClick", "appScreenshot", "askUser", "clipboardWrite", "clipboardRead", "screenshotDesktop", "openPath"]) {
      assert.ok(shellSrc.indexOf('"' + n + '": appTools.' + n + ",") >= 0, "в реестре нет ссылки на " + n);
    }
    const emitted = [];
    let liveWin = makeWin([new El("button", { id: "btn-settings", __text: "Настройки" })]);
    const live = {
      get mainWindow() {
        return liveWin; // ровно так же окно отдаёт живой мост main.js
      },
      activeEmit: (ev) => emitted.push(ev),
    };
    const savedShots = [];
    const img = (w, h, tag) => ({
      __tag: tag,
      isEmpty: () => false,
      getSize: () => ({ width: w, height: h }),
      resize: () => img(w, h, tag),
      toJPEG: () => Buffer.from("jpeg-" + tag),
      toPNG: () => Buffer.from("png-" + tag),
    });
    let sources = [
      { name: "Панель Спуник — Chrome", thumbnail: img(1280, 800, "panel") },
      { name: "Проводник", thumbnail: img(800, 600, "explorer") },
    ];
    let sourcesThrow = null;
    const deps = {
      appUi: appUi,
      clipboard: { writeText: async () => {}, readText: async () => "текст-из-буфера" },
      desktopCapturer: {
        getSources: async () => {
          if (sourcesThrow) throw new Error(sourcesThrow);
          return sources;
        },
      },
      encodeShot: (i, args) => ({ buf: Buffer.from("shot-" + i.__tag), mime: args && args.png ? "image/png" : "image/jpeg", ext: ".jpg" }),
      saveScreenshotPng: (buf, base, mime) => {
        savedShots.push({ base: base, mime: mime, size: buf.length });
        return "/tmp/скриншоты/" + base + (mime === "image/png" ? ".png" : ".jpg");
      },
      truncateText: (text, n) => String(text).slice(0, n),
      resolvePath: (p) => String(p == null ? "" : p),
      fs: fs,
      shell: { openPath: async (p) => (p.indexOf("плохой") >= 0 ? "нет приложения" : "") },
    };
    const app = createAppTools(deps, live);

    // 1. Окно берётся ЖИВЫМ: подменили окно за мостом — инструмент видит новое.
    const first = await app.appRead({}, {});
    assert.ok(/Настройки/.test(first) && /btn-settings/.test(first), "appRead не увидел окно: " + String(first).slice(0, 140));
    liveWin = makeWin([new El("button", { id: "btn-secrets", __text: "Секреты" })]);
    const second = await app.appRead({}, {});
    assert.ok(/Секреты/.test(second) && !/Настройки/.test(second), "инструмент запомнил ПЕРВОЕ окно — живой мост потерян");
    const clicked = await app.appClick({ ref: "e1" }, {});
    assert.ok(/^OK/.test(clicked), "клик по живому окну не прошёл: " + String(clicked).slice(0, 140));

    // 2. Скриншот окна: картинка уходит событием в ленту, ответ называет просмотрщик.
    emitted.length = 0;
    const shot = await app.appScreenshot({}, {});
    assert.ok(/^OK — скриншот окна приложения снят/.test(shot), "ответ скриншота не тот: " + String(shot).slice(0, 120));
    const shotEvent = emitted.find((e) => e && e.type === "image");
    assert.ok(shotEvent && shotEvent.path === "app:window" && /^data:image\/png;base64,/.test(String(shotEvent.dataUrl)),
      "скриншот окна не ушёл в ленту: " + JSON.stringify(emitted).slice(0, 200));

    // 3. Заглушка askUser: вызов дошёл до реестра — обязан объяснить, а не соврать.
    assert.ok(/askUser обрабатывается отдельно/.test(await app.askUser({}, {})), "askUser не объяснил, что обрабатывается отдельно");

    // 4. Буфер обмена: пишем и читаем; отказ назван словами, а не проглочен.
    assert.ok(/OK — текст скопирован в буфер обмена \(14 симв\.\)/.test(await app.clipboardWrite({ text: "строка-в-буфер" }, {})), "запись в буфер не подтверждена");
    assert.ok(/текст-из-буфера/.test(await app.clipboardRead({}, {})), "буфер не прочитан");
    const broken = createAppTools(Object.assign({}, deps, { clipboard: { writeText: async () => { throw new Error("нет прав"); }, readText: async () => { throw new Error("занят"); } } }), live);
    assert.ok(/не удалось записать в буфер обмена: нет прав/.test(await broken.clipboardWrite({ text: "x" }, {})), "отказ записи не назван");
    assert.ok(/не удалось прочитать буфер обмена: занят/.test(await broken.clipboardRead({}, {})), "отказ чтения не назван");

    // 5. Скриншот ЭКРАНА: источник выбирается по имени, картинка уходит в ленту и файлом.
    emitted.length = 0;
    const desk = await app.screenshotDesktop({ window: "спутник" }, {});
    assert.ok(/скриншот «Панель Спуник — Chrome» \(1280×800\)/.test(desk), "выбран не тот источник экрана: " + String(desk).slice(0, 160));
    assert.ok(/analyzeImage/.test(desk), "нет подсказки про analyzeImage");
    const deskEvent = emitted.find((e) => e && e.type === "image");
    assert.ok(deskEvent && deskEvent.path === "desktop:Панель Спуник — Chrome", "скриншот экрана не ушёл в ленту: " + JSON.stringify(emitted).slice(0, 160));
    assert.strictEqual(savedShots.length, 1, "файл скриншота не сохранён: " + JSON.stringify(savedShots));
    assert.strictEqual(savedShots[0].size, Buffer.from("shot-panel").length, "сохранён не тот буфер: " + JSON.stringify(savedShots));
    // Нет источников и отказ захвата — честные ошибки, а не пустой ответ.
    sources = [];
    assert.ok(/Не удалось получить источники экрана\/окон/.test(await app.screenshotDesktop({}, {})), "пустой список источников не назван");
    sources = [{ name: "Экран 1", thumbnail: img(800, 600, "screen") }];
    sourcesThrow = "отказано в доступе";
    assert.ok(/Ошибка захвата экрана: отказано в доступе \(работает только в десктоп-приложении\)/.test(await app.screenshotDesktop({}, {})), "отказ захвата не объяснён");
    sourcesThrow = null;

    // 6. openPath: путь проверяется, отказ системы называется словами.
    const realFile = path.join(os.tmpdir(), "at8-openpath-проверка.txt");
    const badFile = path.join(os.tmpdir(), "at8-плохой-файл.txt");
    fs.writeFileSync(realFile, "проверка", "utf8");
    fs.writeFileSync(badFile, "проверка", "utf8");
    try {
      assert.ok(/^OK — открыто системным приложением/.test(await app.openPath({ path: realFile }, {})), "открытие существующего пути не подтверждено");
      assert.ok(/путь не найден/.test(await app.openPath({ path: path.join(os.tmpdir(), "at8-нет-такого-файла-9999.txt") }, {})), "несуществующий путь не отвергнут");
      assert.ok(/Не удалось открыть: нет приложения/.test(await app.openPath({ path: badFile }, {})), "отказ системы не назван");
    } finally {
      try { fs.rmSync(realFile, { force: true }); } catch {}
      try { fs.rmSync(badFile, { force: true }); } catch {}
    }
  });


  await test("appFill: ввод по ref и по подписи; секретное поле не эхом", async () => {
    const els = [new El("input", { id: "s-model", placeholder: "Модель" }), new El("input", { id: "s-mail-pass", type: "password" })];
    const win = makeWin(els);
    const r1 = await appUi.fill({ ref: "e1", text: "gpt-4o-mini" }, win);
    assert.ok(/^OK/.test(r1), r1);
    assert.strictEqual(els[0]._v, "gpt-4o-mini");
    assert.ok(els[0].events.includes("input") && els[0].events.includes("change"), "нет событий ввода: " + els[0].events);
    const r3 = await appUi.fill({ ref: "e2", text: "МойПароль123" }, win);
    assert.ok(/^OK/.test(r3) && !/МойПароль123/.test(r3) && /секретное/.test(r3), "секрет выведен: " + r3);
  });

  await test("appSelect: неверный вариант — показываем реальные варианты списка", async () => {
    const sel = new El("select", { id: "s-folder" });
    sel.options = [{ value: "msk", text: "Москва" }, { value: "tula", text: "Тула" }];
    const win = makeWin([sel]);
    const bad = await appUi.select({ ref: "e1", value: "sochi" }, win);
    assert.ok(/нет варианта «sochi»/.test(bad) && /msk \(«Москва»\)/.test(bad), bad);
    const ok = await appUi.select({ selector: "#s-folder", value: "tula" }, win);
    assert.ok(/^OK/.test(ok), ok);
    assert.strictEqual(sel.value, "tula");
  });

  await test("appWait: ждём по тексту; пустой запрос ничего не «находит»", async () => {
    const win = makeWin([new El("button", { id: "btn-ok", __text: "Сохранить" })]);
    assert.ok(/^OK — элемент появился/.test(await appUi.wait({ text: "Сохранить", timeout: 2000 }, win)));
    const nothing = await appUi.click({}, win);
    assert.ok(/укажи ref/.test(nothing), nothing);
    assert.strictEqual(win.document.querySelectorAll("button").length, 1, "мини-DOM сломан");
  });
}

// ── 4e. Интерфейс паролей: реальный код app.js + мини-DOM ──────────────────
async function testVaultUi() {
  // Код берём по маркерам через uiFind: блок паролей может переехать в свой модуль.
  const A = "  // ─────────────── Пароли сайтов (Настройки → Секреты) ───────────────";
  const B = "  // ─────────────── Секреты: переменные окружения (Настройки) ───────────────";
  const vaultBlock = uiFind(A, B);
  assert.ok(vaultBlock.start > 0, "не нашёл блок паролей в интерфейсе");

  const mkEl = (tag) => ({
    tag, className: "", textContent: "", title: "", type: "", value: "",
    children: [], onclick: null,
    appendChild(c) { this.children.push(c); return c; },
    classList: { add() {}, toggle() {}, remove() {} },
  });
  const inputs = new Map();
  const box = mkEl("div");
  // В настоящем DOM присваивание innerHTML удаляет вложенные узлы — повторяем это в заглушке.
  Object.defineProperty(box, "innerHTML", {
    get() { return this._html || ""; },
    set(v) { this._html = v; if (v === "") this.children = []; },
  });
  const $ = (id) => {
    if (id === "vault-list") return box;
    if (!inputs.has(id)) inputs.set(id, mkEl("input"));
    return inputs.get(id);
  };
  const toasts = [];
  const settings = { sitePasswords: [] };
  let persisted = 0;
  const code = vaultBlock.code;
  // Модуль читает живые настройки через getSettings(): обёртке нужна эта точка.
  const mod = new Function(
    "$", "document", "getSettings", "persistSettings", "toast", "confirm",
    code + "\nreturn { renderVault, vaultAdd, vaultDelete, vaultLoadToForm, vaultClearForm, vaultArr };"
  )($, { createElement: (t) => mkEl(t) }, () => settings, () => { persisted++; }, (t) => toasts.push(t), () => true);

  await test("vault UI: пустой список показывает подсказку", () => {
    mod.renderVault();
    assert.ok(box.innerHTML.includes("Записей пока нет"));
  });

  await test("vault UI: добавление обрезает поля, сохраняет и очищает форму", () => {
    $("s-vault-name").value = "  ВК  ";
    $("s-vault-url").value = "vk.com";
    $("s-vault-login").value = " +79000000000 ";
    $("s-vault-pass").value = "sup3r secret";
    $("s-vault-note").value = " 2FA ";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 1);
    const e = settings.sitePasswords[0];
    assert.strictEqual(e.name, "ВК");
    assert.strictEqual(e.login, "+79000000000");
    assert.strictEqual(e.password, "sup3r secret"); // пароль не портим
    assert.ok(/^v[a-z0-9]+$/.test(e.id));
    assert.strictEqual(persisted, 1, "настройки не сохранены");
    assert.strictEqual($("s-vault-name").value, "");
    assert.strictEqual($("s-vault-pass").value, "");
    assert.ok(toasts[toasts.length - 1].includes("сохранена зашифрованно"));
  });

  await test("vault UI: пустые записи не сохраняются (с понятными сообщениями)", () => {
    $("s-vault-name").value = "";
    $("s-vault-url").value = "";
    $("s-vault-login").value = "u";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 1, "запись без имени и адреса сохранилась");
    assert.strictEqual(toasts[toasts.length - 1], "Укажи название или адрес сайта");
    $("s-vault-url").value = "avito.ru";
    $("s-vault-login").value = "";
    $("s-vault-pass").value = "";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 1, "запись без логина и пароля сохранилась");
    assert.strictEqual(toasts[toasts.length - 1], "Заполни хотя бы логин или пароль");
  });

  await test("vault UI: в списке пароль показывается только маской", () => {
    settings.sitePasswords.push({ id: "z", name: "Авито", url: "avito.ru", login: "user2", password: "topsecret", note: "тест" });
    mod.renderVault();
    assert.strictEqual(box.children.length, 2, "строк: " + box.children.length);
    const cells = box.children[1].children;
    assert.strictEqual(cells.length, 4, "в строке должно быть имя, данные, ✏️ и 🗑");
    const valText = cells[1].textContent;
    assert.ok(!valText.includes("topsecret"), "пароль показан в списке: " + valText);
    assert.ok(valText.includes("••••••"), "нет маски пароля");
    assert.ok(valText.includes("user2") && valText.includes("тест"));
    assert.strictEqual(cells[2].textContent, "✏️");
    assert.strictEqual(cells[3].textContent, "🗑");
  });

  await test("vault UI: правка загружает запись без пароля и обновляет её", () => {
    mod.vaultLoadToForm(settings.sitePasswords[1]);
    assert.strictEqual($("s-vault-name").value, "Авито");
    assert.strictEqual($("s-vault-pass").value, "", "пароль не должен подставляться в форму");
    assert.ok(toasts[toasts.length - 1].includes("Пароль введи заново"));
    $("s-vault-pass").value = "newpass";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 2, "вместо обновления добавилась новая запись");
    assert.strictEqual(settings.sitePasswords[1].id, "z");
    assert.strictEqual(settings.sitePasswords[1].password, "newpass");
    assert.strictEqual(toasts[toasts.length - 1], "Запись обновлена");
  });

  await test("vault UI: удаление и устойчивость к битым данным", () => {
    mod.vaultDelete("z");
    assert.strictEqual(settings.sitePasswords.length, 1);
    assert.strictEqual(toasts[toasts.length - 1], "Запись удалена");
    settings.sitePasswords = null;
    assert.ok(Array.isArray(mod.vaultArr()), "vaultArr должен вернуть массив");
    mod.renderVault();
    assert.ok(box.innerHTML.includes("Записей пока нет"), "отрисовка не пережила null");
  });
}

// ── 4f. Секреты: панель (src/renderer/secrets-panel.js) ────────────────────
// Модуль вынесен из app.js (этап 3.5). Проверяем ПОВЕДЕНИЕ на заглушках настоящей
// разметки: переменные агента (добавление, выдача, удаление, импорт текстом и из
// файла), почта (пресеты, проверка входа, последние письма) и то, что панель берёт
// настройки ЖИВЫМИ, а не копией (иначе смена профиля до неё не дошла бы).
async function testSecretsPanel() {
  await test("секреты: панель переменных и почты работает на настоящей разметке", async () => {
    const vm = require("vm");
    const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "secrets-panel.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const known = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const els = new Map();
    // Заглушка ведёт className и classList одной коллекцией: в браузере это одно и то же,
    // а панель ставит классы и строкой, и через classList.
    const el = () => {
      let set = new Set();
      let html = "";
      return {
        children: [], value: "", textContent: "", title: "", type: "", checked: false,
        style: {}, dataset: {}, onclick: null, onchange: null,
        get className() { return [...set].join(" "); },
        set className(v) { set = new Set(String(v || "").split(/\s+/).filter(Boolean)); },
        get innerHTML() { return html; },
        set innerHTML(v) { html = String(v == null ? "" : v); if (!html) this.children.length = 0; },
        classList: {
          add: (...c) => c.forEach((x) => set.add(x)),
          remove: (...c) => c.forEach((x) => set.delete(x)),
          contains: (c) => set.has(c),
          toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c)),
        },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { cs.forEach((x) => this.children.push(x)); },
        addEventListener() {},
      };
    };
    const $ = (id) => {
      assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
      if (!els.has(id)) els.set(id, el());
      return els.get(id);
    };
    const calls = { toasts: [], persisted: 0, groups: 0, mailTest: 0, mailSend: 0, mailRecent: 0, asked: [] };
    const settings = { agentEnv: {}, agentEnvScopes: {} };
    const api = {
      policyGroups: async () => {
        calls.groups++;
        return [{ group: "git", tools: 4 }, { group: "cloud", tools: 9 }];
      },
      mailTest: async () => { calls.mailTest++; return { ok: true, total: 7, servers: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 } }; },
      mailTestSend: async () => { calls.mailSend++; return { ok: true }; },
      mailRecent: async (n) => {
        calls.mailRecent++;
        calls.asked.push(n);
        return { ok: true, total: 3, messages: [{ code: "4821", subject: "Код входа", from: "vk@vk.com", date: "12:00" }] };
      },
    };
    const deps = {
      $, api, isElectron: true,
      toast: (t) => calls.toasts.push(t),
      persistSettings: () => { calls.persisted++; },
      getSettings: () => settings,
    };
    // Встроенные объекты отдаём в песочницу: так объект, собранный внутри модуля,
    // получает обычный прототип (иначе deepStrictEqual сравнивал бы и происхождение).
    const common = () => ({ Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, isNaN, parseInt });
    const build = (over, extra) => {
      const box = Object.assign({
        module: { exports: {} }, window: {}, self: {},
        console: { log() {}, warn() {}, error() {} },
        document: { createElement: () => el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
      }, common(), extra || {});
      vm.runInNewContext(src, box, { filename: "secrets-panel.js" });
      assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");
      return box.module.exports(Object.assign({}, deps, over || {}));
    };
    const S = build();
    assert.deepStrictEqual(
      Object.keys(S).sort(),
      ["envAdd", "envImportFile", "envImportText", "mailDoRecent", "mailDoTest", "mailDoTestSend", "mailFillServers", "renderEnvVars", "renderVault", "vaultAdd", "vaultClearForm"],
      "наружу торчит лишнее или чего-то не хватает"
    );

    // 1. Пустой список — подсказка, ничего не падает.
    S.renderEnvVars();
    assert.ok(/Переменных пока нет/.test($("env-list").innerHTML), "нет подсказки про пустой список: " + $("env-list").innerHTML);

    // 2. Добавление: имя проверяется, значение сохраняется, поля чистятся.
    $("s-env-key").value = "1BAD";
    $("s-env-value").value = "x";
    S.envAdd();
    assert.strictEqual(Object.keys(settings.agentEnv).length, 0, "имя переменной не проверяется");
    assert.ok(/латиница/.test(calls.toasts[calls.toasts.length - 1]), "нет понятной подсказки про имя: " + calls.toasts.join(" | "));
    $("s-env-key").value = " DATABASE_URL ";
    $("s-env-value").value = "postgres://u:p@h/db";
    S.envAdd();
    assert.strictEqual(settings.agentEnv.DATABASE_URL, "postgres://u:p@h/db", "значение не сохранено");
    assert.strictEqual(calls.persisted, 1, "настройки не сохранены");
    assert.strictEqual($("s-env-key").value, "", "поле имени не очищено");
    // Группы выдачи приходят из политики асинхронно — даём ответу дойти.
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.groups >= 1, "окно не спросило группы выдачи у главного процесса");

    // 3. Список: значение только маской, выдача — выбором, группы подписаны по-человечески.
    S.renderEnvVars();
    const rows = $("env-list").children;
    assert.strictEqual(rows.length, 1, "строк в списке: " + rows.length);
    const cells = rows[0].children;
    assert.strictEqual(cells.length, 4, "в строке должно быть имя, значение, выдача и 🗑: " + cells.length);
    assert.strictEqual(cells[0].textContent, "DATABASE_URL");
    assert.ok(!cells[1].textContent.includes("postgres://u:p"), "значение переменной показано в списке: " + cells[1].textContent);
    assert.ok(/••••/.test(cells[1].textContent), "нет маски значения: " + cells[1].textContent);
    const sel = cells[2];
    assert.ok(/env-scope/.test(sel.className), "нет выбора выдачи: " + sel.className);
    assert.strictEqual(sel.children.length, 4, "в выдаче не «Всем + никому + 2 группы»: " + sel.children.length);
    assert.ok(sel.children.some((o) => o.textContent.indexOf("git и GitHub") !== -1), "группа политики не подписана по-человечески");
    assert.strictEqual(sel.value, "*", "по умолчанию переменная не «всем»: " + sel.value);

    // 4. Выбор группы: выдаётся, сохраняется, виден в списке; «Всем» — снова без записи.
    sel.value = "git";
    sel.onchange();
    // Массив собран внутри модуля (свой контекст vm), поэтому сверяем значения.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(settings.agentEnvScopes.DATABASE_URL)), ["git"], "выдача не записалась: " + JSON.stringify(settings.agentEnvScopes));
    assert.strictEqual(calls.persisted, 2, "выдача не сохранена");
    assert.strictEqual($("env-list").children[0].children[2].value, "git", "выдача не отражена в списке: " + $("env-list").children[0].children[2].value);
    assert.ok(/limited/.test($("env-list").children[0].children[2].className), "ограничение не подсвечено");
    $("env-list").children[0].children[2].value = "*";
    $("env-list").children[0].children[2].onchange();
    assert.ok(!("DATABASE_URL" in settings.agentEnvScopes), "«Всем» оставило запись ограничения");

    // 5. Импорт текстом: комментарии, export, кавычки, мусор; пустой ввод — подсказка.
    $("s-env-import").value = "   ";
    S.envImportText();
    assert.ok(/KEY=VALUE/.test(calls.toasts[calls.toasts.length - 1]), "нет подсказки про формат: " + calls.toasts.join(" | "));
    $("s-env-import").value = "# коммент\nexport TOKEN='abc'\nBAD LINE\nPLAIN=42\nQUOTED=\"a b\"";
    S.envImportText();
    assert.strictEqual(settings.agentEnv.TOKEN, "abc", "export/кавычки разобраны неверно: " + settings.agentEnv.TOKEN);
    assert.strictEqual(settings.agentEnv.PLAIN, "42");
    assert.strictEqual(settings.agentEnv.QUOTED, "a b", "кавычки не сняты: " + settings.agentEnv.QUOTED);
    assert.strictEqual(settings.agentEnv["BAD LINE"], undefined, "мусорная строка попала в переменные");
    assert.strictEqual($("s-env-import").value, "", "поле импорта не очищено");

    // 6. Импорт из файла: текст читает FileReader, переменные попадают в настройки.
    // FileReader отдаёт содержимое переданного файла: пустой файл обязан честно
    // сказать, что строк KEY=VALUE в нём нет.
    const FileReaderStub = function () {
      this.readAsText = (file) => { this.result = (file && file.text) || ""; this.onload(); };
    };
    const filePanel = build({}, { FileReader: FileReaderStub });
    filePanel.envImportFile({ name: ".env", text: "FROM_FILE=yes" });
    assert.strictEqual(settings.agentEnv.FROM_FILE, "yes", "импорт из файла не сработал");
    assert.ok(/Импортировано из файла: 1/.test(calls.toasts[calls.toasts.length - 1]), "нет отчёта об импорте: " + calls.toasts.join(" | "));
    const beforeToasts = calls.toasts.length;
    filePanel.envImportFile(null); // файл не выбран — молча ничего
    assert.strictEqual(calls.toasts.length, beforeToasts, "вызов без файла что-то сообщил: " + calls.toasts[calls.toasts.length - 1]);
    filePanel.envImportFile({}); // файл без содержимого — честный отчёт
    assert.ok(/нет строк вида KEY=VALUE/.test(calls.toasts[calls.toasts.length - 1]), "пустой файл не объяснён: " + calls.toasts[calls.toasts.length - 1]);

    // 7. Удаление кнопкой 🗑 в строке: переменная уходит вместе со своей выдачей
    //    (осиротевшее ограничение ожило бы, когда переменную создадут заново).
    settings.agentEnv = { KILL_ME: "x" };
    settings.agentEnvScopes.KILL_ME = ["git"];
    S.renderEnvVars();
    const killRow = $("env-list").children[0];
    assert.strictEqual(killRow.children[0].textContent, "KILL_ME");
    killRow.children[3].onclick();
    assert.strictEqual(settings.agentEnv.KILL_ME, undefined, "переменная не удалена кнопкой");
    assert.ok(!("KILL_ME" in settings.agentEnvScopes), "выдача удалённой переменной осталась");
    assert.ok(/Удалено: KILL_ME/.test(calls.toasts[calls.toasts.length - 1]), "нет отчёта об удалении: " + calls.toasts[calls.toasts.length - 1]);

    // 8. Почта: пресеты по адресу, заполнение серверов, подсказки провайдеров.
    $("s-mail-address").value = "user@gmail.com";
    S.mailFillServers();
    assert.strictEqual($("s-mail-imap-host").value, "imap.gmail.com");
    assert.strictEqual($("s-mail-smtp-host").value, "smtp.gmail.com");
    assert.strictEqual($("s-mail-smtp-port").value, "465");
    assert.ok(/пароль приложения/.test($("mail-msg").textContent), "нет подсказки Gmail: " + $("mail-msg").textContent);
    $("s-mail-address").value = "user@outlook.com";
    S.mailFillServers();
    assert.strictEqual($("s-mail-starttls").checked, true, "STARTTLS для Outlook не включён");
    $("s-mail-address").value = "user@some-company.io";
    S.mailFillServers();
    assert.strictEqual($("s-mail-imap-host").value, "imap.some-company.io", "неизвестный провайдер не угадан по домену: " + $("s-mail-imap-host").value);

    // 9. Проверка входа: успех, отказ с подсказкой и честный отказ в веб-режиме.
    await S.mailDoTest();
    assert.strictEqual(calls.mailTest, 1);
    assert.ok(/Вход выполнен/.test($("mail-msg").textContent) && /imap.gmail.com:993/.test($("mail-msg").textContent), "успех не показан: " + $("mail-msg").textContent);
    assert.ok(!$("mail-msg").classList.contains("error"), "успех помечен как ошибка");
    const bad = build({ api: Object.assign({}, api, { mailTest: async () => ({ ok: false, error: "Неверный пароль", servers: { note: "Проверь пароль приложения" } }) }) });
    await bad.mailDoTest();
    assert.ok(/Неверный пароль/.test($("mail-msg").textContent) && /Проверь пароль приложения/.test($("mail-msg").textContent), "отказ не объяснён: " + $("mail-msg").textContent);
    assert.ok($("mail-msg").classList.contains("error"), "отказ не помечен как ошибка");
    const web = build({ isElectron: false });
    await web.mailDoTest();
    assert.ok(/desktop-приложении/.test($("mail-msg").textContent), "в веб-режиме нет честного отказа: " + $("mail-msg").textContent);
    assert.strictEqual(calls.mailTest, 1, "в веб-режиме запрос к главному процессу всё равно ушёл");

    // 10. Последние письма: код письма подписан, список нарисован, счёт в статусе.
    await S.mailDoRecent();
    assert.deepStrictEqual(calls.asked, [5], "запрошено не 5 писем: " + JSON.stringify(calls.asked));
    assert.ok(/🔑 4821/.test($("mail-list").children[0].children[0].textContent), "код письма не показан: " + $("mail-list").children[0].children[0].textContent);
    assert.ok(/Последние письма: 1 из 3/.test($("mail-msg").textContent), "счёт писем не показан: " + $("mail-msg").textContent);

    // 11. Настройки берутся ЖИВЫМИ: снаружи объект перезаписывают (смена профиля),
    //     панель обязана увидеть новый, а не прежнюю копию.
    const fresh = { agentEnv: { ONLY_NEW: "1" }, agentEnvScopes: {} };
    const live = build({ getSettings: () => fresh });
    live.renderEnvVars();
    assert.strictEqual($("env-list").children.length, 1, "панель читает старые настройки: " + $("env-list").children.length);
    assert.strictEqual($("env-list").children[0].children[0].textContent, "ONLY_NEW");

    // 12. Негативный контроль: забытая зависимость падает громко, а не молча.
    const broken = build({ getSettings: undefined });
    assert.throws(() => broken.renderEnvVars(), /getSettings/, "забытая зависимость не привела к понятной ошибке");

    // 13. Проводка: оболочка строит панель и отдаёт ей ЖИВЫЕ настройки да IPC.
    const appSrc2 = uiFile("app.js");
    const wiring = appSrc2.slice(appSrc2.indexOf("window.SecretsPanel({"));
    const wiringCall = wiring.slice(0, wiring.indexOf("});"));
    for (const need of ["$: $", "api: api", "isElectron: isElectron", "toast: toast", "persistSettings: ChatStore.persistSettings", "getSettings: () => settings"]) {
      assert.ok(wiringCall.includes(need), "в проводке панели секретов нет " + need + ": " + wiringCall.replace(/\s+/g, " "));
    }
    assert.ok(/SecretsPanel\.mailDoTest\b/.test(appSrc2), "кнопка проверки почты не связана с панелью");
    assert.ok(/SecretsPanel\.envAdd\b/.test(appSrc2), "кнопка добавления переменной не связана с панелью");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// План работ агента (todoWrite): чистая логика, хранение, панель, связки.
// ─────────────────────────────────────────────────────────────────────────────
async function testPlanPanel() {
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const mainSrc = backendSrc();
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
  const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  // ── Модуль плана: собираем НАСТОЯЩИЙ src/renderer/plan-panel.js его фабрикой ──
  // (этап A, часть 3 — подсистема плана вынесена из app.js). Проверяем не копию
  // кода из теста, а тот файл, который грузит окно.
  const planSrc = uiFile("plan-panel.js");
  // Фабрика вызывается в ТОМ ЖЕ окружении, что и тест: массивы, собранные модулем,
  // получают обычный прототип, и deepStrictEqual сравнивает данные, а не прототипы.
  const planFactory = new Function("module", planSrc + "\nreturn module.exports;")({ exports: {} });
  assert.strictEqual(typeof planFactory, "function", "модуль плана не отдал фабрику");

  // Игрушечный DOM: ровно те свойства, которые нужны панели.
  const mkEl = (tag) => {
    let cls = new Set();
    let html = "";
    const el = {
      tag,
      children: [],
      textContent: "",
      style: {},
      title: "",
      onclick: null,
      appendChild(ch) {
        el.children.push(ch);
        return ch;
      },
      querySelector() {
        return null;
      },
    };
    // className и classList должны быть одним состоянием: панель ставит классы
    // строкой (className) и читает их через classList.contains.
    Object.defineProperty(el, "className", {
      get: () => Array.from(cls).join(" "),
      set: (v) => { cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(el, "innerHTML", {
      get: () => html,
      set: (v) => { html = String(v); if (!v) el.children.length = 0; },
    });
    el.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
      toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
    };
    return el;
  };
  const nodeText = (n) => (n && n.textContent ? n.textContent : "") + " " + ((n && n.children) || []).map(nodeText).join(" ");
  const hosts = {};
  let activeChat = null;

  // Лимит истории планов живёт в оболочке (рядом с sanitizeChats) — берём его оттуда,
  // чтобы тест не разошёлся с настоящим числом.
  const limitFromShell = Number((/const PLAN_ARCHIVE_LIMIT = (\d+);/.exec(appSrc) || [])[1]);
  assert.ok(limitFromShell > 0, "в оболочке не найден лимит истории планов");
  // Зависимости — те же, что даёт оболочка.
  const deps = {
    $: (id) => (hosts[id] = hosts[id] || mkEl("div")),
    document: { createElement: mkEl },
    getActiveChat: () => activeChat,
    getStreaming: () => false,
    // Сегменты ответа вынесены в src/renderer/chat-segments.js (этап 3.7, часть 2):
    // в игрушечной среде плана их нет вовсе, поэтому отдаём тот же контракт заглушкой.
    getChatSegments: () => ({
      ensureSegmentForText: (chat, aMsg) => aMsg || null,
      removeSegment: () => {},
      runSegments: (chat, aMsg) => [aMsg].filter(Boolean),
    }),
    sendMessage: () => {},
    autoResize: () => {},
    persistChatsSoon: () => {},
    toast: () => {},
    AgentCore,
    planArchiveLimit: limitFromShell,
  };
  const mod = planFactory(deps);

  await test("план: модуль на месте, оболочка только собирает его", () => {
    const iTag = htmlSrc.indexOf('src="plan-panel.js"');
    assert.ok(iTag > 0, "разметка не грузит plan-panel.js");
    assert.ok(iTag < htmlSrc.indexOf('src="app.js"'), "plan-panel.js подключён после app.js");
    assert.ok(/<div id="plan-panel"/.test(htmlSrc), "панель плана пропала из разметки");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"plan-panel\.js"/.test(bridge), "мост не отдаёт plan-panel.js телефону");
    // В app.js реализации плана больше нет — только проводка.
    for (const gone of ["function renderPlanPanel", "function planFromText", "function planRotate",
      "function tryPlanFromRunText", "const PLAN_ICON", "let planCollapsed"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код плана остался в app.js: " + gone);
    }
    assert.ok(appSrc.indexOf("window.PlanPanel({") !== -1, "оболочка не собирает модуль плана");
    // Проводка отдаёт переписываемое состояние живыми функциями.
    const wiring = uiFind("  const PlanPanel = window.PlanPanel({", "  // ─────────── /План работ").code;
    for (const dep of ["$: $", "document: document", "getActiveChat: getActiveChat",
      "getStreaming: () => streaming", "getChatSegments: () => ChatSegments", "sendMessage: ChatSend.sendMessage",
      "autoResize: autoResize", "persistChatsSoon: ChatStore.persistChatsSoon", "toast: toast", "AgentCore: AgentCore",
      "planArchiveLimit: PLAN_ARCHIVE_LIMIT"]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
    // Модуль читает состояние окна только живым доступом.
    for (const name of ["settings", "chatsData", "session", "streaming", "chatsSavePending",
      "remoteRunNotified", "SidePanel", "SettingsPanel", "ProjectPanel", "ChatSegments"]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(planSrc),
        "модуль читает " + name + " напрямую вместо живого доступа");
    }
    assert.ok(/\$\("plan-panel"\)/.test(planSrc), "модуль не ищет #plan-panel");
  });

  await test("план: инструмент todoWrite есть в ядре, с алиасами и правилом промпта", () => {
    const def = AgentCore.TOOL_DEFINITIONS.find((t) => t.function && t.function.name === "todoWrite");
    assert.ok(def, "нет определения инструмента todoWrite");
    assert.ok(def.function.description.indexOf("ПОЛНЫЙ список") !== -1, "модель не просят присылать полный список");
    assert.strictEqual(def.function.parameters.properties.tasks.type, "array", "нет схемы tasks");
    assert.ok(def.function.parameters.properties.tasks.items, "нет описания элемента tasks");
    // Алиасы: модель называет инструмент по-разному — имя должно нормализоваться.
    for (const a of ["todo_write", "todos", "todo", "plan", "write_plan", "update_plan"]) {
      assert.strictEqual(AgentCore.normalizeToolName(a), "todoWrite", "алиас " + a + " не ведёт к todoWrite");
    }
    // При тесном контексте шлём только ядро — план обязан там быть.
    assert.ok(AgentCore.selectTools(8000).some((t) => t.function.name === "todoWrite"), "todoWrite отсутствует в ядре инструментов");
    // Правило промпта и список доступных инструментов.
    assert.ok(/^32\. План работ \(todoWrite\)/m.test(AgentCore.SYSTEM_PROMPT), "нет правила 32 про план");
    assert.ok(/САМЫМ ПЕРВЫМ вызывай todoWrite/.test(AgentCore.SYSTEM_PROMPT), "правило 32 не требует план до первого инструмента");
    assert.ok(/План НЕ нужен только для одного короткого действия/.test(AgentCore.SYSTEM_PROMPT), "правило 32 не оговаривает исключение для одношаговых задач");
    assert.ok(/todoWrite, checkpointSave/.test(AgentCore.SYSTEM_PROMPT), "todoWrite нет в списке доступных инструментов");
  });

  await test("план: нормализация пунктов (строки, чекбоксы, статусы на русском, лимит)", () => {
    const items = AgentCore.normalizePlanTasks(["- [x] Первый", "1. Второй", { text: "Третий", status: "in progress" }, "   "]);
    assert.strictEqual(items.length, 3, "пункты потерялись: " + JSON.stringify(items));
    assert.strictEqual(items[0].status, "done", "«- [x]» не распознан как готовый пункт");
    assert.strictEqual(items[0].text, "Первый", "маркер списка остался в тексте: " + items[0].text);
    assert.strictEqual(items[2].status, "in_progress", "«in progress» не распознан");
    // Русские и эмодзи-статусы + «ровно один в работе».
    const ru = AgentCore.normalizePlanTasks("✅ Раз\n🔄 Два\n⚠️ Три\n⬜ Четыре\n🔄 Пятый");
    assert.deepStrictEqual(ru.map((i) => i.status), ["done", "in_progress", "failed", "pending", "pending"], "статусы разобраны неверно: " + JSON.stringify(ru.map((i) => i.status)));
    // Мусор и лимит — без исключений.
    assert.deepStrictEqual(AgentCore.normalizePlanTasks(null), []);
    assert.deepStrictEqual(AgentCore.normalizePlanTasks({ tasks: [] }), []);
    assert.deepStrictEqual(AgentCore.normalizePlanTasks([{}, "  "]), []);
    assert.strictEqual(AgentCore.normalizePlanTasks(Array.from({ length: 12 }, (_, i) => "шаг " + i)).length, AgentCore.PLAN_MAX_ITEMS, "лимит пунктов не соблюдён");
    // Дубликаты не должны раздувать список (модели это любят).
    assert.strictEqual(AgentCore.normalizePlanTasks(["a", "a", "A"]).length, 1, "дубликаты не схлопнуты");
  });

  await test("план модели: принимается и заменяется через историю (авто-шагов больше нет)", () => {
    const chat = { id: "c1", messages: [] };
    assert.strictEqual(mod.planFromModel(chat, { tasks: [{ text: "Разобрать", status: "done" }, { text: "Починить", status: "in_progress" }], title: "Задача" }), true);
    assert.strictEqual(chat.plan.source, "model");
    assert.strictEqual(chat.plan.title, "Задача");
    assert.strictEqual(chat.plan.items.length, 2);
    // Мусорный «план» от слабой модели не должен появляться вовсе.
    const junk = { id: "c-junk", messages: [] };
    assert.strictEqual(mod.planFromModel(junk, { tasks: [] }), false);
    assert.strictEqual(junk.plan, undefined);
    // Вызовы инструментов панель больше не наполняют: её питает только todoWrite.
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, true), false, "успех инструмента тронул план модели");
    assert.strictEqual(chat.plan.source, "model");
    assert.strictEqual(chat.plan.items.length, 2, "план модели изменился от вызова инструмента");
    // И чат без плана от работы инструментов плана не получает.
    const bare = { id: "c-bare", messages: [] };
    assert.strictEqual(mod.planToolOutcome(bare, { name: "runCommand" }, false), false);
    assert.strictEqual(bare.plan, undefined, "инструмент создал план без todoWrite");
    // Новый план модели вытесняет прежний — но не теряет его.
    assert.strictEqual(mod.planFromModel(chat, { tasks: ["Только один"] }), true);
    assert.strictEqual(chat.plan.items.length, 1);
    assert.strictEqual(chat.planHistory.length, 1, "прежний план не ушёл в историю");
    assert.strictEqual(chat.planHistory[0].items.length, 2);
    // История не растёт бесконечно.
    for (let i = 0; i < 10; i++) mod.planFromModel(chat, { tasks: ["шаг " + i] });
    assert.strictEqual(chat.planHistory.length, limitFromShell, "история планов не ограничена");
  });

  await test("план модели: упавший шаг помечается ⚠️, успешный статус модели не трогает", () => {
    const chat = { id: "c", messages: [], plan: { source: "model", items: [{ id: "t1", text: "Починить", status: "in_progress", note: "" }] } };
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, false), true, "падение шага не отмечено");
    assert.strictEqual(chat.plan.items[0].status, "failed");
    assert.ok(/не удал/i.test(chat.plan.items[0].note), "нет пояснения к провалу");
    chat.plan.items[0].status = "in_progress";
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, true), false, "успех инструмента правит план модели");
    assert.strictEqual(chat.plan.items[0].status, "in_progress", "статус модели переписан");
  });

  await test("панель плана не наполняется из вызовов инструментов (авто-шагов больше нет)", () => {
    const chat = { id: "c2", messages: [] };
    assert.strictEqual(mod.planToolOutcome(chat, { name: "readFile" }, true), false, "результат инструмента создал план");
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, false), false);
    assert.strictEqual(chat.plan, undefined, "план появился без todoWrite");
    // Прогресс по-прежнему считает и готовое, и провалы — но уже по плану модели.
    const items = [
      { id: "1", text: "Чтение файла", status: "done" },
      { id: "2", text: "Команда в терминале", status: "done" },
      { id: "3", text: "Изменение файла", status: "failed", note: "инструмент вернул ошибку" },
    ];
    const pr = mod.planProgress(items);
    assert.strictEqual(pr.total, 3);
    assert.strictEqual(pr.done, 2);
    assert.strictEqual(pr.failed, 1);
    assert.strictEqual(pr.percent, 100);
    assert.strictEqual(pr.finished, true);
    // Следов авто-режима в интерфейсе не осталось.
    // Следов авто-режима не осталось НИ в оболочке, НИ в модуле плана.
    const uiPlan = appSrc + planSrc;
    assert.ok(!/planAuto/.test(uiPlan), "остались авто-шаги");
    assert.ok(uiPlan.indexOf("план не задан") === -1, "осталась подпись «план не задан»");
    assert.ok(uiPlan.indexOf("PLAN_AUTO_MAX") === -1, "остался лимит авто-шагов");
    assert.ok(uiPlan.indexOf("plan-hint") === -1, "остался стиль подписи про не заданный план");
    assert.ok(cssSrc.indexOf(".plan-hint") === -1, "мёртвый стиль .plan-hint остался в styles.css");
  });

  await test("поворот плана: завершённый уходит в историю, незавершённый остаётся", () => {
    const model = { messages: [] };
    mod.planFromModel(model, { tasks: [{ text: "A", status: "done" }, { text: "B", status: "pending" }] });
    assert.strictEqual(mod.planRotate(model), false, "незавершённый план сброшен");
    assert.ok(model.plan, "незавершённый план потерян — агент не увидит, что осталось");
    // А завершённый — уходит в историю и уступает место новой задаче.
    model.plan.items[1].status = "done";
    assert.strictEqual(mod.planRotate(model), true);
    assert.strictEqual(model.plan, null);
    assert.strictEqual(model.planHistory.length, 1);
  });

  await test("панель: рисует пункты, счётчик и прогресс; пустой план её скрывает", () => {
    assert.strictEqual(mod.renderPlanPanel(), undefined, "панель без плана не должна падать");
    assert.ok(hosts["plan-panel"].classList.contains("hidden"), "панель без плана не скрыта");
    activeChat = { id: "c3", messages: [], plan: { title: "Починка ycLogs", source: "model", items: [
      { id: "t1", text: "Разобрать логи", status: "done", note: "" },
      { id: "t2", text: "Починить хост", status: "in_progress", note: "" },
      { id: "t3", text: "Прогнать тесты", status: "pending", note: "" },
    ] } };
    mod.renderPlanPanel();
    const host = hosts["plan-panel"];
    assert.ok(!host.classList.contains("hidden"), "панель с планом скрыта");
    const txt = nodeText(host);
    for (const want of ["Починка ycLogs", "Разобрать логи", "Починить хост", "Прогнать тесты", "1/3"]) {
      assert.ok(txt.indexOf(want) !== -1, "в панели нет «" + want + "»");
    }
    // Полоска прогресса: 1 готов из 3 → 33%.
    const fill = host.children[0].children[1].children[0];
    assert.strictEqual(fill.style.width, "33%", "неверная ширина прогресса: " + fill.style.width);
    // Панель раскрыта по умолчанию (пользователь видит шаги сразу).
    assert.ok(host.children[0].classList.contains("expanded"), "панель плана свёрнута по умолчанию");
    // Клик по заголовку сворачивает.
    host.children[0].children[0].onclick({ stopPropagation() {} });
    assert.ok(!hosts["plan-panel"].children[0].classList.contains("expanded"), "клик не свернул панель");
    // Старый авто-план из chats.json (source «auto») панелью не показывается вовсе:
    // панель существует только для плана модели, иначе дублировала бы панель действий.
    activeChat = { id: "c4", messages: [], plan: { source: "auto", items: [{ id: "a1", text: "Команда в терминале", status: "in_progress", note: "" }] } };
    mod.renderPlanPanel();
    assert.ok(hosts["plan-panel"].classList.contains("hidden"), "авто-план всё ещё рисуется панелью");
    assert.strictEqual(hosts["plan-panel"].children.length, 0, "в панели остались строки авто-плана");
  });

  await test("панель: «▶ Выполнить» только для плана из режима плана, «✕» уводит план в историю", () => {
    activeChat = { id: "c5", messages: [{ id: "m1", role: "assistant", content: "план", plan: true }], plan: { source: "model", title: "T", items: [{ id: "t1", text: "A", status: "pending", note: "" }] } };
    mod.renderPlanPanel();
    let head = hosts["plan-panel"].children[0].children[0];
    assert.ok(nodeText(head).indexOf("▶ Выполнить") !== -1, "нет кнопки выполнения плана");
    // План уже выполняется (ответ не помечен режимом плана) — кнопки быть не должно.
    activeChat = { id: "c6", messages: [{ id: "m1", role: "assistant", content: "ок" }], plan: { source: "model", title: "T", items: [{ id: "t1", text: "A", status: "done", note: "" }] } };
    mod.renderPlanPanel();
    head = hosts["plan-panel"].children[0].children[0];
    assert.strictEqual(nodeText(head).indexOf("▶ Выполнить"), -1, "кнопка выполнения висит на обычном ответе");
    // «✕»: план уходит в историю и с экрана.
    const clear = head.children.find((c) => c.className === "plan-clear");
    assert.ok(clear, "нет кнопки очистки плана");
    clear.onclick({ stopPropagation() {} });
    assert.strictEqual(activeChat.plan, null, "план не убран по «✕»");
    assert.strictEqual(activeChat.planHistory.length, 1, "убранный план не сохранён в историю");
    assert.ok(hosts["plan-panel"].classList.contains("hidden"), "панель осталась после очистки");
  });

  await test("план: инструмент связан с интерфейсом (main → событие plan → панель)", () => {
    assert.ok(hasTool(mainSrc, "todoWrite"), "нет обработчика todoWrite");
    assert.ok(/activeEmit\(\{ type: "plan", tasks: planTasks, title: planTitle \}\)/.test(mainSrc), "main.js не отправляет событие plan");
    assert.ok(/normalizePlanTasks\(/.test(mainSrc) && /planSummary\(/.test(mainSrc), "main.js не нормализует план");
    assert.ok(/normalizePlanTasks,\n  planSummary,/.test(mainSrc), "нормализатор не импортирован в main.js");
    assert.ok(/case "plan": \{/.test(uiFile("chat-events.js")), "интерфейс не обрабатывает событие plan");
    assert.ok(/planFromModel\(chat, ev\)/.test(uiFile("chat-events.js")), "событие plan не доходит до состояния");
    assert.ok(/if \(planToolOutcome\(chat, ev, toolOk\)\) renderPlanPanel\(\);/.test(uiFile("chat-events.js")), "tool_result не проверяет фактический провал шага модели");
    assert.ok(/source: "auto"/.test(appSrc) === false, "в app.js осталось создание авто-плана из вызовов инструментов");
    assert.ok(/if \(getPlanPanel\(\)\.planRotate\(getActiveChat\(\)\)\) getPlanPanel\(\)\.renderPlanPanel\(\);/.test(uiFile("chat-send.js")), "новый запрос не поворачивает план");
    assert.ok(/renderPlanPanel\(\);\n    const chat = getActiveChat\(\);|renderPlanPanel\(\);/.test(appSrc), "панель не перерисовывается вместе с чатом");
    // Веб-режим: todoWrite работает как структура, а не «недоступно в веб-версии».
    // Веб-режим вынесен в свой модуль (src/renderer/web-chat.js): спрашиваем
    // «этот код есть в интерфейсе», а не «он лежит именно в app.js».
    const webUi = uiAll();
    const webIdx = webUi.indexOf('c.name === "todoWrite"');
    const webElse = webUi.indexOf('"⚠️ Файловые операции и git недоступны в веб-версии');
    assert.ok(webIdx > 0 && webIdx < webElse, "в веб-режиме todoWrite падает в общий отказ");
  });

  await test("план: контейнер, оформление и хранение на месте", () => {
    assert.ok(/<div id="plan-panel" class="hidden"><\/div>/.test(htmlSrc), "нет контейнера #plan-panel в index.html");
    assert.ok(/\$\("plan-panel"\)/.test(planSrc), "модуль плана не ищет #plan-panel");
    // Панель стоит ВЫШЕ панели действий (иначе ход работ заслонял бы план).
    assert.ok(htmlSrc.indexOf('id="plan-panel"') < htmlSrc.indexOf('id="work-panel"'), "панель плана не над панелью действий");
    for (const rule of [".plan-group", ".plan-head", ".plan-item.st-done", ".plan-fill", ".plan-group.expanded .plan-body", "#plan-panel.hidden"]) {
      assert.ok(cssSrc.indexOf(rule) !== -1, "нет стиля " + rule);
    }
    // План сохраняется вместе с чатом и чистится при загрузке.
    assert.ok(/if \(c\.plan !== undefined\)/.test(uiAll()), "sanitizeChats не проверяет план");
    assert.ok(/Array\.isArray\(c\.plan\.items\)/.test(uiAll()), "sanitizeChats не отвергает повреждённый план");
    assert.ok(/c\.planHistory = c\.planHistory\.slice\(0, (PLAN_ARCHIVE_LIMIT|getPlanArchiveLimit\(\))\)/.test(uiAll()), "история планов не ограничивается при загрузке");
  });

  await test("план: написанный текстом («План: 1. …») становится панелью-чеклистом", () => {
    const text = [
      "Пользователь просит создать API-ключ для модели, которая видит картинки.",
      "",
      "План:",
      "1. Проверить, что диалог закрылся",
      "2. Создать проект (No project selected)",
      "3. Включить API Gemini",
      "4. Создать API-ключ в APIs & Services",
      "",
      "Важный момент: ключ — секрет.",
    ].join("\n");
    const chat = { messages: [] };
    assert.strictEqual(mod.planFromText(chat, text), true, "текстовый план не разобран");
    assert.strictEqual(chat.plan.source, "text");
    assert.strictEqual(chat.plan.title, "План");
    assert.strictEqual(chat.plan.items.length, 4, "пункты плана потерялись: " + JSON.stringify(chat.plan.items));
    assert.strictEqual(chat.plan.items[0].text, "Проверить, что диалог закрылся", "маркер «1.» остался в тексте: " + chat.plan.items[0].text);
    assert.strictEqual(chat.plan.items[1].status, "pending", "новый план сразу помечен выполненным");
    // Повторный разбор того же текста ничего не сбрасывает.
    assert.strictEqual(mod.planFromText(chat, text), false, "тот же план пересоздан");
    // Панель показывает его тем же чеклистом, что и план модели.
    activeChat = chat;
    mod.renderPlanPanel();
    const txt = nodeText(hosts["plan-panel"]);
    assert.ok(!hosts["plan-panel"].classList.contains("hidden"), "панель с текстовым планом скрыта");
    assert.ok(txt.indexOf("Создать проект") !== -1, "пункт плана не попал в панель: " + txt);
    assert.ok(txt.indexOf("0/4") !== -1, "нет счётчика готовых пунктов: " + txt);
  });

  await test("план: галочки текстового плана двигает работа (раунд → пункт)", () => {
    const chat = { messages: [], plan: { source: "text", title: "План", items: [
      { text: "A", status: "pending" }, { text: "B", status: "pending" },
    ] } };
    assert.strictEqual(mod.planTextAdvance(chat, true), true, "первый пункт не встал в работу");
    assert.strictEqual(chat.plan.items[0].status, "in_progress");
    assert.strictEqual(mod.planTextAdvance(chat, true), true);
    assert.strictEqual(chat.plan.items[0].status, "done", "раунд не закрыл пункт");
    assert.strictEqual(chat.plan.items[1].status, "in_progress", "следующий пункт не встал в работу");
    assert.strictEqual(mod.planTextAdvance(chat, true), true);
    assert.strictEqual(chat.plan.items[1].status, "done");
    assert.strictEqual(mod.planTextAdvance(chat, true), false, "пункты кончились, а функция двигает галочки");
    // Провал шага отмечает planToolOutcome — текстовый план здесь не исключение.
    const failing = { messages: [], plan: { source: "text", items: [{ text: "A", status: "in_progress" }] } };
    assert.strictEqual(mod.planToolOutcome(failing, { name: "runCommand" }, false), true, "провал текстового плана не отмечен");
    assert.strictEqual(failing.plan.items[0].status, "failed");
    assert.strictEqual(mod.planTextAdvance(failing, false), false, "провал сдвинул галочки вперёд");
    // Финиш запуска закрывает незакрытый пункт.
    const finish = { messages: [], plan: { source: "text", items: [{ text: "A", status: "done" }, { text: "B", status: "in_progress" }] } };
    assert.strictEqual(mod.planTextFinish(finish), true, "финиш не закрыл текущий пункт");
    assert.strictEqual(finish.plan.items[1].status, "done");
    assert.strictEqual(mod.planTextFinish(finish), false);
    // План модели текстовый прогресс не трогает — там статусы ведёт сама модель.
    const model = { messages: [], plan: { source: "model", items: [{ text: "A", status: "pending" }] } };
    assert.strictEqual(mod.planTextAdvance(model, true), false, "текстовый прогресс двигает план модели");
    assert.strictEqual(mod.planTextFinish(model), false);
  });

  await test("план: раунд работы закрывает ровно один пункт (и только у текстового плана)", () => {
    const chat = { messages: [], plan: { source: "text", items: [
      { text: "A", status: "pending" }, { text: "B", status: "pending" }, { text: "C", status: "pending" },
    ] } };
    assert.strictEqual(mod.planRoundStarted(chat, "s1"), true, "раунд s1 не двинул план");
    assert.strictEqual(chat.plan.items[0].status, "in_progress");
    // Тот же сегмент дважды (размышления + текст одного раунда) — второй раз не двигаем.
    assert.strictEqual(mod.planRoundStarted(chat, "s1"), false, "один сегмент посчитан за два раунда");
    assert.strictEqual(chat.plan.items.length, 3);
    assert.strictEqual(mod.planRoundStarted(chat, "s2"), true);
    assert.strictEqual(chat.plan.items[0].status, "done");
    assert.strictEqual(chat.plan.items[1].status, "in_progress");
    // Без сегмента (защита от пустого id) и без плана — тихо ничего не делаем.
    assert.strictEqual(mod.planRoundStarted(chat, ""), false);
    assert.strictEqual(mod.planRoundStarted({ messages: [] }, "s3"), false);
    const model = { messages: [], plan: { source: "model", items: [{ text: "A", status: "pending" }] } };
    assert.strictEqual(mod.planRoundStarted(model, "s4"), false, "раунд двигает план модели");
    assert.strictEqual(model.plan.items[0].status, "pending");
  });

  await test("план: обычный ответ панелью не становится", () => {
    for (const t of [
      "Готово! Сделал три вещи:\n1. Прочитал файл\n2. Поправил баг\n3. Прогнал тесты",
      "План такой: нужно сначала починить сборку, потом проверить.",
      "✅ Готово. Всё работает, ошибок нет.",
      "Разбор:\n- первое\n- второе",
    ]) {
      assert.deepStrictEqual(mod.planLinesFromText(t), [], "обычный текст принят за план: " + t.slice(0, 40));
    }
    const chat = { messages: [] };
    assert.strictEqual(mod.planFromText(chat, "Готово!\n1. Первое\n2. Второе"), false, "перечисление в ответе стало планом");
    assert.strictEqual(chat.plan, undefined, "из обычного ответа появился план");
    assert.strictEqual(mod.planFromText(chat, "План:\n1. Один шаг"), false, "план из одного пункта показан панелью");
    // А блок чекбоксов без заголовка — это план (его и ждёт пользователь).
    const ticks = { messages: [] };
    assert.strictEqual(mod.planFromText(ticks, "✅ Разобрал логи\n⬜ Починил хост\n⬜ Прогнал тесты"), true, "блок чекбоксов не признан планом");
    assert.strictEqual(ticks.plan.items.length, 3);
    assert.strictEqual(ticks.plan.items[0].status, "done", "✅ не стал готовым пунктом");
    assert.strictEqual(ticks.plan.items[1].status, "pending");
  });

  await test("план текстом: пустые строки, жирный заголовок, «Шаг N» и список без заголовка", () => {
    // Модели печатают markdown: пункты через пустую строку, заголовок — жирным в конце фразы.
    assert.strictEqual(
      mod.planLinesFromText("План работ:\n1. Прочитать package.json\n\n2. Поднять сервер\n\n3. Проверить порт").length,
      3,
      "пункты через пустую строку потеряны"
    );
    assert.strictEqual(
      mod.planLinesFromText("Сначала план. **Сейчас нужно:**\n1. Найти конфиг\n2. Поправить порт").length,
      2,
      "жирный заголовок в конце фразы не распознан"
    );
    assert.strictEqual(
      mod.planLinesFromText("План:\nШаг 1: Прочитать файл\nШаг 2: Запустить сервер").length,
      2,
      "пункты «Шаг N:» не распознаны"
    );
    // Регистр не должен решать: модели пишут «Шаг», «Этап», «Step» с большой буквы.
    assert.strictEqual(
      mod.planLinesFromText("План:\nЭтап 1. Разобрать\nЭтап 2. Собрать").length,
      2,
      "пункты «Этап N.» не распознаны"
    );
    assert.strictEqual(
      mod.planLinesFromText("План:\nА) Прочитать файл\nБ) Запустить сервер").length,
      2,
      "буквенные пункты «А)» не распознаны"
    );
    assert.strictEqual(
      mod.planLinesFromText("Задача разбивается на этапы.\n1. Первое\n2. Второе\n3. Третье").length,
      3,
      "список с планирующим словом не признан планом"
    );
    // Обычный отчёт со списком планом по-прежнему не становится.
    assert.deepStrictEqual(mod.planLinesFromText("Что сделано:\n1. Первое\n2. Второе\n3. Третье"), [], "отчёт со списком стал планом");
    assert.deepStrictEqual(mod.planLinesFromText("Вот результаты:\n1. Одно\n2. Два\n3. Три"), [], "перечисление результатов стало планом");
    // Один пункт планом не считается.
    assert.deepStrictEqual(mod.planLinesFromText("План:\n1. Единственный"), [], "один пункт признан планом");
  });

  await test("план: о появлении панели сообщают тостом (один раз на план)", () => {
    const planFn = uiFind("function tryPlanFromRunText");
    assert.ok(planFn.start > 0, "нет tryPlanFromRunText");
    const fn = planFn.code.slice(0, 1200);
    assert.ok(fn.indexOf("if (!hadPlan) toast(") !== -1, "о появлении плана не сообщается");
    assert.ok(fn.indexOf("const hadPlan = !!(chat && chat.plan);") !== -1, "нет защиты от повторных тостов");
    assert.ok(fn.indexOf("planFromText(chat, runTextOf(chat, aMsg))") !== -1, "разбор плана из текста запуска пропал");
  });

  await test("план: настоящий план модели (todoWrite) важнее текстового", () => {
    const chat = { messages: [] };
    mod.planFromText(chat, "План:\n1. Первый шаг\n2. Второй шаг");
    assert.strictEqual(chat.plan.source, "text");
    assert.strictEqual(mod.planFromModel(chat, { tasks: [{ text: "Сделать раз", status: "in_progress" }], title: "Задача" }), true);
    assert.strictEqual(chat.plan.source, "model");
    assert.strictEqual(chat.planHistory.length, 1, "текстовый план не сохранён в историю");
    assert.strictEqual(mod.planFromText(chat, "План:\n1. Другой\n2. Совсем другой"), false, "текст подменил план модели");
  });

  await test("план: текст ответа связан с панелью (chunk → раунд, tool_start, done)", () => {
    assert.ok(/if \(planFromText\(chat, runTextOf\(chat, aMsg\)\)\)/.test(planSrc), "интерфейс не разбирает план, написанный текстом");    // Строка «planRoundStarted(chat, seg.id)» живёт в src/renderer/chat-segments.js
        // (этап 3.7): спрашиваем интерфейс целиком, а не адрес кода.
        assert.ok(/planRoundStarted\(chat, seg\.id\);/.test(uiAll()), "новый раунд ответа не двигает галочки текстового плана");
    assert.ok(/if \(planTextFinish\(chat\)\)/.test(uiFile("chat-events.js")), "финиш запуска не закрывает шаг текстового плана");
    // Веб-версия: в План-режиме список инструментов больше не пуст — todoWrite доходит до
    // модели. Набор схем теперь отбирает роутер (как в приложении), а в плане он не
    // работает: туда идёт готовый набор PLAN_MODE_TOOL_DEFINITIONS.
    assert.ok(
      /let webTools = planMode \? AgentCore\.PLAN_MODE_TOOL_DEFINITIONS : AgentCore\.TOOL_DEFINITIONS;/.test(uiAll()),
      "в веб-версии План-режим без todoWrite"
    );
    assert.ok(/tools: webTools,/.test(uiAll()), "в запросе веб-версии уходит не тот набор схем");
    // Роутер схем: без него уходили все 167 схем (≈33 000 токенов) — на окне 32k они
    // одни занимали окно целиком.
    assert.ok(/roleGroups: AgentCore\.rolePlan\(opts\.role \|\| "dev"\)\.groups,/.test(uiAll()), "роутер схем в веб-версии не спрашивает роль чата");
    assert.ok(/maxTokens: AgentCore\.routerMaxTokens\(budget, systemWeight, baseWeight\),/.test(uiAll()), "набор схем в веб-версии не ограничен окном");
  });

  await test("план: план из размышлений — «План уже составлен. Сейчас нужно:»", () => {
    // Ровно тот случай, из-за которого панель оставалась пустой: модель рассуждает и
    // перечисляет шаги в РАЗМЫШЛЕНИЯХ, а в ответе плана нет вовсе.
    const chat = { messages: [] };
    const thinks = [
      "Продолжаю. Нужно запустить проект. По анализу: это Express + React + Vite + Drizzle ORM,",
      "PostgreSQL, но в облаке — Cloud Function + YDB. Локально сервер требует DATABASE_URL.",
      "",
      "План уже составлен. Сейчас нужно:",
      "1. Проверить .env, package.json, как сервер стартует",
      "2. Решить вопрос с БД — сервер рассчитан на PostgreSQL + Drizzle",
      "",
      "Но подождите — может, локальный сервер тоже может работать с YDB?",
    ].join("\n");
    assert.strictEqual(mod.planFromText(chat, thinks), true, "план из размышлений не разобран");
    assert.strictEqual(chat.plan.source, "text");
    assert.strictEqual(chat.plan.items.length, 2, "пункты потерялись: " + JSON.stringify(chat.plan.items));
    assert.ok(chat.plan.items[0].text.indexOf("Проверить .env") !== -1, "первый пункт неверный: " + chat.plan.items[0].text);
    assert.ok(chat.plan.items[1].text.indexOf("вопрос с БД") !== -1, "второй пункт неверный: " + chat.plan.items[1].text);
    assert.ok(JSON.stringify(chat.plan.items).indexOf("подождите") === -1, "проза после плана попала в пункты");
    // Размышления — часть текста запуска, а не отдельный канал: иначе разбор их не увидит.
    const seg = { id: "s1", role: "assistant", content: "Смотрю файлы.", thinking: "Сначала план." };
    const one = { messages: [seg] };
    assert.ok(mod.runTextOf(one, seg).indexOf("Сначала план.") !== -1, "размышления не попали в текст запуска");
    assert.ok(mod.runTextOf(one, seg).indexOf("Смотрю файлы.") !== -1, "ответ не попал в текст запуска");
    // Гейт по строкам: на однострочном куске стрима разбор не запускается вовсе.
    const short = { messages: [{ id: "s2", role: "assistant", content: "думаю" }] };
    assert.strictEqual(mod.tryPlanFromRunText(short, short.messages[0]), false, "разбор пошёл по однострочному куску");
  });

  await test("план: дописывание пунктов на ходу не засоряет историю и не сбрасывает галочки", () => {
    const chat = { messages: [] };
    assert.strictEqual(mod.planFromText(chat, "План:\n1. Собрать данные\n2. Починить"), true);
    assert.strictEqual(mod.planTextAdvance(chat, true), true);
    assert.strictEqual(mod.planTextAdvance(chat, true), true);
    assert.strictEqual(chat.plan.items[0].status, "done");
    assert.strictEqual(chat.plan.items[1].status, "in_progress");
    assert.ok(!chat.planHistory || !chat.planHistory.length, "план ушёл в историю на первом же куске стрима");
    // Стрим напечатал третий пункт — это тот же план.
    assert.strictEqual(mod.planFromText(chat, "План:\n1. Собрать данные\n2. Починить\n3. Проверить"), true, "дописанный пункт не подхвачен");
    assert.strictEqual(chat.plan.items.length, 3, "пункт не добавился");
    assert.strictEqual(chat.plan.items[0].status, "done", "галочка готового пункта сброшена");
    assert.strictEqual(chat.plan.items[1].status, "in_progress", "статус текущего пункта сброшен");
    assert.ok(!chat.planHistory || !chat.planHistory.length, "тот же план ушёл в историю");
    // А вот ДРУГОЙ план — это новый план, предыдущий уходит в историю.
    assert.strictEqual(mod.planFromText(chat, "План:\n1. Совсем другое\n2. И это"), true);
    assert.strictEqual(chat.planHistory.length, 1, "новый план не сохранил предыдущий");
  });

  await test("панель: в свёрнутой шапке видно, какой шаг идёт сейчас", () => {
    activeChat = { id: "c7", messages: [], plan: { title: "", source: "text", items: [
      { id: "t1", text: "Разобрать логи", status: "done", note: "" },
      { id: "t2", text: "Починить хост", status: "in_progress", note: "" },
      { id: "t3", text: "Прогнать тесты", status: "pending", note: "" },
    ] } };
    mod.renderPlanPanel();
    // Панель могла остаться свёрнутой от предыдущих проверок — доводим состояние честно.
    if (hosts["plan-panel"].children[0].classList.contains("expanded")) {
      hosts["plan-panel"].children[0].children[0].onclick({ stopPropagation() {} });
    }
    const head = hosts["plan-panel"].children[0].children[0];
    assert.ok(nodeText(head).indexOf("Починить хост") !== -1, "в свёрнутой шапке не видно текущий шаг: " + nodeText(head));
    assert.ok(nodeText(head).indexOf("1/3") !== -1, "счётчик пропал");
  });

  await test("план: с первым инструментом текущий шаг сразу «в работе»", () => {
    // Иначе до конца первого раунда все пункты висели «ожидает» — и не было видно,
    // какой этап агент выполняет прямо сейчас.
    assert.ok(/chat\.plan\.source === "text"/.test(uiFile("chat-events.js")), "нет отметки шага на старте работы");
    assert.ok(/!chat\.plan\.items\.some\(\(i\) => i\.status === "in_progress"\)/.test(uiFile("chat-events.js")), "отметка не проверяет, есть ли уже текущий шаг");
    assert.ok(/if \(planTextAdvance\(chat, true\)\) renderPlanPanel\(\);/.test(uiFile("chat-events.js")), "шаг не перерисовывается на старте работы");
    // И это не мешает основному движению по раундам.
    const chat = { messages: [], plan: { source: "text", items: [
      { text: "A", status: "pending" }, { text: "B", status: "pending" },
    ] } };
    assert.strictEqual(mod.planTextAdvance(chat, true), true);
    assert.strictEqual(chat.plan.items[0].status, "in_progress");
    assert.strictEqual(chat.plan.items[1].status, "pending");
  });
  await test("план: разбор идёт по стриму (ответ и размышления), заголовок ловится в конце фразы", () => {
    assert.ok(/case "thinking":[\s\S]{0,700}tryPlanFromRunText\(chat, aMsg\)/.test(uiFile("chat-events.js")), "размышления не участвуют в разборе плана");
    assert.ok(/case "chunk":[\s\S]{0,400}tryPlanFromRunText\(chat, aMsg\)/.test(uiFile("chat-events.js")), "текст ответа не участвует в разборе плана");
    assert.ok(/PLAN_TAIL_RE/.test(planSrc), "нет распознавания заголовка в конце фразы");
    assert.ok(/\.plan-active \{/.test(cssSrc), "нет стиля .plan-active");
  });

  await test("План-режим: модель получает ровно todoWrite, остальные вызовы не выполняются", () => {
    // Раньше в этом режиме список инструментов был пуст — прислать план структурой
    // модель физически не могла, и панель оставалась пустой до кнопки «▶ Выполнить».
    assert.strictEqual(AgentCore.PLAN_MODE_TOOL_DEFINITIONS.length, 1, "в План-режиме не ровно один инструмент");
    assert.strictEqual(AgentCore.PLAN_MODE_TOOL_DEFINITIONS[0].function.name, "todoWrite", "в План-режиме нет todoWrite");
    // Набор схем теперь собирает роутер: в План-режиме — ровно PLAN_MODE_TOOL_DEFINITIONS,
    // в обычном — routeTools (база + липкие группы).
    assert.ok(/state\.active = PLAN_MODE_TOOL_DEFINITIONS;/.test(mainSrc), "План-режим не получает набор с todoWrite");
    assert.ok(/state\.route = routeTools\(\{ text: routerTask, sticky: \[\.\.\.state\.sticky\]/.test(mainSrc), "выбор схем не идёт через роутер");
    assert.ok(/const forceAllTools = !!settings\.sendAllTools;/.test(mainSrc), "нет предохранителя C (все инструменты)");
    assert.ok(/tools: tools\.state\.active,/.test(mainSrc), "в запрос уходит не activeTools");
    assert.ok(mainSrc.indexOf("tools: planMode ? [] : activeTools") === -1, "осталось старое обнуление инструментов");
    // Исполнение: в этом режиме выполняется только todoWrite, остальное — честный отказ.
    assert.ok(/if \(planMode && c\.name !== "todoWrite"\)/.test(mainSrc), "нет запрета выполнять инструменты в План-режиме");
    // Отказ возвращается модели из модуля строгой очереди (src/run-strict.js,
    // часть 19а) — там история приходит аргументом, поэтому `history.push`.
    assert.ok(/history\.push\(\{ role: "tool", tool_call_id: c\.id, content: blocked \}\)/.test(mainSrc), "отказ не возвращается модели");
    assert.ok(/доступен только todoWrite/.test(mainSrc), "режимный текст промпта не обновлён");
    assert.ok(/единственный доступный там инструмент/.test(AgentCore.SYSTEM_PROMPT), "правило 32 не знает про набор План-режима");
  });

  await test("план: битый план в chats.json не мешает запуску (sanitizeChats)", () => {
    // sanitizeChats извлекается ровно как в соседнем тесте и исполняется отдельно,
    // поэтому нормализатор и лимит передаём параметрами.
  const sanitizeSliceB = uiFind("  function sanitizeChats(d) {");
  assert.ok(sanitizeSliceB.start > 0, "не нашёл sanitizeChats в интерфейсе");
    const rawLines = sanitizeSliceB.code.split("\n");
    let endLine = -1;
    for (let i = 1; i < rawLines.length; i++) {
      if (rawLines[i] === "  }") { endLine = i; break; }
    }
    const fn = new Function(
      "AgentCore",
      "getPlanArchiveLimit",
      rawLines.slice(0, endLine + 1).join("\n") + "\nreturn sanitizeChats;"
    )(AgentCore, () => AgentCore.PLAN_MAX_ITEMS);
    const out = fn({
      activeId: "c1",
      chats: [
        { id: "c1", messages: [], plan: { source: "model", title: "T", items: [{ text: "A", status: "done" }, { text: "" }] }, planHistory: [{ items: [1, 2, 3, 4, 5, 6, 7] }, {}, {}, {}, {}, {}, {}] },
        { id: "c2", messages: [], plan: { items: "не массив" } },
        { id: "c3", messages: [] },
        { id: "c4", messages: [], plan: { source: "auto", title: "Ход работы", items: [{ text: "A", status: "done" }] } },
        { id: "c5", messages: [], plan: { source: "text", title: "План", items: [{ text: "A", status: "in_progress" }, { text: "B", status: "pending" }] } },
      ],
    });
    assert.strictEqual(out.chats[0].plan.items.length, 1, "нормализация плана не сработала: " + JSON.stringify(out.chats[0].plan));
    assert.strictEqual(out.chats[0].plan.source, "model");
    assert.strictEqual(out.chats[0].planHistory.length, AgentCore.PLAN_MAX_ITEMS, "история не обрезана");
    assert.strictEqual(out.chats[1].plan, null, "битый план не сброшен");
    assert.strictEqual(out.chats[2].plan, undefined, "чату без плана добавили поле plan");
    assert.strictEqual(out.chats[3].plan, null, "legacy-план «auto» не убран при загрузке");
    assert.strictEqual(out.chats[4].plan.source, "text", "текстовый план выдан за модельный при загрузке");
    assert.strictEqual(out.chats[4].plan.items.length, 2);
  });

  await test("интерфейс: функции ядра вызываются только через AgentCore (иначе ReferenceError в живом окне)", () => {
    // Повод — живой прогон в браузере: normalizePlanTasks вызывался «голым» именем,
    // разбор плана падал с ReferenceError, а тот молча гас в потоке ответа — панель
    // плана не появлялась ни разу. В app.js ядро лежит в const AgentCore, поэтому
    // любое имя из ядра обязано идти с префиксом AgentCore.
    const coreFns = Object.keys(AgentCore).filter((k) => typeof AgentCore[k] === "function");
    const defined = new Set();
    let m;
    const defRe = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/g;
    while ((m = defRe.exec(appSrc))) defined.add(m[1] || m[2]);
    const paramRe = /\(([^()]*)\)\s*(?:=>|\{)/g;
    while ((m = paramRe.exec(appSrc))) {
      for (const p of m[1].split(",")) {
        const n = p.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, "");
        if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
      }
    }
    const bad = [];
    for (const name of coreFns) {
      if (defined.has(name)) continue;
      if (new RegExp("(^|[^.\\w$])" + name + "\\s*\\(").test(appSrc)) bad.push(name);
    }
    assert.deepStrictEqual(bad, [], "голые вызовы функций ядра в app.js — нужно AgentCore.<имя>: " + bad.join(", "));
    assert.ok(uiAll().indexOf("AgentCore.normalizePlanTasks") !== -1, "нормализация плана не через ядро агента");
  });
}

async function testBootGuard() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "boot-guard.js"), "utf8");
  // Модуль собирается той же фабрикой, что и в окне: `self` — игрушечное окно,
  // поэтому проверяется и запись разбора наружу (`self.bootReport`), как её видит
  // человек, а не служебное поле экспорта.
  const vm = require("vm");
  const sandbox = { module: { exports: {} }, self: {}, console: { error() {}, warn() {}, log() {} } };
  vm.runInNewContext(src, sandbox, { filename: "boot-guard.js" });
  const mod = sandbox.module.exports;
  const winRoot = sandbox.self;
  assert.strictEqual(typeof mod.install, "function", "модуль дозора не отдал себя");

  // Игрушечное окно: ровно те возможности, которые дозору нужны, и счётчики, по
  // которым видно, что он действительно подписался и действительно нарисовал.
  function toyDom(opts) {
    opts = opts || {};
    const docListeners = {};
    const winListeners = {};
    const mkEl = (tag) => {
      const el = {
        tagName: String(tag).toUpperCase(),
        id: "",
        children: [],
        parentNode: null,
        textContent: "",
        style: { cssText: "" },
        attrs: {},
        listeners: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        appendChild(c) {
          c.parentNode = this;
          this.children.push(c);
          return c;
        },
        remove() {
          if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
          this.parentNode = null;
        },
        addEventListener(type, fn) {
          (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        click() {
          for (const fn of this.listeners.click || []) fn({});
        },
        find(id, out) {
          out = out || [];
          if (this.id === id) out.push(this);
          for (const c of this.children) c.find(id, out);
          return out;
        },
      };
      return el;
    };
    const body = mkEl("body");
    const doc = {
      readyState: opts.readyState || "complete",
      body: body,
      defaultView: null,
      createElement: mkEl,
      getElementById: (id) => ((opts.ids || []).indexOf(id) !== -1 ? { id: id } : null),
      addEventListener(type, fn) {
        (docListeners[type] = docListeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        docListeners[type] = (docListeners[type] || []).filter((x) => x !== fn);
      },
      hasFocus: () => true,
    };
    const win = {
      addEventListener(type, fn) {
        (winListeners[type] = winListeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        winListeners[type] = (winListeners[type] || []).filter((x) => x !== fn);
      },
      navigator: {},
    };
    doc.defaultView = win;
    return {
      doc: doc,
      win: win,
      fireDoc(type, e) {
        for (const fn of docListeners[type] || []) fn(e);
      },
      fireWin(type, e) {
        for (const fn of winListeners[type] || []) fn(e);
      },
      banner() {
        const found = body.find("boot-banner", []);
        return found.length ? found[0] : null;
      },
      mkEl: mkEl,
    };
  }

  await test("дозор запуска: решения — имя файла, место падения, чего не хватает", () => {
    // 1. Модуль на месте, встаёт ПЕРВЫМ скриптом и отдаётся телефону.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iBoot = html.indexOf('src="boot-guard.js"');
    assert.ok(iBoot > 0, "разметка не грузит boot-guard.js");
    assert.ok(iBoot < html.indexOf('src="provider-config.js"'), "boot-guard.js не первый скрипт — падение при загрузке пройдёт мимо него");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"boot-guard\.js"/.test(bridge), "мобильный мост не отдаёт boot-guard.js телефону");
    assert.ok(/root\.BootGuard = factory/.test(src), "модуль не выставляет себя в окно");

    // 2. Файл не загрузился: человек видит ИМЯ файла, а не «ошибка на странице».
    const res = mod.scriptFailure({ tagName: "SCRIPT", src: "file:///C:/app/src/renderer/chat-feed.js" });
    assert.ok(res && res.title.indexOf("chat-feed.js") !== -1, "дозор не назвал файл: " + JSON.stringify(res));
    assert.ok(res.kind === "resource", "поломка файла не отнесена к загрузке ресурса");
    const css = mod.scriptFailure({ tagName: "LINK", href: "https://x/styles.css" });
    assert.ok(css && /стиль/.test(css.hint), "стиль не отличается от скрипта: " + JSON.stringify(css));
    assert.strictEqual(mod.scriptFailure({ tagName: null, src: "" }), null, "дозор принял не-ресурс за ресурс");
    assert.strictEqual(mod.scriptFailure(null), null, "дозор падает на пустом событии");

    // 3. Падение: место берётся из filename/строки, свои кадры из стека не тащим.
    const err = mod.scriptError({
      message: "Cannot read properties of null (reading 'classList')",
      filename: "src/renderer/chat-feed.js",
      lineno: 42,
      colno: 7,
      stack: "Error: x\n  at jumpToBottom (chat-feed.js:42:7)\n  at renderMessages (app.js:100:2)\n  at boot-guard.js:1:1",
    });
    assert.ok(err.where.indexOf("chat-feed.js") !== -1 && err.where.indexOf("строка 42:7") !== -1, "место падения названо неточно: " + err.where);
    assert.strictEqual(err.stack.length, 2, "свои кадры остались в стеке: " + JSON.stringify(err.stack));
    assert.ok(/classList/.test(err.title), "текст ошибки потерялся");
    const dumb = mod.scriptError(undefined, "окно");
    assert.ok(dumb.title && dumb.title.length > 0, "пустая ошибка не описана словами");

    // 4. Неполная сборка окна: и модули, и узлы названы по-русски, с пояснением.
    const miss = mod.missingFrom([["ChatFeed", "лента чата"], ["ChatWork", "строки действий"]], (n) => n === "ChatFeed");
    // Сравнение через JSON: модуль собран в песочнице, и его массив — не массив этого процесса.
    assert.strictEqual(JSON.stringify(miss), JSON.stringify(["ChatWork (строки действий)"]), "список пропавшего собран неверно: " + JSON.stringify(miss));
    const model = mod.missingModel(["ChatFeed (лента чата)"], ["messages", "input"]);
    assert.ok(model.hint.indexOf("ChatFeed") !== -1 && model.hint.indexOf("messages") !== -1, "разбор неполон: " + model.hint);
    assert.ok(/чат работать не может/.test(model.title), "нет человеческого заголовка: " + model.title);

    // 5. Текст разбора: причина, место, версия кода и стек одной строкой для пересылки.
    const text = mod.problemsText([err, model], { version: () => "1.5.120 (C:\\app\\ota)" });
    assert.ok(/^⚠ Окно не работает/.test(text), "разбор не начинается с причины: " + text.slice(0, 80));
    assert.ok(text.indexOf("Версия кода: 1.5.120 (C:\\app\\ota)") !== -1, "в разборе нет версии кода");
    assert.ok(text.indexOf("Дальше:") !== -1, "в разборе нет остальных поломок");
    assert.ok(/поломок не записано/.test(mod.problemsText([])), "пустой разбор говорит неправду");
  });

  await test("дозор запуска: плашка показывает поломку и её можно закрыть", () => {
    // Окно, в котором нет НИ узлов, НИ модулей: дозор обязан сказать это сразу.
    const dom = toyDom({ ids: [] });
    const off = mod.install(dom.doc, {});
    const banner = dom.banner();
    assert.ok(banner, "дозор не показал плашку на пустом окне");
    const textOf = (b) => b.find("boot-banner", [])[0].children[0].textContent + "\n" + b.find("boot-banner", [])[0].children[1].textContent;
    assert.ok(/чат работать не может/.test(textOf(dom.doc.body)), "плашка не объясняет, что окно собрано неполно");
    assert.ok(/ChatFeed/.test(textOf(dom.doc.body)) && /#?messages/.test(textOf(dom.doc.body)), "плашка не называет пропавшее: " + textOf(dom.doc.body).slice(0, 200));
    assert.ok(typeof winRoot.bootReport === "function" && /чат работать не может/.test(winRoot.bootReport()), "разбор наружу не отдаётся человеку");
    off();
    assert.ok(!dom.doc.body.find("boot-banner", []).length, "отключение дозора не убрало плашку");

    // Полное окно: молчит. И наоборот — падение файла и падение кода показываются,
    // повтор того же падения не размножается.
    const good = toyDom({ ids: mod.REQUIRED_IDS.slice() });
    for (const [name] of mod.REQUIRED_MODULES) winRoot[name] = {};
    let offGood = null;
    try {
      offGood = mod.install(good.doc, {});
      assert.strictEqual(good.banner(), null, "дозор ругается на полностью собранное окно");
      const script = good.mkEl("script");
      script.src = "http://127.0.0.1/x/chat-feed.js";
      good.fireDoc("error", { target: script });
      const b1 = good.banner();
      assert.ok(b1, "падение загрузки файла не показано");
      assert.ok(b1.children[1].textContent.indexOf("chat-feed.js") !== -1, "плашка не назвала файл: " + b1.children[1].textContent.slice(0, 160));
      good.fireDoc("error", { target: script });
      const again = good.banner().children[1].textContent;
      assert.strictEqual(again.split("chat-feed.js").length - 1, 1, "одно и то же падение повторилось в плашке");
      good.fireWin("unhandledrejection", { reason: new Error("обещание сорвалось в чате") });
      assert.ok(/обещание сорвалось/.test(good.banner().children[1].textContent), "сорванное обещание не показано");
      // «Закрыть» убирает плашку и больше не мешает: новая поломка её не поднимает.
      const actions = good.banner().children[2];
      const closeBtn = actions.children[actions.children.length - 1];
      assert.ok(/Закрыть/.test(closeBtn.textContent), "в плашке нет кнопки «Закрыть»");
      closeBtn.click();
      assert.strictEqual(good.banner(), null, "плашка не закрылась");
      good.fireWin("unhandledrejection", { reason: new Error("ещё одна поломка") });
      assert.strictEqual(good.banner(), null, "закрытая плашка вернулась сама");
    } finally {
      if (offGood) offGood();
      for (const [name] of mod.REQUIRED_MODULES) delete winRoot[name];
    }

    // Разбор доступен человеку и без моста: `bootReport` пишет версию словами.
    const solo = toyDom({ ids: mod.REQUIRED_IDS.slice() });
    const offSolo = mod.install(solo.doc, {});
    const script2 = solo.mkEl("script");
    script2.src = "/y/chat-work.js";
    solo.fireDoc("error", { target: script2 });
    const report = winRoot.bootReport();
    assert.ok(report.indexOf("chat-work.js") !== -1, "разбор наружу не назвал файл: " + report.slice(0, 160));
    assert.ok(report.indexOf("Версия кода") !== -1, "в разборе наружу нет версии кода: " + report.slice(0, 200));
    offSolo();
    assert.strictEqual(typeof mod.install(null), "function", "дозор не переживает окно без документа");
  });
}

module.exports = {
  testUiSearch,
  testAppUiRefs,
  testVaultUi,
  testSecretsPanel,
  testPlanPanel,
  testBootGuard,
};

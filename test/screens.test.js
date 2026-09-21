"use strict";

/* ── Скриншоты страницы и их сохранение (src/screens.js) ───────────────────────
   Запуск: node test/screens.test.js   (входит в общий `npm test`)

   Зачем отдельный набор. Этот код жил в main.js и вызывался только из
   инструментов (screenshotCapture, захват экрана), то есть проверялся КОСВЕННО —
   наборами инструментов с поддельным захватом. Настоящая его работа не была
   видна нигде: невидимое окно, которое надо погасить в ЛЮБОМ исходе (иначе оно
   останется висеть), картинка, которую надо ужать (иначе она уедет в
   vision-модель целиком), файл, который надо положить в конкретную папку.

   Здесь проверяется ровно это, и без Electron: окно поддельное, но с настоящим
   набором того, что модуль у него спрашивает (webContents.once, capturePage,
   loadURL, isDestroyed, destroy), а картинка — с настоящими toJPEG/toPNG/resize.
   Реальное окно и настоящий нативный кодек проверяются живым прогоном
   (npm run test:live:screens) — подделка этого показать не может.

   Часы поддельные осознанно: 30 с ожидания загрузки и 2,5 с до снимка — это
   поведение, а не деталь. Здесь видно и сами задержки, и что по истечении
   таймаута окно гасится, а не висит до конца работы приложения. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createScreens } = require(path.join(ROOT, "src", "screens.js"));

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
      console.log("  ✗ " + name);
      console.log("      " + (e && e.message ? e.message : String(e)));
    });
}

// ── Поддельные часы ─────────────────────────────────────────────────────────
// Живые задержки (30 с и 2,5 с) в наборе ждать нельзя, но проверить их надо:
// модуль зовёт setTimeout без префикса, поэтому подмены глобального достаточно
// и она видна ИМЕННО тому коду, который здесь проверяется.
async function withClock(fn) {
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  const pending = new Map();
  let id = 0;
  global.setTimeout = (cb, ms) => {
    const k = "t" + ++id;
    pending.set(k, { cb, ms });
    return k;
  };
  global.clearTimeout = (k) => pending.delete(k);
  const clock = {
    pending,
    // Самый ранний таймер: первый, который поставил модуль (ожидание загрузки).
    next() {
      const rows = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms);
      return rows.length ? { key: rows[0][0], ms: rows[0][1].ms } : null;
    },
    // Последний по счёту: пауза до снимка ставится уже внутри did-finish-load.
    last() {
      const rows = [...pending.entries()];
      return rows.length ? { key: rows[rows.length - 1][0], ms: rows[rows.length - 1][1].ms } : null;
    },
    async run(key) {
      const t = pending.get(key);
      pending.delete(key);
      assert.ok(t, "таймера " + key + " нет");
      await t.cb();
    },
  };
  try {
    return await fn(clock);
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
  }
}

// Промис, который разрешится, когда его позовут снаружи.
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// ── Поддельное окно ─────────────────────────────────────────────────────────
function makeWindow(opts) {
  const o = opts || {};
  const rec = { created: [], listeners: [], loads: [], captured: 0, destroyed: 0, resizes: [], jpegs: [], pngs: [] };

  const makeImage = (w, h, flags) => {
    const f = flags || {};
    return {
      getSize: () => ({ width: w, height: h }),
      resize(spec) {
        if (f.resizeThrows) throw new Error("resize не сработал");
        rec.resizes.push(spec);
        return makeImage(spec.width, spec.height, f);
      },
      toJPEG(q) {
        rec.jpegs.push(q);
        if (f.jpegThrows) throw new Error("кодек JPEG недоступен");
        if (f.jpegEmpty) return Buffer.alloc(0);
        return Buffer.from("JPEG:" + q + ":" + w + "x" + h);
      },
      toPNG() {
        rec.pngs.push({ w, h });
        return Buffer.from("PNG:" + w + "x" + h);
      },
    };
  };

  function BrowserWindow(config) {
    rec.created.push(config);
    if (o.constructThrows) throw new Error("окно не создалось");
    const self = {
      id: rec.created.length,
      destroyed: false,
      webContents: {
        id: 100 + rec.created.length,
        once(event, cb) {
          rec.listeners.push({ event, cb });
        },
        async capturePage() {
          rec.captured++;
          if (o.captureThrows) throw new Error("снимок не вышел");
          return makeImage(o.width || 1280, o.height || 800, o.img);
        },
      },
      isDestroyed: () => self.destroyed,
      destroy() {
        self.destroyed = true;
        rec.destroyed++;
      },
      loadURL(url) {
        rec.loads.push(url);
        if (o.loadRejects) return Promise.reject(new Error(o.loadRejects));
        return Promise.resolve();
      },
    };
    return self;
  }

  return { rec, BrowserWindow };
}

// Снимок на живых часах: тело проверки работает ВНУТРИ подмены.
// Это не придирка: если вернуть управление наружу, обработчик did-finish-load
// поставит паузу уже настоящим setTimeout — и проверка «2,5 с» молча смотрела бы
// на таймаут ожидания загрузки (на этом набор и споткнулся в первый раз).
async function screensWith(opts, body) {
  const w = makeWindow(opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screens-suite-"));
  const screens = createScreens({ BrowserWindow: w.BrowserWindow, userDataDir: dir });
  return await withClock(async (clock) => {
    const call = screens.screenshotUrl("http://example.test/page");
    const first = clock.next();
    const api = {
      w,
      clock,
      screens,
      dir,
      call,
      first,
      events: () => w.rec.listeners.map((l) => l.event),
      fire: () => emit(w, "did-finish-load"),
      emitFail: (code, desc) => emit(w, "did-fail-load", [null, code, desc]),
    };
    return await body(api);
  });
}

// Событие окна: зовём ровно того слушателя, которого модуль повесил через once.
function emit(w, event, args) {
  const list = w.rec.listeners.filter((l) => l.event === event);
  assert.ok(list.length, "модуль не ждёт " + event);
  list.forEach((l) => l.cb.apply(null, args || []));
}

(async () => {
  console.log("Скриншоты страницы (src/screens.js)");

  await test("невидимое окно: спрятано, без Node в странице, размер 1280×800", () =>
    screensWith({}, async (c) => {
      const cfg = c.w.rec.created[0];
      assert.ok(cfg, "окно не создано");
      assert.strictEqual(cfg.show, false, "окно показывается пользователю");
      assert.strictEqual(cfg.width, 1280, "ширина окна изменилась");
      assert.strictEqual(cfg.height, 800, "высота окна изменилась");
      // Размер — страницы, а не окна: иначе рамка съедает точки и снимок приходит
      // не того размера, который инструмент обещает пользователю (нашёл живой прогон).
      assert.strictEqual(cfg.useContentSize, true, "размер считается по окну: рамка урежет снимок");
      assert.deepStrictEqual(cfg.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false },
        "песочница окна ослаблена: чужая страница получила бы доступ к Node");
      assert.deepStrictEqual(c.w.rec.loads, ["http://example.test/page"], "адрес загружен не тот");
      assert.deepStrictEqual(c.events().sort(), ["did-fail-load", "did-finish-load"], "модуль слушает не те события окна");
      assert.strictEqual(c.w.rec.captured, 0, "снимок сделан до загрузки страницы");
    }));

  await test("загрузка: 30 с на загрузку и 2,5 с на отрисовку, потом снимок", () =>
    screensWith({}, async (c) => {
      assert.strictEqual(c.first.ms, 30000, "таймаут загрузки не 30 с, а " + c.first.ms);
      c.fire();
      const wait = c.clock.last();
      assert.strictEqual(wait.ms, 2500, "пауза до снимка не 2,5 с, а " + wait.ms);
      await c.clock.run(wait.key);
      const shot = await c.call;
      assert.strictEqual(shot.ok, true, "снимок не удался: " + shot.err);
      assert.strictEqual(c.w.rec.captured, 1, "capturePage вызван " + c.w.rec.captured + " раз");
      assert.strictEqual(shot.mime, "image/jpeg", "по умолчанию должен быть JPEG, а не " + shot.mime);
      assert.ok(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot.dataUrl), "data URL собран неверно: " + String(shot.dataUrl).slice(0, 40));
      assert.strictEqual(Buffer.from(shot.dataUrl.split(",")[1], "base64").toString(), "JPEG:72:1280x800", "в data URL не тот байт-код картинки");
    }));

  await test("окно гасится и после успеха, и после сбоя загрузки", async () => {
    await screensWith({}, async (c) => {
      c.fire();
      await c.clock.run(c.clock.last().key);
      const shot = await c.call;
      assert.strictEqual(shot.ok, true, "снимок не удался: " + shot.err);
      assert.strictEqual(c.w.rec.destroyed, 1, "окно осталось висеть после снимка");
    });
    await screensWith({}, async (d) => {
      d.emitFail(-105, "ERR_NAME_NOT_RESOLVED");
      const bad = await d.call;
      assert.strictEqual(bad.ok, false, "сбой загрузки прошёл за успех");
      assert.strictEqual(d.w.rec.destroyed, 1, "окно осталось висеть после сбоя загрузки");
    });
  });

  await test("сбой загрузки объясняется кодом и текстом, длинный текст обрезается", async () => {
    await screensWith({}, async (c) => {
      c.emitFail(-105, "x".repeat(500));
      const r = await c.call;
      assert.strictEqual(r.err.slice(0, 5), "-105 ", "в ошибке нет кода: " + r.err.slice(0, 30));
      assert.strictEqual(r.err.length, 5 + 300, "длинное описание не обрезано до 300 символов");
    });
    await screensWith({ loadRejects: "адрес не открылся" }, async (d) => {
      const r2 = await d.call;
      assert.strictEqual(r2.ok, false, "отказ loadURL прошёл за успех");
      assert.strictEqual(r2.err, "адрес не открылся", "причина отказа loadURL потерялась: " + r2.err);
      assert.strictEqual(d.w.rec.destroyed, 1, "окно осталось висеть после отказа loadURL");
    });
  });

  await test("таймаут загрузки: понятный текст и погашенное окно", () =>
    screensWith({}, async (c) => {
      await c.clock.run(c.clock.next().key);
      const r = await c.call;
      assert.strictEqual(r.ok, false, "таймаут прошёл за успех");
      assert.ok(/таймаут загрузки http:\/\/example\.test\/page \(30 с\)/.test(r.err), "текст таймаута: " + r.err);
      assert.strictEqual(c.w.rec.destroyed, 1, "окно осталось висеть после таймаута");
      assert.strictEqual(c.w.rec.captured, 0, "снимок делался при незагруженной странице");
    }));

  await test("окно не создалось и снимок не вышел — ошибка, а не падение прогона", async () => {
    await screensWith({ constructThrows: true }, async (c) => {
      const r = await c.call;
      assert.strictEqual(r.ok, false, "исключение при создании окна прошло наружу");
      assert.strictEqual(r.err, "окно не создалось", "текст ошибки создания окна потерялся");
      assert.strictEqual(c.w.rec.destroyed, 0, "гасили окно, которого нет");
      assert.strictEqual(c.clock.pending.size, 0, "после отказа окна остался висеть таймер ожидания загрузки");
    });
    await screensWith({ captureThrows: true }, async (d) => {
      d.fire();
      await d.clock.run(d.clock.last().key);
      const r2 = await d.call;
      assert.strictEqual(r2.ok, false, "исключение capturePage прошло наружу");
      assert.strictEqual(r2.err, "снимок не вышел", "текст ошибки снимка потерялся");
      assert.strictEqual(d.w.rec.destroyed, 1, "окно осталось висеть после сбоя снимка");
    });
  });

  await test("кодирование: JPEG по умолчанию, PNG по png:true и по format:png", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screens-enc-"));
    const w = makeWindow({ width: 800, height: 600 });
    const s = createScreens({ BrowserWindow: w.BrowserWindow, userDataDir: dir });
    const img = await (async () => {
      const cfg = makeWindow({ width: 800, height: 600 });
      return { getSize: () => ({ width: 800, height: 600 }), toJPEG: (q) => Buffer.from("J" + q), toPNG: () => Buffer.from("P") };
    })();
    const def = s.encodeShot(img, {});
    assert.strictEqual(def.mime, "image/jpeg", "по умолчанию не JPEG: " + def.mime);
    assert.strictEqual(def.ext, ".jpg", "расширение по умолчанию не .jpg");
    assert.strictEqual(def.buf.toString(), "J72", "качество по умолчанию не 72: " + def.buf.toString());
    assert.strictEqual(s.encodeShot(img, { png: true }).mime, "image/png", "png:true не переключил формат");
    assert.strictEqual(s.encodeShot(img, { format: "png" }).ext, ".png", "format:png не переключил формат");
    assert.strictEqual(s.encodeShot(img, { png: false }).mime, "image/jpeg", "png:false сломал формат по умолчанию");
  });

  await test("кодирование: качество и ширина зажаты в разумные границы", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screens-clamp-"));
    const s = createScreens({ BrowserWindow: makeWindow({}).BrowserWindow, userDataDir: dir });
    const calls = [];
    const img = { getSize: () => ({ width: 100, height: 100 }), toJPEG: (q) => { calls.push(q); return Buffer.from("x"); }, toPNG: () => Buffer.from("p") };
    s.encodeShot(img, { quality: 1 });
    s.encodeShot(img, { quality: 100 });
    s.encodeShot(img, { quality: 999 });
    s.encodeShot(img, { quality: "мусор" });
    assert.deepStrictEqual(calls, [30, 100, 100, 72], "качество не зажато в 30..100: " + calls.join(", "));

    const big = { sizes: [], getSize: () => ({ width: 4000, height: 2000 }), resize(spec) { this.sizes.push(spec); return { getSize: () => ({ width: spec.width, height: spec.height }), toJPEG: () => Buffer.from("j"), toPNG: () => Buffer.from("p") }; }, toJPEG: () => Buffer.from("j"), toPNG: () => Buffer.from("p") };
    s.encodeShot(big, {});
    s.encodeShot(big, { maxWidth: 100 });
    s.encodeShot(big, { maxWidth: 99999 });
    assert.deepStrictEqual(big.sizes.map((r) => r.width), [1440, 480, 2560], "длинная сторона ужимается не по правилам: " + big.sizes.map((r) => r.width).join(", "));
    assert.deepStrictEqual(big.sizes.map((r) => r.height), [720, 240, 1280], "пропорции картинки не сохранены");
    assert.ok(big.sizes.every((r) => r.quality === "good"), "сжатие идёт не с качеством good");
  });

  await test("кодирование: сломанный JPEG-кодек не отменяет снимок — отдаём PNG", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screens-fallback-"));
    const s = createScreens({ BrowserWindow: makeWindow({}).BrowserWindow, userDataDir: dir });
    const throwing = { getSize: () => ({ width: 10, height: 10 }), toJPEG: () => { throw new Error("нет кодека"); }, toPNG: () => Buffer.from("PNG") };
    const empty = { getSize: () => ({ width: 10, height: 10 }), toJPEG: () => Buffer.alloc(0), toPNG: () => Buffer.from("PNG") };
    assert.strictEqual(s.encodeShot(throwing, {}).mime, "image/png", "исключение JPEG не откатилось на PNG");
    assert.strictEqual(s.encodeShot(empty, {}).mime, "image/png", "пустой JPEG отдан как картинка");
    assert.strictEqual(s.encodeShot(throwing, {}).buf.toString(), "PNG", "в откат ушли не PNG-байты");
    const brokenSize = { getSize: () => { throw new Error("нет размера"); }, toJPEG: () => Buffer.from("j"), toPNG: () => Buffer.from("p") };
    assert.strictEqual(s.encodeShot(brokenSize, {}).mime, "image/jpeg", "неудачный замер размера сломал обычный путь");
    const brokenResize = { getSize: () => ({ width: 5000, height: 10 }), resize: () => { throw new Error("resize сломался"); }, toJPEG: () => Buffer.from("j"), toPNG: () => Buffer.from("p") };
    assert.strictEqual(s.encodeShot(brokenResize, {}).buf.toString(), "j", "неудачное сжатие не откатилось на исходную картинку");
  });

  await test("сохранение: папка screenshots, расширение по типу и очистка имени", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screens-save-"));
    const s = createScreens({ BrowserWindow: makeWindow({}).BrowserWindow, userDataDir: dir });
    const jpg = s.saveScreenshotPng(Buffer.from("jpeg-байты"), "page", "image/jpeg");
    assert.strictEqual(path.dirname(jpg), path.join(dir, "screenshots"), "файл сохранён не в userData/screenshots: " + jpg);
    assert.ok(/\.jpg$/.test(jpg), "jpeg сохранён не как .jpg: " + path.basename(jpg));
    assert.strictEqual(fs.readFileSync(jpg).toString(), "jpeg-байты", "содержимое файла не совпало");
    const png = s.saveScreenshotPng(Buffer.from("png-байты"), "page", "image/png");
    assert.ok(/\.png$/.test(png), "png сохранён не как .png: " + path.basename(png));
    const noMime = s.saveScreenshotPng(Buffer.from("x"), "page", "");
    assert.ok(/\.png$/.test(noMime), "без типа файл не .png: " + path.basename(noMime));
    const dirty = s.saveScreenshotPng(Buffer.from("x"), "../../злая/страница №1.png", "image/png");
    assert.strictEqual(path.dirname(dirty), path.join(dir, "screenshots"), "имя вывело файл за папку скриншотов");
    assert.ok(/^[\w.-]+-\d+\.png$/.test(path.basename(dirty)), "недопустимые символы в имени не заменены: " + path.basename(dirty));
    const unnamed = s.saveScreenshotPng(Buffer.from("x"), "", "image/png");
    assert.ok(/^shot-\d+\.png$/.test(path.basename(unnamed)), "имя по умолчанию не shot: " + path.basename(unnamed));
    assert.notStrictEqual(jpg, s.saveScreenshotPng(Buffer.from("jpeg-байты"), "page", "image/jpeg"), "два снимка подряд затёрли друг друга");
  });

  await test("проводка: имена те же, а из оболочки код действительно ушёл", () => {
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(/const \{ createScreens \} = require\("\.\/screens\.js"\)/.test(main), "main.js не подключает модуль скриншотов");
    assert.ok(/createScreens\(\{\s*BrowserWindow,\s*userDataDir: app\.getPath\("userData"\)/.test(main), "в модуль не переданы настоящее окно и папка приложения");
    assert.ok(/function screenshotUrl\(|function encodeShot\(|function saveScreenshotPng\(/.test(main) === false,
      "в main.js осталась вторая копия кода скриншотов");
    const tools = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    for (const name of ["screenshotUrl", "saveScreenshotPng", "encodeShot"]) {
      assert.ok(new RegExp("\\b" + name + "\\b").test(tools), "инструмент больше не зовёт " + name);
    }
    // Модуль не должен тянуть Electron сам: иначе его нельзя проверить в обычном Node.
    const mod = fs.readFileSync(path.join(ROOT, "src", "screens.js"), "utf8");
    assert.ok(/require\("electron"\)/.test(mod.replace(/^\s*\*.*$/gm, "")) === false, "модуль подключает electron напрямую");
    assert.ok(/require\("fs"\)/.test(mod) && /require\("path"\)/.test(mod), "модуль потерял fs/path");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

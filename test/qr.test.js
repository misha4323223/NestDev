"use strict";

/* ── QR-код для подключения телефона (src/renderer/qr.js) ───────────────────
   Запуск: node test/qr.test.js   (входит в общий `npm test`)

   Зачем свой кодировщик и зачем его проверять: телефон подключается к приложению
   наведением камеры на QR-код с экрана ПК (адрес моста + PIN внутри кода). Если
   матрица построена неверно, снаружи это выглядит как «камера водит и ничего не
   находит», а не как «ошибка в коде». Поэтому проверяется не «похоже на QR», а
   три вещи, каждая из которых ломается по-своему:

     1. матрица совпадает бит в бит с эталонной реализацией (qrcode-generator,
        Кадзухико Арасэ) — 40 векторов: пять адресов × четыре уровня коррекции ×
        минимальная версия и версия на одну выше. Это закрывает сразу таблицу
        блоков, Рид—Соломон, раскладку, маски и форматную информацию;
     2. служебные поля читаются там, где их ищет сканер: форматная информация в
        двух местах и совпадает между собой, номер версии для версий 7+, ищем-
        паттерны, разделители, синхронизация и «тёмный модуль»;
     3. ёмкость версий совпадает с опубликованной таблицей байтовой ёмкости
        (v1: L17 M14 Q11 H7 … v10: L271 M213 Q151 H119) и версия выбирается
        минимально возможной, а переполнение — внятная ошибка, а не битый код. */

const assert = require("assert");
const crypto = require("crypto");
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

const QR = require(path.join(ROOT, "src", "renderer", "qr.js"));

// ── Векторы эталонной реализации ────────────────────────────────────────────
// digest = sha256 от матрицы («#»/«.» построчно), первые 16 шестнадцатеричных
// знаков. Снято с qrcode-generator 2.0.4 при явной версии и явной маске: маска
// выбирается свободно по спецификации, поэтому фиксируем её в векторе.
const REF_VECTORS = [
  ["http://192.168.1.42:9090/#pin=482913", "L", 3, 5, "6ea0571d08f6f24f"],
  ["http://192.168.1.42:9090/#pin=482913", "L", 4, 2, "73243496010246ee"],
  ["http://192.168.1.42:9090/#pin=482913", "M", 3, 2, "76e9a2aa5e52a69e"],
  ["http://192.168.1.42:9090/#pin=482913", "M", 4, 2, "9187977325300ad5"],
  ["http://192.168.1.42:9090/#pin=482913", "Q", 4, 3, "71f31c38506e5162"],
  ["http://192.168.1.42:9090/#pin=482913", "Q", 5, 2, "799aa36efc46cf75"],
  ["http://192.168.1.42:9090/#pin=482913", "H", 5, 2, "92a36e38c80574ca"],
  ["http://192.168.1.42:9090/#pin=482913", "H", 6, 2, "e23be775d5a41cdb"],
  ["http://10.0.0.7:9090/#pin=948271", "L", 2, 6, "226c5247c5428414"],
  ["http://10.0.0.7:9090/#pin=948271", "L", 3, 2, "3b3dae30fdb163a4"],
  ["http://10.0.0.7:9090/#pin=948271", "M", 3, 7, "fd12cb7907eba1d8"],
  ["http://10.0.0.7:9090/#pin=948271", "M", 4, 2, "0a5b14e285bf3433"],
  ["http://10.0.0.7:9090/#pin=948271", "Q", 3, 4, "534b2e583eba64f7"],
  ["http://10.0.0.7:9090/#pin=948271", "Q", 4, 2, "65a6fd7ebcf5fe2f"],
  ["http://10.0.0.7:9090/#pin=948271", "H", 4, 5, "199b215980be7f9a"],
  ["http://10.0.0.7:9090/#pin=948271", "H", 5, 3, "64b143efc5d7aac9"],
  ["http://a/#p=12", "L", 1, 3, "0761e6ddd2623a6a"],
  ["http://a/#p=12", "L", 2, 6, "7f82285550054e3e"],
  ["http://a/#p=12", "M", 1, 7, "7e5c781cdf5dfea0"],
  ["http://a/#p=12", "M", 2, 6, "9920de9a89c506d7"],
  ["http://a/#p=12", "Q", 2, 0, "2e83addf7ece4fdb"],
  ["http://a/#p=12", "Q", 3, 6, "8786529fb3fc9160"],
  ["http://a/#p=12", "H", 2, 3, "60050724734e128e"],
  ["http://a/#p=12", "H", 3, 6, "413960a961295b07"],
  ["A", "L", 1, 0, "defea385aeee6c21"],
  ["A", "L", 2, 3, "37ad5dc7f4d99c7b"],
  ["A", "M", 1, 4, "4d56e8efba179621"],
  ["A", "M", 2, 3, "393fb5c2d5f5df10"],
  ["A", "Q", 1, 4, "b7e66a50b9e2ecd3"],
  ["A", "Q", 2, 0, "e0b180a38a1fe233"],
  ["A", "H", 1, 2, "017290734a604525"],
  ["A", "H", 2, 6, "705bbbbf2602ea8c"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "L", 3, 5, "b65b64a145158cd6"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "L", 4, 2, "7f1edad218eb0a29"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "M", 4, 2, "5ee31f58dee0aa3b"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "M", 5, 1, "f97e6f19b3bd6143"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "Q", 4, 2, "066ced6c4513e1b9"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "Q", 5, 5, "5e96c46bb35fcfff"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "H", 5, 2, "e19f30b59a14fd32"],
  ["http://192.168.1.42:9090/#pin=482913?from=qr", "H", 6, 2, "31e92cd803b2706e"],
  // Версии 7+ — там появляются блоки номера версии, а с 10-й счётчик длины
  // становится 16-битным. Полная загрузка («X» ровно по ёмкости) проверяет добивку
  // (0xEC/0x11) на больших блоках, а не только её начало.
  ["http://192.168.1.42:9090/#pin=482913", "L", 7, 2, "f61d49d58716eb67"],
  ["X".repeat(154), "L", 7, 3, "847e7182c582766f"],
  ["http://192.168.1.42:9090/#pin=482913", "M", 7, 2, "252e79f5f7c11ba3"],
  ["X".repeat(122), "M", 7, 3, "f43a5af3033c9397"],
  ["http://192.168.1.42:9090/#pin=482913", "Q", 7, 3, "b89ded1f1f08b3d1"],
  ["X".repeat(86), "Q", 7, 3, "8b2488713412f336"],
  ["http://192.168.1.42:9090/#pin=482913", "H", 7, 6, "b46aef2564ff7624"],
  ["X".repeat(64), "H", 7, 5, "027b8a0208f356ca"],
  ["http://192.168.1.42:9090/#pin=482913", "L", 9, 2, "b1dc63140d3b9d74"],
  ["X".repeat(230), "L", 9, 3, "9bbd07f9dc1fad3a"],
  ["http://192.168.1.42:9090/#pin=482913", "M", 9, 5, "3c834d6d163c395a"],
  ["X".repeat(180), "M", 9, 3, "685e37458dc02a46"],
  ["http://192.168.1.42:9090/#pin=482913", "Q", 9, 2, "f9398313ce1b1fc3"],
  ["X".repeat(130), "Q", 9, 3, "7cbd9b229ca028b8"],
  ["http://192.168.1.42:9090/#pin=482913", "H", 9, 2, "58148e7dac5e8d27"],
  ["X".repeat(98), "H", 9, 3, "5c0d2f10dbb78df5"],
  ["http://192.168.1.42:9090/#pin=482913", "L", 10, 2, "01bc0e339b3efc84"],
  ["X".repeat(271), "L", 10, 3, "1cf96958af77fbb7"],
  ["http://192.168.1.42:9090/#pin=482913", "M", 10, 2, "0f12b369ca55636b"],
  ["X".repeat(213), "M", 10, 3, "c3ae0f22f92a190f"],
  ["http://192.168.1.42:9090/#pin=482913", "Q", 10, 3, "7d81e388618f95ae"],
  ["X".repeat(151), "Q", 10, 3, "f98aff481ce1de54"],
  ["http://192.168.1.42:9090/#pin=482913", "H", 10, 3, "0d50526c777c98c8"],
  ["X".repeat(119), "H", 10, 3, "d5a7c9cc786140df"],
];

// Опубликованная ёмкость байтового режима (ISO/IEC 18004, таблица 7).
const PUBLISHED_BYTES = [
  { L: 17, M: 14, Q: 11, H: 7 },
  { L: 32, M: 26, Q: 20, H: 14 },
  { L: 53, M: 42, Q: 32, H: 24 },
  { L: 78, M: 62, Q: 46, H: 34 },
  { L: 106, M: 84, Q: 60, H: 44 },
  { L: 134, M: 106, Q: 74, H: 58 },
  { L: 154, M: 122, Q: 86, H: 64 },
  { L: 192, M: 152, Q: 108, H: 84 },
  { L: 230, M: 180, Q: 130, H: 98 },
  { L: 271, M: 213, Q: 151, H: 119 },
];

const ECC_BY_FORMAT_BITS = { 1: "L", 0: "M", 3: "Q", 2: "H" };

function sha16(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function matrix(text, opts) {
  const q = QR.encode(text, opts);
  return q.modules.map((row) => row.map((v) => (v ? 1 : 0)));
}

function darkAt(rows, row, col) {
  return rows[row] && rows[row][col] === 1;
}

// Максимум байт, который влезает в версию: кодовые слова данных минус заголовок
// (режим 4 бита + счётчик длины).
function maxBytes(version, ecc) {
  return Math.floor((QR.dataCapacity(version, ecc) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);
}

// Чтение форматной информации по карте из спецификации (два независимых места).
function readFormat(rows, size) {
  const places = [];
  for (let i = 0; i <= 5; i++) places.push([i, 8]);
  places.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i++) places.push([8, 14 - i]);
  const second = [];
  for (let i = 0; i < 8; i++) second.push([8, size - 1 - i]);
  for (let i = 8; i < 15; i++) second.push([size - 15 + i, 8]);
  const value = (list) => {
    let v = 0;
    list.forEach(([r, c], i) => {
      if (darkAt(rows, r, c)) v |= 1 << i;
    });
    return v;
  };
  return { a: value(places), b: value(second) };
}

function bchRemainder(value, poly) {
  const digit = (v) => {
    let d = 0;
    while (v !== 0) {
      d++;
      v >>>= 1;
    }
    return d;
  };
  let v = value;
  while (digit(v) - digit(poly) >= 0) v ^= poly << (digit(v) - digit(poly));
  return v;
}

// Чтение номера версии (18 бит, два блока 3×6 по спецификации).
function readVersionInfo(rows, size) {
  const a = [];
  const b = [];
  for (let i = 0; i < 18; i++) {
    a.push([Math.floor(i / 3), size - 11 + (i % 3)]);
    b.push([size - 11 + (i % 3), Math.floor(i / 3)]);
  }
  const value = (list) => {
    let v = 0;
    list.forEach(([r, c], i) => {
      if (darkAt(rows, r, c)) v |= 1 << i;
    });
    return v;
  };
  return { a: value(a), b: value(b) };
}

(async () => {
  await test("матрицы совпадают с эталоном бит в бит (64 вектора)", () => {
    assert.strictEqual(REF_VECTORS.length, 64, "векторов должно быть 64");
    for (const [text, ecc, version, mask, digest] of REF_VECTORS) {
      const rows = matrix(text, { ecc, version, mask });
      const asText = rows.map((r) => r.map((v) => (v ? "#" : ".")).join("")).join("\n");
      assert.strictEqual(
        sha16(asText),
        digest,
        "расхождение с эталоном: " + JSON.stringify(text) + " " + ecc + " v" + version + " mask" + mask
      );
      const q = QR.encode(text, { ecc, version, mask });
      assert.strictEqual(q.version, version, "версия в ответе");
      assert.strictEqual(q.mask, mask, "маска в ответе");
      assert.strictEqual(q.ecc, ecc, "уровень в ответе");
      assert.strictEqual(q.modules.length, version * 4 + 17, "размер матрицы");
    }
  });

  await test("форматная информация читается на месте и в двух копиях совпадает", () => {
    for (const [text, ecc, version, mask] of REF_VECTORS.slice(0, 12)) {
      const rows = matrix(text, { ecc, version, mask });
      const size = rows.length;
      const f = readFormat(rows, size);
      assert.strictEqual(f.a, f.b, "две копии форматной информации разошлись");
      const code = f.a ^ 0x5412;
      assert.strictEqual(bchRemainder(code, 0x537), 0, "форматная информация не проходит BCH-проверку");
      const data = code >>> 10;
      assert.strictEqual(ECC_BY_FORMAT_BITS[data >>> 3], ecc, "в коде записан другой уровень коррекции");
      assert.strictEqual(data & 7, mask, "в коде записана другая маска");
    }
  });

  await test("номер версии в коде (v7+) читается и совпадает", () => {
    for (const version of [7, 8, 10]) {
      const rows = matrix("http://192.168.1.42:9090/#pin=482913", { ecc: "L", version });
      const size = rows.length;
      const v = readVersionInfo(rows, size);
      assert.strictEqual(v.a, v.b, "две копии номера версии разошлись");
      assert.strictEqual(bchRemainder(v.a, 0x1f25), 0, "номер версии не проходит BCH-проверку");
      assert.strictEqual(v.a >>> 12, version, "в коде записан другой номер версии");
    }
  });

  await test("ищем-паттерны, разделители, синхронизация и тёмный модуль на месте", () => {
    for (const version of [1, 3, 7]) {
      const rows = matrix("http://a/#p=12", { ecc: "M", version });
      const size = rows.length;
      for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let r = 0; r < 7; r++)
          for (let c = 0; c < 7; c++) {
            const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
            const want = ring === 3 || ring <= 1 ? 1 : 0;
            assert.strictEqual(darkAt(rows, r0 + r, c0 + c), !!want, "ищем-паттерн испорчен v" + version);
          }
      }
      // Разделители вокруг верхнего левого паттерна — светлые.
      for (let i = 0; i <= 7; i++) {
        assert.strictEqual(darkAt(rows, 7, i), false, "разделитель справа от паттерна не пуст");
        assert.strictEqual(darkAt(rows, i, 7), false, "разделитель снизу от паттерна не пуст");
      }
      // Синхронизация: через одну тёмная, начиная с тёмной у 8-й позиции.
      for (let i = 8; i <= size - 9; i++) {
        assert.strictEqual(darkAt(rows, 6, i), i % 2 === 0, "синхронизация по строке 6 v" + version);
        assert.strictEqual(darkAt(rows, i, 6), i % 2 === 0, "синхронизация по столбцу 6 v" + version);
      }
      // «Тёмный модуль» всегда тёмный.
      assert.strictEqual(darkAt(rows, size - 8, 8), true, "тёмный модуль не тёмный");
    }
  });

  await test("ёмкость версий совпадает с опубликованной таблицей байтового режима", () => {
    PUBLISHED_BYTES.forEach((row, i) => {
      const version = i + 1;
      for (const ecc of ["L", "M", "Q", "H"]) {
        assert.strictEqual(maxBytes(version, ecc), row[ecc], "ёмкость v" + version + " " + ecc);
      }
    });
  });

  await test("версия выбирается минимально возможной, а переполнение — понятная ошибка", () => {
    for (let version = 1; version <= 10; version++) {
      for (const ecc of ["L", "M", "Q", "H"]) {
        const cap = maxBytes(version, ecc);
        assert.strictEqual(QR.pickVersion(cap, ecc), version, "подбор версии для ровно вмещающегося текста");
        if (version < 10) {
          assert.strictEqual(QR.pickVersion(cap + 1, ecc), version + 1, "подбор версии для +1 байта");
        }
      }
    }
    const last = maxBytes(10, "H");
    assert.strictEqual(QR.pickVersion(last + 1, "H"), 0, "переполнение должно сообщать 0");
    // Ровно вмещающийся текст кодируется, на байт больше — понятная ошибка.
    assert.strictEqual(QR.encode("X".repeat(last), { ecc: "H", version: 10 }).version, 10, "ровно вмещающийся текст");
    assert.throws(() => QR.encode("X".repeat(last + 1), { ecc: "H", version: 10 }), /данных больше/, "переполнение версии");
    assert.throws(() => QR.encode("X".repeat(3000), { ecc: "L" }), /не влезают/, "переполнение всех версий");
    assert.throws(() => QR.encode("A", { version: 11 }), /версии 1–10/, "версия вне таблицы");
  });

  await test("ссылка с PIN кодируется как есть: UTF-8, ёмкость, тихая зона, SVG", () => {
    const url = "http://192.168.1.42:9090/#pin=482913";
    assert.deepStrictEqual(QR.utf8Bytes("прив"), Array.from(Buffer.from("прив", "utf8")), "UTF-8 байты");
    // Кириллица в ссылке (имя сети/метка) не должна ломать кодирование.
    const cyr = QR.encode("http://192.168.1.42:9090/#pin=482913&n=Дом", { ecc: "M" });
    assert.ok(cyr.version >= 1 && cyr.modules.length === cyr.version * 4 + 17, "кириллица в ссылке");

    const svg = QR.toSvg(url, { ecc: "M" });
    assert.ok(svg.indexOf("<svg") === 0, "SVG должен начинаться с <svg");
    assert.ok(svg.indexOf('fill="#ffffff"') > 0, "нет белой подложки — камера не увидит код на тёмной теме");
    assert.ok(svg.indexOf("<image") < 0 && svg.indexOf("href") < 0, "SVG не должен тянуть внешние ресурсы");

    const q = QR.encode(url, { ecc: "M" });
    const dark = q.modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
    const side = (q.modules.length + 4 * 2) * 4; // тихая зона 4 модуля, модуль 4 единицы
    const rects = svg.match(/<rect[^>]*\/>/g) || [];
    const area = rects
      .filter((r) => r.indexOf("#ffffff") < 0)
      .reduce((n, r) => {
        const w = parseInt(/width="(\d+)"/.exec(r)[1], 10);
        const h = parseInt(/height="(\d+)"/.exec(r)[1], 10);
        return n + (w * h) / 16; // площадь в модулях
      }, 0);
    assert.strictEqual(area, dark, "SVG нарисовал не все тёмные модули");
    assert.ok(svg.indexOf('viewBox="0 0 ' + side + " " + side + '"') > 0, "тихая зона не учтена в размере");
    assert.ok(svg.indexOf('x="' + 4 * 4 + '"') > 0, "нет отступа тихой зоны слева");

    // Картинка, которую рисует интерфейс, обязана быть настоящим QR, а не заглушкой.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(/<script src="qr\.js"><\/script>/.test(html), "qr.js не подключён в разметке");
    assert.ok(html.indexOf('id="mobile-qr"') > 0, "в настройках нет места под QR-код");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

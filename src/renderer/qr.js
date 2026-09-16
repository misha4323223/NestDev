"use strict";

/* ─── QR-код без внешних зависимостей ────────────────────────────────────────
   window.QR.encode(text, opts) → { version, ecc, mask, size, modules }
   window.QR.toSvg(text, opts)   → строка <svg> для вставки в разметку
   window.QR.toText(text, opts)  → матрица строками «#» / «.» (тесты, отладка)

   Зачем свой кодировщик: он нужен, чтобы телефон подключался к приложению одним
   наведением камеры (адрес и PIN — в коде), и при этом приложение остаётся без
   внешних зависимостей: файл едет внутри OTA-бандла, а не приходит через
   npm-установку (иначе обновление по OTA ломало бы запуск без переустановки).

   Что поддерживается: режим байтов (UTF-8) — то, что нужно адресу и PIN; уровни
   коррекции L/M/Q/H; версии 1–10 (этого с запасом хватает на «http://192.168.x.x:9090/#pin=000000»);
   выбор версии и маски — автоматически по правилам ISO/IEC 18004.

   Проверка: тесты сверяют матрицы бит в бит с эталонной реализацией
   (qrcode-generator, Кадзухико Арасэ) для версий 1–10 и всех четырёх уровней —
   это ловит ошибку в любой части: таблицу блоков, Рид—Соломон, раскладку, маску,
   форматную информацию. */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.QR = factory(root);
  }
})(typeof self !== "undefined" ? self : this, function () {
  const MODE_BYTE = 0x4;

  // Уровни коррекции: индекс (0..3) выбирает строку в таблице блоков, а
  // форматная информация кодирует уровень ДРУГИМИ двумя битами (L=01, M=00,
  // Q=11, H=10) — их путать нельзя: код получится нечитаемым.
  const ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  const ECC_BY_INDEX = ["L", "M", "Q", "H"];

  // Таблица блоков из спецификации (ISO/IEC 18004, таблица 13-22): для каждой
  // версии по уровням L, M, Q, H — группы «сколько блоков, всего кодовых слов,
  // кодовых слов данных». Всего кодовых слов в версии = сумма count × total.
  const RS_BLOCKS = {
    1: [[1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9]],
    2: [[1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16]],
    3: [[1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13]],
    4: [[1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9]],
    5: [[1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12]],
    6: [[2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15]],
    7: [[2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14]],
    8: [[2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15]],
    9: [[2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13]],
    10: [[2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16]],
  };
  const MAX_VERSION = 10;

  // Центры выравнивающих узоров по версиям (у версии 1 их нет).
  const ALIGN_POS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  // ── Арифметика поля Галуа GF(256) для Рид—Соломона ─────────────────────────
  // Полином 0x11d — стандарт QR. Таблицы считаем один раз при загрузке.
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  // Порождающий полином степени deg (произведение (x − α^i)).
  function rsGenerator(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  // Кодовые слова коррекции для блока данных: остаток от деления на порождающий.
  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  // ── Байты, шапка данных и битовый поток ────────────────────────────────────
  function utf8Bytes(str) {
    const text = String(str == null ? "" : str);
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i++;
        }
      }
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return out;
  }

  // Блоки для версии и уровня: [count, totalCount, dataCount, ...].
  function blocksOf(version, ecc) {
    const row = RS_BLOCKS[version];
    if (!row) return null;
    return row[ECC_INDEX[ecc] == null ? 1 : ECC_INDEX[ecc]];
  }

  function dataCapacity(version, ecc) {
    const t = blocksOf(version, ecc);
    if (!t) return 0;
    let sum = 0;
    for (let i = 0; i < t.length; i += 3) sum += t[i] * t[i + 2];
    return sum;
  }

  // Сколько бит занимает счётчик длины: для версий 1–9 — 8, с 10-й — 16.
  function countBits(version) {
    return version < 10 ? 8 : 16;
  }

  function pickVersion(byteLen, ecc) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      const needBits = 4 + countBits(v) + byteLen * 8;
      if (needBits <= dataCapacity(v, ecc) * 8) return v;
    }
    return 0;
  }

  // Поток данных: режим, длина, байты, терминатор, выравнивание, добивка.
  function buildDataCodewords(bytes, version, ecc) {
    const capacity = dataCapacity(version, ecc);
    const bits = [];
    const push = (value, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };
    push(MODE_BYTE, 4);
    push(bytes.length, countBits(version));
    for (const b of bytes) push(b, 8);
    const maxBits = capacity * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0); // терминатор
    while (bits.length % 8 !== 0) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      words.push(byte);
    }
    let pad = 0;
    while (words.length < capacity) {
      words.push(pad % 2 === 0 ? 0xec : 0x11);
      pad++;
    }
    return words;
  }

  // Данные + коррекция, перемешанные так, как требует спецификация.
  function buildCodewords(bytes, version, ecc) {
    const table = blocksOf(version, ecc);
    const data = buildDataCodewords(bytes, version, ecc);
    const blocks = []; // { data: [], ec: [] }
    let offset = 0;
    for (let i = 0; i < table.length; i += 3) {
      const count = table[i];
      const total = table[i + 1];
      const dataCount = table[i + 2];
      for (let b = 0; b < count; b++) {
        const chunk = data.slice(offset, offset + dataCount);
        offset += dataCount;
        blocks.push({ data: chunk, ec: rsEncode(chunk, total - dataCount) });
      }
    }
    const out = [];
    const maxData = Math.max.apply(null, blocks.map((b) => b.data.length));
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    const ecLen = blocks.length ? blocks[0].ec.length : 0;
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
  }

  // ── Форматная информация и номер версии (BCH-коды) ─────────────────────────
  function bchDigit(value) {
    let digit = 0;
    let v = value;
    while (v !== 0) {
      digit++;
      v >>>= 1;
    }
    return digit;
  }

  function bchRemainder(value, poly) {
    let v = value;
    while (bchDigit(v) - bchDigit(poly) >= 0) v ^= poly << (bchDigit(v) - bchDigit(poly));
    return v;
  }

  function formatBits(ecc, mask) {
    const data = (ECC_FORMAT_BITS[ecc] == null ? 0 : ECC_FORMAT_BITS[ecc]) << 3 | mask;
    return ((data << 10) | bchRemainder(data << 10, 0x537)) ^ 0x5412;
  }

  function versionBits(version) {
    return (version << 12) | bchRemainder(version << 12, 0x1f25);
  }

  // ── Маски ──────────────────────────────────────────────────────────────────
  function maskAt(mask, row, col) {
    switch (mask) {
      case 0: return (row + col) % 2 === 0;
      case 1: return row % 2 === 0;
      case 2: return col % 3 === 0;
      case 3: return (row + col) % 3 === 0;
      case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      case 7: return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
      default: return false;
    }
  }

  // ── Раскладка ──────────────────────────────────────────────────────────────
  function makeMatrix(version) {
    const size = version * 4 + 17;
    const modules = [];
    const reserved = [];
    for (let i = 0; i < size; i++) {
      modules.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }
    return { version, size, modules, reserved };
  }

  function setFinder(m, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        m.modules[rr][cc] = dark ? 1 : 0;
        m.reserved[rr][cc] = true;
      }
    }
  }

  function setupFunctionPatterns(m) {
    setFinder(m, 0, 0);
    setFinder(m, 0, m.size - 7);
    setFinder(m, m.size - 7, 0);
    // Выравнивающие узоры идут ДО синхронизирующих полос и ставятся во всех
    // сочетаниях координат версии, кроме тех, чей центр уже занят искателем
    // (6×6, 6×последний, последний×6 — у версии 2 остаётся один узор в углу).
    // Полосы потом обходят уже поставленные узоры и НЕ затирают их — иначе
    // пропали бы узоры в середине полосы (v7: 6×22 и 22×6), а без них код
    // читается хуже и матрица расходится с эталоном.
    const pos = ALIGN_POS[m.version] || [];
    for (const row of pos) {
      for (const col of pos) {
        if (m.reserved[row][col]) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            m.modules[row + r][col + c] = dark ? 1 : 0;
            m.reserved[row + r][col + c] = true;
          }
        }
      }
    }
    // Синхронизирующие полосы.
    for (let i = 8; i < m.size - 8; i++) {
      const dark = i % 2 === 0 ? 1 : 0;
      if (!m.reserved[6][i]) {
        m.modules[6][i] = dark;
        m.reserved[6][i] = true;
      }
      if (!m.reserved[i][6]) {
        m.modules[i][6] = dark;
        m.reserved[i][6] = true;
      }
    }
    // Номер версии (с 7-й).
    if (m.version >= 7) {
      const bits = versionBits(m.version);
      for (let i = 0; i < 18; i++) {
        const dark = (bits >> i) & 1;
        const a = Math.floor(i / 3);
        const b = (i % 3) + m.size - 8 - 3;
        m.modules[a][b] = dark;
        m.reserved[a][b] = true;
        m.modules[b][a] = dark;
        m.reserved[b][a] = true;
      }
    }
  }

  // Форматную информацию ставим последней (она опирается на маску).
  function setupFormat(m, ecc, mask) {
    const bits = formatBits(ecc, mask);
    for (let i = 0; i < 15; i++) {
      const dark = (bits >> i) & 1;
      // Левый столбец вокруг верхнего левого искателя.
      if (i < 6) {
        m.modules[i][8] = dark;
        m.reserved[i][8] = true;
      } else if (i < 8) {
        m.modules[i + 1][8] = dark;
        m.reserved[i + 1][8] = true;
      } else {
        m.modules[m.size - 15 + i][8] = dark;
        m.reserved[m.size - 15 + i][8] = true;
      }
      // Верхняя строка и низ правого верхнего искателя.
      if (i < 8) {
        m.modules[8][m.size - i - 1] = dark;
        m.reserved[8][m.size - i - 1] = true;
      } else if (i < 9) {
        m.modules[8][15 - i - 1 + 1] = dark;
        m.reserved[8][15 - i - 1 + 1] = true;
      } else {
        m.modules[8][15 - i - 1] = dark;
        m.reserved[8][15 - i - 1] = true;
      }
    }
    // Тёмный модуль — обязательный элемент рядом с нижним левым искателем.
    m.modules[m.size - 8][8] = 1;
    m.reserved[m.size - 8][8] = true;
  }

  function mapData(m, codewords, mask) {
    let inc = -1;
    let row = m.size - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let col = m.size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // столбец синхронизации пропускаем
      for (;;) {
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (m.reserved[row][cc]) continue;
          let dark = 0;
          if (byteIndex < codewords.length) dark = (codewords[byteIndex] >> bitIndex) & 1;
          if (maskAt(mask, row, cc)) dark = dark ? 0 : 1;
          m.modules[row][cc] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
        row += inc;
        if (row < 0 || row >= m.size) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }

  // ── Оценка маски (правила 1–4 из спецификации) ─────────────────────────────
  function penaltyScore(modules) {
    const size = modules.length;
    let score = 0;
    // Правило 1: подряд идущие одного цвета (каждый прогон ≥ 5 — штраф).
    const runPenalty = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) score += 3 + (run - 5);
            run = 1;
          }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    };
    runPenalty((a, b) => modules[a][b]);
    runPenalty((b, a) => modules[a][b]);
    // Правило 2: блоки 2×2 одного цвета.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
      }
    }
    // Правило 3: узор, похожий на искатель (1:1:3:1:1 с полосой света).
    const pattern1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const pattern2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matches = (line, at, pattern) => {
      for (let i = 0; i < pattern.length; i++) if (line[at + i] !== pattern[i]) return false;
      return true;
    };
    for (let a = 0; a < size; a++) {
      const row = modules[a];
      const col = modules.map((r2) => r2[a]);
      for (let b = 0; b + 11 <= size; b++) {
        if (matches(row, b, pattern1) || matches(row, b, pattern2)) score += 40;
        if (matches(col, b, pattern1) || matches(col, b, pattern2)) score += 40;
      }
    }
    // Правило 4: перекос доли тёмных модулей.
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) dark++;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  function cloneModules(modules) {
    return modules.map((row) => row.slice());
  }

  // ── Публичный API ──────────────────────────────────────────────────────────
  function encode(text, opts) {
    opts = opts || {};
    const ecc = ECC_INDEX[String(opts.ecc || "M").toUpperCase()] == null ? "M" : String(opts.ecc || "M").toUpperCase();
    const bytes = utf8Bytes(text);
    let version = parseInt(opts.version, 10) || 0;
    if (!version) version = pickVersion(bytes.length, ecc);
    if (!version) throw new Error("QR: данные не влезают в версию " + MAX_VERSION + " — сократи текст или понизь уровень коррекции");
    if (version < 1 || version > MAX_VERSION) throw new Error("QR: поддерживаются версии 1–" + MAX_VERSION + ", запрошена " + version);
    const capacity = dataCapacity(version, ecc);
    if (4 + countBits(version) + bytes.length * 8 > capacity * 8) {
      throw new Error("QR: данных больше, чем вмещает версия " + version + " при уровне " + ecc);
    }
    const codewords = buildCodewords(bytes, version, ecc);
    const masks = Number.isFinite(opts.mask) && opts.mask >= 0 && opts.mask <= 7 ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
    let best = null;
    for (const mask of masks) {
      const m = makeMatrix(version);
      setupFunctionPatterns(m);
      setupFormat(m, ecc, mask);
      mapData(m, codewords, mask);
      const score = penaltyScore(m.modules);
      if (!best || score < best.score) best = { mask, score, modules: m.modules };
    }
    return { version, ecc, mask: best.mask, size: best.modules.length, modules: best.modules };
  }

  // Матрица текстом: «#» — тёмный модуль, «.» — светлый (тесты и отладка).
  function toText(text, opts) {
    return encode(text, opts)
      .modules.map((row) => row.map((m) => (m ? "#" : ".")).join(""))
      .join("\n");
  }

  // SVG: светлая подложка и тёмные модули — код должен читаться камерой, поэтому
  // он не подстраивается под тему оформления (на тёмном фоне камеры его не видят).
  function toSvg(text, opts) {
    opts = opts || {};
    const qr = encode(text, opts);
    const quiet = opts.quiet == null ? 4 : Math.max(0, parseInt(opts.quiet, 10) || 0);
    const px = Math.max(1, parseInt(opts.px, 10) || 4); // размер модуля в «единицах» SVG
    const total = qr.size + quiet * 2;
    const side = total * px;
    const parts = [];
    for (let r = 0; r < qr.size; r++) {
      let run = 0;
      for (let c = 0; c <= qr.size; c++) {
        const dark = c < qr.size && qr.modules[r][c] === 1;
        if (dark) {
          run++;
          continue;
        }
        if (run) {
          parts.push('<rect x="' + ((c - run + quiet) * px) + '" y="' + ((r + quiet) * px) + '" width="' + run * px + '" height="' + px + '"/>');
          run = 0;
        }
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + side + '" height="' + side + '" viewBox="0 0 ' + side + " " + side + '" ' +
      'shape-rendering="crispEdges" role="img" aria-label="QR-код для подключения телефона">' +
      '<rect width="' + side + '" height="' + side + '" fill="#ffffff"/>' +
      '<g fill="#000000">' + parts.join("") + "</g></svg>"
    );
  }

  return {
    encode,
    toSvg,
    toText,
    utf8Bytes,
    dataCapacity,
    pickVersion,
    ECC_INDEX,
    ECC_BY_INDEX,
    MAX_VERSION,
  };
});

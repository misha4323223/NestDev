"use strict";
/* ─── Скриншоты: снимок страницы невидимым окном и сохранение на диск ──────────
   Вынесено из src/main.js (часть 36). Это ЕДИНСТВЕННОЕ место в приложении, которое
   создаёт своё окно BrowserWindow под задачу: агент просит «посмотри, что на этой
   странице», окно грузит адрес скрытым, снимает `capturePage` и гаснет.

   Почему модуль, а не оставить в оболочке. У этого кода до сих пор не было ни
   одной прямой проверки: он жил в main.js и вызывался только из инструмента
   (`screenshotCapture` / захват экрана), то есть проверялся косвенно — через
   наборы инструментов с поддельным захватом. А ошибиться тут легко и тихо:
   не снять окно при ошибке (останется висеть), не разжать картинку (уедет в
   vision-модель целиком и съест контекст), сохранить файл в никуда. Поэтому у
   модуля свой набор (test/screens.test.js) и свой живой прогон на НАСТОЯЩЕМ
   Electron (test:live:screens), где окно действительно поднимается и снимается.

   Что принимает: `BrowserWindow` (настоящее окно Electron) и `userDataDir` —
   папку приложения, в которой лежат скриншоты. Ни `app`, ни `electron` модуль
   сам не трогает: иначе его нельзя было бы проверить в обычном Node. */

const fs = require("fs");
const path = require("path");

function createScreens(deps) {
  const { BrowserWindow, userDataDir } = deps || {};

  // Скриншот страницы: невидимое окно, ждём загрузку и отрисовку, снимаем capturePage.
  function screenshotUrl(url) {
    return new Promise((resolve) => {
      let win = null;
      let timer = null;
      const done = (payload) => {
        if (timer) clearTimeout(timer);
        if (win && !win.isDestroyed()) { win.destroy(); win = null; }
        resolve(payload);
      };
      const fail = (msg) => done({ ok: false, err: msg });
      try {
        win = new BrowserWindow({
          show: false,
          width: 1280,
          height: 800,
          // Размер — СТРАНИЦЫ, а не окна: без этого рамка съедала 27 точек и снимок
          // выходил 1280×773 (находка живого прогона test:live:screens), хотя
          // инструмент честно обещает пользователю «снят (1280×800)».
          useContentSize: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
      } catch (e) {
        return fail(e.message);
      }
      timer = setTimeout(() => fail("таймаут загрузки " + url + " (30 с)"), 30000);
      win.webContents.once("did-finish-load", () => {
        setTimeout(async () => {
          try {
            const img = await win.webContents.capturePage();
            const shot = encodeShot(img, {});
            done({ ok: true, dataUrl: "data:" + shot.mime + ";base64," + shot.buf.toString("base64"), mime: shot.mime });
          } catch (e) {
            fail(e.message);
          }
        }, 2500);
      });
      win.webContents.once("did-fail-load", (_e, code, desc) => fail(code + " " + String(desc || "").slice(0, 300)));
      win.loadURL(url).catch((e) => fail(e.message));
    });
  }

  // Сохранение скриншота на диск: скриншоты хранятся в userData/screenshots, чтобы
  // агент мог проанализировать их vision-моделью через analyzeImage(path).
  // Кодирование скриншота: JPEG по умолчанию (быстро, компактно, вдвое дешевле для
  // vision-модели), PNG — по флагу png:true (точные задачи, чтение мелкого текста).
  // Длинная сторона при необходимости ужимается до MAX_SHOT_SIDE.
  const MAX_SHOT_SIDE = 1440;
  function encodeShot(img, args) {
    const a = args || {};
    const wantPng = a.png === true || a.format === "png";
    let out = img;
    try {
      const sz = img.getSize();
      const longest = Math.max(sz.width || 0, sz.height || 0);
      const cap = Math.min(Math.max(parseInt(a.maxWidth, 10) || MAX_SHOT_SIDE, 480), 2560);
      if (longest > cap) {
        const k = cap / longest;
        out = img.resize({ width: Math.max(1, Math.round(sz.width * k)), height: Math.max(1, Math.round(sz.height * k)), quality: "good" });
      }
    } catch {}
    if (!wantPng) {
      try {
        const q = Math.min(Math.max(parseInt(a.quality, 10) || 72, 30), 100);
        const jpg = out.toJPEG(q);
        if (jpg && jpg.length) return { buf: jpg, mime: "image/jpeg", ext: ".jpg" };
      } catch {}
    }
    const png = out.toPNG();
    return { buf: png, mime: "image/png", ext: ".png" };
  }

  // Отметки времени для имён снимков: строго возрастают даже внутри одной
  // миллисекунды (см. saveScreenshotPng).
  let lastShotStamp = 0;
  function nextShotStamp() {
    const now = Date.now();
    lastShotStamp = now > lastShotStamp ? now : lastShotStamp + 1;
    return lastShotStamp;
  }

  // Сохранить скриншот на диск (расширение — по типу картинки). Агент читает его
  // через analyzeImage(path).
  function saveScreenshotPng(buf, baseName, mime) {
    const dir = path.join(userDataDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const ext = String(mime || "").indexOf("jpeg") !== -1 ? ".jpg" : ".png";
    const base = String(baseName || "shot").replace(/[^\w.-]+/g, "_");
    // Имя снимка обязано быть уникальным. Раньше в него шёл один Date.now(), и два
    // снимка в одну миллисекунду (агент снимает несколько адресов подряд — это
    // обычное дело) молча затирали друг друга: модель получала путь, а по нему
    // лежала уже ДРУГАЯ картинка, и вся её работа шла по чужому экрану. Отметка
    // времени строго растёт внутри процесса, а файл, оставшийся с прошлого запуска
    // приложения, сдвигает имя на шаг вперёд — потеря снимка не тихая, а невозможная.
    let file = "";
    do {
      file = path.join(dir, base + "-" + nextShotStamp() + ext);
    } while (fs.existsSync(file));
    fs.writeFileSync(file, buf);
    return file;
  }

  return { screenshotUrl, encodeShot, saveScreenshotPng, MAX_SHOT_SIDE };
}

module.exports = { createScreens };

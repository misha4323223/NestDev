"use strict";
/* ─── Живой прогон скриншотов: НАСТОЯЩЕЕ невидимое окно Electron ───────────────
   Запуск: bun run test:live:screens    (node scripts/live-screens.js)

   Зачем этот прогон, если есть test/screens.test.js. Набор проверяет логику на
   поддельном окне и поддельной картинке: он видит, что окно создаётся скрытым,
   что таймауты стоят, что окно гасится, что байты правильно кладутся в файл.
   Но самое рискованное место модуля подделкой не проверить вообще: нативный
   кодек Electron (toJPEG/toPNG/resize) и настоящая отрисовка страницы в
   скрытом окне. Ошибка там тихая — приложение работает, а в vision-модель
   уезжает пустая картинка или «скриншот» чужого размера.

   Поэтому здесь поднимается настоящий Electron, настоящий src/screens.js,
   настоящий скрытый BrowserWindow и настоящая страница на локальном сервере.
   Проверяется то, что видно только на живом коде:

     [1] страница действительно загрузилась и отрисовалась — цвет пикселя по
         центру снимка совпадает с цветом страницы;
     [2] снимок — настоящий JPEG, который Electron умеет разобрать обратно;
     [3] png:true даёт настоящий PNG, а ужатие сохраняет пропорции;
     [4] файл на диске читается как картинка и совпадает со снимком побайтно;
     [5] после снимка не остаётся ни одного лишнего окна;
     [6] неудачная загрузка приходит ошибкой сразу, а не по 30-секундному
         таймауту — и окно после неё тоже погашено.

   Проводка в main.js (какие имена откуда берутся) стережётся отдельно:
   страж связи test/backend-wiring.js и запуск настоящего приложения
   (test:boot, test:live:desktop) — если бы оболочка передала модулю не то,
   приложение не поднялось бы.

   Linux: нужен Xvfb (ставится вместе с playwright). Windows/macOS — без него. */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function hasXvfb() {
  return spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" }).status === 0;
}

// Страница, которую снимаем: сплошной цвет во весь экран и подпись в углу.
// Цвет выбран так, чтобы его нельзя было получить «по умолчанию» — белым или
// чёрным снимком такая проверка не пройдёт.
const PAGE_COLOR = "rgb(225, 29, 72)";
const pageHtml =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Страница для снимка</title></head>" +
  "<body style=\"margin:0;background:" + PAGE_COLOR + ";width:100vw;height:100vh\">" +
  "<h1 style=\"position:absolute;left:8px;top:8px;margin:0;font:16px sans-serif;color:#fff\">Страница для снимка</h1>" +
  "</body></html>";

// Что выполняется ВНУТРИ Electron. Пути приходят переменными окружения, чтобы
// прогон не правил ни один файл репозитория.
const ENTRY = `
"use strict";
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const { createScreens } = require(process.env.SCREENS_PATH);

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \\u2705 " : "  \\u274c ") + msg);
  if (!cond) failures++;
};

const screens = createScreens({ BrowserWindow, userDataDir: process.env.USER_DATA });
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const windows = () => BrowserWindow.getAllWindows().length;

app.whenReady().then(async () => {
  console.log("\\n[1] Настоящее невидимое окно и настоящая страница");
  const t0 = Date.now();
  const shot = await screens.screenshotUrl(process.env.PAGE_URL);
  const took = Date.now() - t0;
  ok(shot.ok === true, "страница снята за " + took + " мс" + (shot.ok ? "" : ": " + shot.err));
  if (!shot.ok) {
    console.log("\\nЖИВОЙ ПРОГОН: падения есть");
    return app.exit(1);
  }
  ok(/^data:image\\/jpeg;base64,/.test(shot.dataUrl), "снимок отдан JPEG по умолчанию (mime " + shot.mime + ")");
  const buf = Buffer.from(String(shot.dataUrl).split(",")[1], "base64");
  ok(buf.slice(0, 3).equals(JPEG_MAGIC), "внутри действительно JPEG (" + buf.length + " байт)");

  const img = nativeImage.createFromDataURL(shot.dataUrl);
  ok(!img.isEmpty(), "Electron разбирает снимок обратно в картинку");
  const sz = img.getSize();
  ok(sz.width === 1280 && sz.height === 800, "размер снимка 1280×800 (а не " + sz.width + "×" + sz.height + ")");

  // Пиксель по центру: подпись стоит в углу, поэтому центр — цвет страницы.
  const bmp = img.toBitmap();
  const at = (Math.floor(sz.height / 2) * sz.width + Math.floor(sz.width / 2)) * 4;
  const b = bmp[at];
  const g = bmp[at + 1];
  const r = bmp[at + 2];
  ok(r > 150 && g < 90 && b < 120, "страница отрисовалась (центр rgb " + r + "," + g + "," + b + ", ждали 225,29,72)");

  console.log("\\n[2] Настоящий кодек: PNG по флагу и ужатие картинки");
  const png = screens.encodeShot(img, { png: true });
  ok(png.mime === "image/png" && png.buf.slice(0, 4).equals(PNG_MAGIC), "png:true даёт настоящий PNG (" + png.buf.length + " байт)");
  ok(png.buf.length > buf.length, "PNG тяжелее JPEG — значит JPEG действительно сжимал");
  const small = screens.encodeShot(img, { maxWidth: 480 });
  const smallImg = nativeImage.createFromBuffer(small.buf);
  const ssz = smallImg.getSize();
  ok(Math.abs(ssz.width - 480) <= 2 && Math.abs(ssz.height - 300) <= 2, "ужатие до 480 сохранило пропорции (" + ssz.width + "×" + ssz.height + ")");
  const asIs = screens.encodeShot(img, { maxWidth: 4000 });
  const asIsSize = nativeImage.createFromBuffer(asIs.buf).getSize();
  ok(asIsSize.width === 1280 && asIsSize.height === 800, "маленькая картинка не растягивается (" + asIsSize.width + "×" + asIsSize.height + ")");

  console.log("\\n[3] Файл на диске: расширение по типу и побайтное совпадение");
  const jpg = screens.saveScreenshotPng(buf, "page", shot.mime);
  ok(fs.existsSync(jpg) && /\\.jpg$/.test(jpg), "снимок лёг в userData/screenshots как " + path.basename(jpg));
  const back = nativeImage.createFromPath(jpg);
  ok(!back.isEmpty() && back.getSize().width === 1280, "файл читается обратно как картинка 1280 по ширине");
  ok(fs.readFileSync(jpg).equals(buf), "файл совпадает со снимком побайтно");
  const pngFile = screens.saveScreenshotPng(png.buf, "page", "image/png");
  ok(/\\.png$/.test(pngFile) && fs.readFileSync(pngFile).slice(0, 4).equals(PNG_MAGIC), "PNG сохранён как PNG (" + path.basename(pngFile) + ")");
  ok(path.dirname(jpg) === path.join(process.env.USER_DATA, "screenshots"), "папка снимков — userData/screenshots");

  console.log("\\n[4] Окно не остаётся висеть");
  ok(windows() === 0, "после снимка открытых окон: " + windows());

  console.log("\\n[5] Неудачная загрузка: причина сразу, а не по таймауту");
  const t1 = Date.now();
  const bad = await screens.screenshotUrl(process.env.DEAD_URL);
  const tookBad = Date.now() - t1;
  ok(bad.ok === false && !!bad.err, "отказ отдан ошибкой: " + String(bad.err).slice(0, 90));
  ok(tookBad < 20000, "отказ пришёл за " + tookBad + " мс (не по 30-секундному таймауту)");
  ok(windows() === 0, "после отказа открытых окон: " + windows());

  console.log("\\nЖИВОЙ ПРОГОН: " + (failures ? failures + " падений" : "всё чисто"));
  app.exit(failures ? 1 : 0);
}).catch((e) => {
  console.log("  \\u274c прогон упал: " + ((e && e.stack) || e));
  console.log("\\nЖИВОЙ ПРОГОН: падения есть");
  app.exit(1);
});
`;

(async () => {
  const electronBin = path.join(ROOT, "node_modules", "electron", "dist", "electron");
  const electronExe = process.platform === "win32" ? electronBin + ".exe" : electronBin;
  if (!fs.existsSync(electronExe)) {
    console.error("✗ Нет Electron. Установи зависимости: bun install");
    process.exit(2);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-screens-"));
  const userData = path.join(work, "userdata");
  const pagePort = await freePort();
  const deadPort = await freePort(); // никто не слушает: отказ соединения

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageHtml);
  });
  await new Promise((r) => srv.listen(pagePort, "127.0.0.1", r));
  console.log("\n[1] Локальная страница: http://127.0.0.1:" + pagePort + "/  (отказ: порт " + deadPort + ")");

  const entry = path.join(work, "entry.js");
  fs.writeFileSync(entry, ENTRY);

  const useXvfb = process.platform === "linux" && hasXvfb();
  if (process.platform === "linux" && !useXvfb) {
    console.error("✗ Нет xvfb-run — на Linux без дисплея окно не поднять: npx playwright install --with-deps chromium");
    srv.close();
    process.exit(2);
  }
  const args = [
    electronExe,
    entry,
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--user-data-dir=" + userData,
  ];
  const cmd = useXvfb ? "xvfb-run" : electronExe;
  const cmdArgs = useXvfb ? ["-a", "-s", "-screen 0 1440x900x24", ...args] : args.slice(1);

  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    // Свой OTA-корень: приложение в этом прогоне не поднимается, но пусть ни одна
    // ветка кода не смотрит в локальную папку ota/.
    env: Object.assign({}, process.env, {
      SCREENS_PATH: path.join(ROOT, "src", "screens.js"),
      USER_DATA: userData,
      PAGE_URL: "http://127.0.0.1:" + pagePort + "/",
      DEAD_URL: "http://127.0.0.1:" + deadPort + "/",
      AI_AGENT_OTA_ROOT: path.join(work, "ota"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // убиваем дерево, а не только обёртку xvfb-run
  });

  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
    process.stdout.write(d);
  });
  child.stderr.on("data", (d) => {
    out += d;
  });

  const killApp = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => {
    console.error("\n✗ прогон не закончился за 180 с — гашу");
    killApp();
  }, 180000);

  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  srv.close();

  const marked = out.match(/(✅|❌)/g) || [];
  const passed = marked.filter((m) => m === "✅").length;
  const failedCount = marked.filter((m) => m === "❌").length;
  if (failedCount || code !== 0) {
    console.error("\n✗ живые проверки скриншотов: " + failedCount + " падений (код выхода " + code + ")");
    process.exit(1);
  }
  if (!passed) {
    console.error("\n✗ ни одна проверка не выполнилась (код выхода " + code + ")");
    process.exit(1);
  }
  console.log("\nЖивые проверки скриншотов: " + passed + " ✅ / 0 ❌");
})();

"use strict";

/* ─── Быстрый запуск проекта (превью): каналы dev:* ───────────────────────────
   Раньше стоял в main.js (этап B, часть 31): сам запуск dev-сервера проекта,
   остановка с освобождением порта, статус и автоопределение команды по
   package.json. Здесь же теперь живёт и состояние запуска (devRun) — раньше оно
   было переменной оболочки, но, кроме этого блока, его никто не читал, а
   единственное касание извне (остановка при выходе приложения) вынесено наружу
   функцией devShutdown().

   Что здесь ошибается тихо:

     • окно больше не получает вывод сервера — devEmit печатает в лог превью и
       консоль; поэтому окно приходит ФУНКЦИЕЙ (getWindow): оно создаётся позже
       сборки модуля и может быть пересоздано, а копия «застыла» бы на null;
     • порт остаётся занят после остановки: процесс мог быть запущен агентом
       (startBackground / runCommandOutput для сервера) или пережить прошлый
       запуск, поэтому devStop освобождает и порт из настроек, а не только свой
       процесс;
     • «Проект уже запущен» вместо запуска второго сервера: два dev-сервера на
       одном порту — это непонятная ошибка запуска у человека.

   Настройки читаются в момент вызова (previewUrl нужен при остановке), а
   зависимости (запуск процессов, освобождение порта, обрезка ANSI) приходят из
   оболочки — своих копий модуль не держит. */

function registerPreviewIpc(deps) {
  const {
    ipcMain,
    fs,
    path,
    loadSettings,
    sanitizeDir,
    agentWorkDir,
    bgSpawn,
    bgKill,
    stripAnsi,
    parsePortFromUrl,
    killProcessesOnPort,
    getWindow,
  } = deps;

// ─────────────────────────── Быстрый запуск проекта (превью) ───────────────────────────
// Пользователь сам запускает dev-сервер проекта и останавливает его (освобождая порт).
let devRun = null; // { rec, command, cwd }

function devEmit(ev) {
  const win = getWindow ? getWindow() : null;
  if (win && !win.isDestroyed()) win.webContents.send("dev:event", ev);
}

// Автоопределение команды запуска по package.json проекта.
function detectDevCommand(dir) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {}
  const scripts = (pkg && pkg.scripts) || {};
  const hasBun =
    fs.existsSync(path.join(dir, "bun.lockb")) ||
    fs.existsSync(path.join(dir, "bun.lock")) ||
    fs.existsSync(path.join(dir, "bunfig.toml"));
  if (scripts.dev) return hasBun ? "bun run dev" : "npm run dev";
  if (scripts.start) return hasBun ? "bun run start" : "npm start";
  if (scripts.serve) return "npm run serve";
  return "";
}

function devStart(dir, command) {
  const d = sanitizeDir(dir) || agentWorkDir(loadSettings());
  if (!d || !fs.existsSync(d)) return { ok: false, error: "Папка проекта не найдена" };
  if (devRun && devRun.rec && !devRun.rec.exited) {
    return { ok: false, error: "Проект уже запущен — сначала останови его (⏹)." };
  }
  const cmd = String(command || "").trim() || detectDevCommand(d);
  if (!cmd) return { ok: false, error: "Не найден скрипт запуска (dev/start в package.json). Укажи команду вручную." };
  let rec;
  try {
    rec = bgSpawn(cmd, { cwd: d, name: "dev:" + cmd.slice(0, 50) });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  devRun = { rec, command: cmd, cwd: d };
  const push = (chunk) => devEmit({ type: "out", text: stripAnsi(chunk.toString()) });
  rec.child.stdout.on("data", push);
  rec.child.stderr.on("data", push);
  rec.child.on("exit", (code) => {
    if (devRun && devRun.rec === rec) devRun = null;
    devEmit({ type: "exit", code });
  });
  rec.child.on("error", (e) => {
    if (devRun && devRun.rec === rec) devRun = null;
    devEmit({ type: "exit", code: null, error: e.message });
  });
  devEmit({ type: "start", command: cmd, cwd: d });
  return { ok: true, command: cmd, cwd: d };
}

async function devStop() {
  const stopped = [];
  if (devRun && devRun.rec && !devRun.rec.exited) {
    const rec = devRun.rec;
    devRun = null;
    bgKill(rec);
    stopped.push(rec.name || rec.command);
  }
  // Порт тоже освобождаем: процесс мог быть запущен агентом (startBackground /
  // runCommandOutput для сервера) или остаться сиротой от прошлого запуска.
  const port = parsePortFromUrl(loadSettings().previewUrl);
  if (port) {
    const r = await killProcessesOnPort(port);
    if (r && r.ok && r.killed && r.killed.length) stopped.push("порт " + port + " (PID " + r.killed.join(", ") + ")");
  }
  if (!stopped.length) return { ok: false, error: "Проект не запущен (процесс и порт свободны)" };
  devEmit({ type: "stopped" });
  return { ok: true, stopped };
}

function devStatus(dir) {
  if (devRun && devRun.rec && devRun.rec.exited) devRun = null;
  const d = sanitizeDir(dir) || agentWorkDir(loadSettings());
  return {
    ok: true,
    running: !!(devRun && devRun.rec && !devRun.rec.exited),
    command: devRun ? devRun.command : "",
    cwd: devRun ? devRun.cwd : "",
    detected: d && fs.existsSync(d) ? detectDevCommand(d) : "",
  };
}

// Остановка запущенного превью при выходе приложения: раньше это делала оболочка
// (before-quit), теперь состояние живёт здесь, поэтому наружу отдаётся одна
// функция. Процесс dev-сервера не должен переживать закрытие окна — он держит порт.
function devShutdown() {
  if (!devRun) return;
  const rec = devRun.rec;
  devRun = null;
  bgKill(rec);
}

ipcMain.handle("dev:start", (_e, dir, command) => devStart(dir, command));
ipcMain.handle("dev:stop", () => devStop());
ipcMain.handle("dev:status", (_e, dir) => devStatus(dir));

  return { devShutdown };
}

module.exports = { registerPreviewIpc };

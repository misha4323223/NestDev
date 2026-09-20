"use strict";

/* ─── Фоновые процессы, постоянные оболочки и dev-серверы ─────────────────────
   Вынесено из main.js (этап B, часть 9). Здесь всё, что живёт МЕЖДУ вызовами
   инструментов и держит порт:

     • bgSpawn / bgKill / bgPushLines — запуск длительной команды (dev-сервер, watch,
       постоянная оболочка), накопление вывода в кольцевом буфере (последняя тысяча
       строк) и остановка вместе со ВСЕМ деревом процессов;
     • killProcessTree — почему не child.kill(): на Windows он убивает только cmd.exe,
       а node/expo-сирота остаётся и держит порт, и следующая попытка запуска падает
       с «порт занят»;
     • SERVER_CMD_RE — распознавание команд, которые не завершаются сами (сознательно
       НЕ ловим «vite build» и «npm run build»: это короткие команды);
     • bgWaitFor / waitOutputQuiet / bgTail — ожидание маркера в выводе, ожидание
       «затишья» и хвост вывода для ответа агенту;
     • parsePortFromUrl / parsePortOwners / killProcessesOnPort — освобождение порта,
       который занят предыдущим запуском (разбор вывода lsof и fuser построчный: иначе
       в список «PID» попадали номер порта и «127.0.0.1», и кнопка «Остановить» могла
       погасить посторонний процесс);
     • checkUrlStatus — живая HTTP-проверка адреса превью (статус, тип, начало тела).

   Живого состояния оболочки здесь нет: карта запущенных процессов и счётчик имён
   нужны только этому модулю. Карта отдаётся наружу тем же объектом (не копией),
   поэтому закрытие приложения по-прежнему гасит все фоновые процессы. */

function createBgProcesses(deps) {
  const { spawn, os, stripAnsi, shellArgsFor, commandEnv, runTerminalCommand } = deps;
  // «Кто убивает» вынесено в зависимость: разбор вывода поиска слушателей можно
  // проверить подставным убийцей, не посылая настоящих сигналов чужим процессам.
  const killPid = deps.killPid || ((pid) => process.kill(pid, "SIGTERM"));

// Процессы живут между вызовами инструментов; вывод копится в кольцевой буфер.
const bgProcesses = new Map();
let bgSeq = 0;

function bgPushLines(rec, chunk) {
  const lines = stripAnsi(chunk.toString()).split("\n");
  for (const l of lines) rec.output.push(l);
  if (rec.output.length > 1000) rec.output.splice(0, rec.output.length - 1000);
}

function bgSpawn(command, opts) {
  opts = opts || {};
  const isWin = process.platform === "win32";
  const shell = opts.shell || (isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh");
  const args = opts.shellArgs || shellArgsFor(command);
  const child = spawn(shell, args, {
    cwd: opts.cwd || os.homedir(),
    detached: !isWin,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: commandEnv(command),
  });
  const rec = {
    id: "bg" + (++bgSeq).toString(36) + "-" + Date.now().toString(36),
    command: String(command || ""),
    name: opts.name || String(command || "").slice(0, 60),
    cwd: opts.cwd || os.homedir(),
    startedAt: Date.now(),
    output: [],
    exited: false,
    exitCode: null,
    child,
  };
  bgProcesses.set(rec.id, rec);
  child.stdout.on("data", (d) => bgPushLines(rec, d));
  child.stderr.on("data", (d) => bgPushLines(rec, d));
  child.on("exit", (code) => { rec.exited = true; rec.exitCode = code; });
  child.on("error", (e) => { rec.exited = true; rec.error = e.message; });
  return rec;
}

function bgKill(rec) {
  if (!rec || !rec.child) return;
  const pid = rec.child.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1200);
    }
  } catch {}
  try { rec.child.kill(); } catch {}
}

// ─────────────────────────── Dev-серверы: распознавание и освобождение порта ───────────────────────────
// Команды, похожие на запуск длительного dev-сервера (не завершаются сами по себе).
// Сознательно НЕ ловим «vite build» и «npm run build» — это короткие команды.
const SERVER_CMD_RE =
  /(?:^|[\s;&|])(?:npx\s+)?expo\s+start\b|(?:^|[\s;&|])(?:npm|npx|bun|yarn|pnpm)\s+run\s+(dev|dev:[\w:.-]+|start|start:[\w:.-]+|serve|watch|preview)\b|(?:^|[\s;&|])(?:npm|bun|yarn|pnpm)\s+(start|serve|dev)\b|(?:^|[\s;&|])vite\b(?!\s+(build|optimize)\b)|(?:^|[\s;&|])next\s+dev\b|(?:^|[\s;&|])ng\s+serve\b|(?:^|[\s;&|])nodemon\b|(?:^|[\s;&|])tsx\s+watch\b|(?:^|[\s;&|])uvicorn\b|(?:^|[\s;&|])gunicorn\b|(?:^|[\s;&|])dotnet\s+run\b|(?:^|[\s;&|])flutter\s+run\b|(?:^|[\s;&|])(?:node|bun)\s+\S*(server|app|index|main)\.(js|ts|mjs|cjs)\b|(?:^|[\s;&|])python3?\s+\S*manage\.py\s+runserver\b/i;

// Убивает процесс вместе со ВСЕМ деревом (Windows — taskkill /T /F, иначе — группа процессов).
// Простой child.kill() на Windows убивает только cmd.exe, а node/expo-дети остаются и держат порт.
function killProcessTree(child) {
  const pid = child && child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1200);
    }
  } catch {}
  try { child.kill(); } catch {}
}

// Ждёт появления маркера в выводе фонового процесса (не убивая его и не дожидаясь выхода).
function bgWaitFor(rec, needle, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (needle && rec.output.join("\n").includes(needle)) return resolve({ matched: true });
      if (rec.exited) return resolve({ matched: false, exited: true, code: rec.exitCode });
      if (Date.now() - t0 > (timeoutMs || 120000)) return resolve({ matched: false, timedOut: true });
      setTimeout(tick, 300);
    };
    tick();
  });
}

// Достаёт порт из URL вида http://localhost:5000/path.
function parsePortFromUrl(url) {
  const m = String(url || "").match(/:(\d{1,5})(\/|$)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Разбирает вывод поиска слушателей порта в список PID — строго построчно.
//   • lsof -ti tcp:<порт> печатает по ОДНОМУ PID в строке («12345»);
//   • fuser <порт>/tcp печатает строку «<порт>\/<протокол>:   PID PID», где PID идут
//     ПОСЛЕ двоеточия, а число до слэша — это сам порт, а не процесс.
// Всё остальное (объяснения, адреса вида 127.0.0.1:5199, ошибки оболочки) PID не даёт:
// раньше из текста брались ВСЕ числа, поэтому в «убитые» попадали порт и 127.0.0.1.
function parsePortOwners(out) {
  const pids = [];
  for (const raw of String(out == null ? "" : out).split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (!line) continue;
    const fuser = line.match(/^\d+\/[^\s:]+:\s*(\S.*)$/);
    if (fuser) {
      for (const tok of fuser[1].trim().split(/\s+/)) if (/^\d+$/.test(tok)) pids.push(tok);
      continue;
    }
    // lsof-строка: в ней ровно одно число и ничего больше. Заголовки и текст отсекаются.
    if (/^\d+$/.test(line)) pids.push(line);
  }
  return [...new Set(pids)].filter((x) => Number(x) > 1);
}

// Находит процессы, слушающие порт, и убивает их (освобождает порт).
async function killProcessesOnPort(port) {
  const p = parseInt(port, 10);
  if (!p || p < 1 || p > 65535) return { ok: false, error: "Некорректный порт: " + port };
  const killed = [];
  if (process.platform === "win32") {
    const out = await runTerminalCommand("netstat -ano -p tcp", os.homedir(), 15000);
    const pidSet = new Set();
    for (const line of String(out).split("\n")) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      const pid = parts[parts.length - 1] || "";
      const pm = local.match(/:(\d{1,5})$/);
      if (pm && pm[1] === String(p) && /^\d+$/.test(pid)) pidSet.add(pid);
    }
    for (const pid of pidSet) {
      await new Promise((r) => {
        const k = spawn("taskkill", ["/pid", pid, "/T", "/F"], { windowsHide: true });
        k.on("close", () => r());
        k.on("error", () => r());
      });
      killed.push(pid);
    }
  } else {
    const out = await runTerminalCommand("lsof -ti tcp:" + p + " 2>/dev/null || fuser " + p + "/tcp 2>/dev/null", os.homedir(), 15000);
    for (const pid of parsePortOwners(out)) {
      try { killPid(Number(pid)); } catch {}
      killed.push(pid);
    }
  }
  return { ok: killed.length > 0, killed };
}

// Ждём, пока вывод процесса «затихнет» (для shellSend: команда отработала).
function waitOutputQuiet(rec, maxMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let lastLen = rec.output.length;
    const tick = () => {
      if (rec.exited || Date.now() - t0 > (maxMs || 6000)) return resolve();
      if (rec.output.length !== lastLen) {
        lastLen = rec.output.length;
        return setTimeout(tick, 150);
      }
      if (Date.now() - t0 > 700) return resolve();
      setTimeout(tick, 150);
    };
    setTimeout(tick, 250);
  });
}

function bgTail(rec, lines) {
  const n = Math.min(Math.max(lines || 50, 1), 500);
  return rec.output.slice(-n).join("\n");
}

// Проверка HTTP(S)-URL: статус, заголовки, начало тела.
async function checkUrlStatus(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "AI-Developer-Agent" },
    });
    const body = await res.text().catch(() => "");
    const ct = res.headers.get("content-type") || "";
    const head = body.replace(/\s+/g, " ").trim().slice(0, 400);
    const lines = [
      "URL: " + url,
      "Статус: " + res.status + " " + (res.statusText || ""),
      "Content-Type: " + ct,
      "Размер тела: " + body.length + " символов",
    ];
    if (head) lines.push("Начало тела: " + head);
    return lines.join("\n");
  } catch (e) {
    return "Ошибка: сервер не ответил — " + (e.name === "AbortError" ? "таймаут 8 с" : e.message);
  } finally {
    clearTimeout(timer);
  }
}
  return {
    bgProcesses,
    bgSpawn,
    bgKill,
    killProcessTree,
    bgWaitFor,
    parsePortFromUrl,
    parsePortOwners,
    killProcessesOnPort,
    waitOutputQuiet,
    bgTail,
    checkUrlStatus,
    SERVER_CMD_RE,
  };
}

module.exports = { createBgProcesses };

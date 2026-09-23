"use strict";

/* ─── Системные программы и окружение ─────────────────────────────────────────
   Раньше раздел жил внутри main.js, рядом с окном, IPC и деплоем. Здесь только
   система: PATH и его слияние, поиск программ (=инструмент canExecute),
   запуск процессов с разбором кодов выхода (`spawnRaw` — в СВОЕЙ группе процессов,
   чтобы таймаут гасил дерево, а не одну оболочку; `explainExit`),
   живая сессия PowerShell с коротким кэшем справок (`psScript`, `cachedPs`,
   `refreshEnvFromOS`), установка пакетов системными менеджерами
   (`installSystemPkg`), загрузка файлов и архивов (`downloadFileTo`,
   `downloadAndExtractTo`), поиск установщиков в архиве (`findInstallersIn`)
   и запуск с правами администратора (`runAsAdmin`).

   Тело перенесено ПОБАЙТОВО (скрипт извлечения сверял круг «туда-обратно»),
   поэтому поведение не менялось ни на строку.

   Окружение агента (`agentEnv`) — живое значение: main.js пересобирает его при
   смене настроек и прав Yandex Cloud. Копия «застыла» бы на пустом объекте, и
   команды перестали бы получать токены и PATH, поэтому модуль читает его в
   момент запуска процесса.

   Зависимости приходят аргументами (та же конвенция, что у createYcService,
   createDeployEngine и createAgentTools): модуль чистый и проверяется в plain-node. */

const crypto = require("crypto");

function createSystemStack(deps) {
  const { fs, path, os, spawn, winPs, probeEnv, stripAnsi, runTerminalCommand, live } = deps;
  // Кто гасит дерево процессов — той же подстановкой, что у оболочек (shell-tools):
  // иначе сторож не проверит ветку таймаута, не посылая сигналов чужим процессам.
  // По умолчанию — настоящий убийца группы (killCommandTree ниже).
  const killTree = deps.killTree || killCommandTree;

// ═══════════════════ Системные программы и окружение ═══════════════════
// Получить PATH (пробы секретов не получают) — на Windows ключ может быть «Path».
function envPathInfo() {
  const e = probeEnv();
  const key = Object.keys(e).find((k) => k.toLowerCase() === "path");
  return { e, key, value: key ? String(e[key] || "") : "" };
}

function setMergedPath(before, extra) {
  const parts = [];
  const push = (v) => {
    for (const seg of String(v || "").split(path.delimiter)) {
      const t = seg.trim();
      if (t && !parts.includes(t)) parts.push(t);
    }
  };
  push(before);
  push(extra);
  process.env.PATH = parts.join(path.delimiter);
  return parts;
}

// Поиск исполняемого файла: PATH (+ PATHEXT на Windows) + типовые места установки.
function findProgram(name) {
  const prog = String(name || "").trim();
  if (!prog) return { found: false, reason: "Пустое имя программы" };
  if (prog.includes("/") || prog.includes("\\")) {
    const abs = path.resolve(prog);
    if (fs.existsSync(abs)) return { found: true, path: abs };
    return { found: false, reason: "Не найден файл: " + abs };
  }
  const { e, value } = envPathInfo();
  const dirs = (value || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? String(e.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const cands = [];
  for (const d of dirs) {
    for (const ext of exts) {
      const cand = path.join(d, prog + (ext || ""));
      if (!cands.includes(cand)) cands.push(cand);
    }
  }
  if (process.platform === "win32") {
    const home = e.USERPROFILE || "";
    const pf = e.ProgramFiles || "C:\\Program Files";
    const known = {
      git: [path.join(pf, "Git", "cmd", "git.exe"), path.join(home, "AppData", "Local", "Programs", "Git", "cmd", "git.exe")],
      node: [path.join(pf, "nodejs", "node.exe")],
      python: [path.join(home, "AppData", "Local", "Programs", "Python", "python.exe")],
      code: [path.join(home, "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe")],
    };
    for (const k of Object.keys(known)) {
      if (prog.toLowerCase() === k || prog.toLowerCase().startsWith(k + ".") || prog.toLowerCase().startsWith(k + " ")) {
        cands.push(...known[k]);
      }
    }
  }
  for (const cand of cands) {
    try {
      if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) return { found: true, path: cand };
    } catch {}
  }
  return { found: false, reason: "«" + prog + "» не найден в PATH" + (process.platform === "win32" ? " и в типовых местах установки" : "") };
}

// ── Запуск команд в СВОЕЙ группе процессов ────────────────────────────────
// Одна точка правды о запуске системного раздела. Здесь раньше стоял execFile:
// он МОЛЧА игнорирует `detached` (сам собирает опции для spawn), своей группы у
// команды не было, и по таймауту умирала одна оболочка — дети (shell внутри winget,
// tar с детьми, powershell с детьми) оставались жить и держали порт, а в фоновых
// процессах их не было — остановить их было нечем. Тот же класс, что закрыт у
// runCommand (shell-tools, заход 4.1) и runCapture (деплой, фаза 1 поиска ошибок).
// Предел вывода теперь наш, а не maxBuffer: сверх него команда гасится ДЕРЕВОМ.
const MAX_RUN_BYTES = 16 * 1024 * 1024;
const RUN_FALLBACK_MS = 1500; // во сколько отвечаем после гашения, если «close» не пришёл

// Гасит команду ВМЕСТЕ С ДЕТЬМИ: у неё своя группа (detached), сигнал уходит
// группе целиком. Обычный child.kill() бьёт только саму команду, а её дети
// остаются жить. На Windows группы процессов свои — там дерево гасит taskkill /T /F.
function killCommandTree(child) {
  const pid = child && child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1200);
    }
  } catch {}
  try { child.kill(); } catch {}
}

// Запуск и сбор вывода. Возвращает ПОТОКИ и причину (таймаут, переполнение,
// отказ запуска), а как превратить их в ответ — решает зовущий: у spawnRaw и
// runProgVersion своя форма отказа, и смешивать их нельзя.
function runGroup(file, args, o) {
  const opt = o || {};
  const limit = Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : 60000;
  const maxBytes = Number(opt.maxBytes) > 0 ? Number(opt.maxBytes) : MAX_RUN_BYTES;
  return new Promise((resolve) => {
    const outChunks = [];
    const errChunks = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let child = null;
    let timer = null;
    // Один выход на все ветки: завершение, отказ запуска, предел вывода, таймаут.
    // Без него промис мог бы не разрешиться никогда — а это хуже любого отказа.
    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: code == null ? null : code,
        signal: signal || null,
        timedOut,
        overflow,
        spawnError,
        limitMs: limit,
        // Буферы склеиваем уже здесь: посимвольная расшифровка кусками ломала бы
        // многобайтовую кириллицу на границе чанков.
        out: Buffer.concat(outChunks).toString("utf8"),
        err: Buffer.concat(errChunks).toString("utf8"),
      });
    };
    try {
      child = spawn(file, args, {
        cwd: opt.cwd, // не задан = унаследовать, как у прежнего execFile
        env: opt.env,
        // Своя группа — условие, по которому таймаут гасит ДЕРЕВО (ловушка 5).
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // spawn бросает на негодных опциях (например, кривой cwd) — событие "error"
      // уже не будет, и без этого ответа промис вис бы навсегда.
      spawnError = e;
      done(null, null);
      return;
    }
    const collect = (arr) => (chunk) => {
      if (overflow) return;
      arr.push(chunk);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        killTree(child);
      }
    };
    if (child.stdout) child.stdout.on("data", collect(outChunks));
    if (child.stderr) child.stderr.on("data", collect(errChunks));
    // Отказ запуска (ENOENT у бинаря) приходит событием, а не кодом возврата.
    child.on("error", (e) => { spawnError = e; done(null, null); });
    child.on("close", (code, signal) => done(code, signal));
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Оболочка может не отреагировать на SIGTERM (или её уже нет): отвечаем не
      // позже чем через полторы секунды — к тому времени группе ушёл SIGKILL.
      // Таймер намеренно НЕ unref: обещание обязано быть разрешено.
      setTimeout(() => done(null, null), RUN_FALLBACK_MS);
    }, limit);
  });
}

function runProgVersion(bin) {
  return runGroup(bin, ["--version"], {
    timeoutMs: 8000,
    maxBytes: 1024 * 1024,
    env: probeEnv(),
  }).then((g) => {
    // Договор прежний (execFile, байт в байт): текстом идёт stdout плюс stderr
    // и РОВНО первая строка; если вывода нет (бинаря нет) — пустая строка, а не
    // текст ошибки запуска: потребители (checkInstalledProgram) читают версию.
    const text = stripAnsi((g.out || "") + "\n" + (g.err || "")).trim();
    return text ? text.split("\n")[0].slice(0, 180) : "";
  });
}

function spawnRaw(args, opts) {
  const o = opts || {};
  const limit = o.timeoutMs || 60000;
  return runGroup(args[0], args.slice(1), {
    cwd: o.cwd || os.homedir(),
    timeoutMs: limit,
    maxBytes: MAX_RUN_BYTES,
    env: { ...live.envFor(o.capability), GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0" },
  }).then((g) => {
    // Таблица кодов ПРЕЖНЯЯ (её сторожит набор): errno строкой — как есть,
    // ENOENT — 127, таймаут — -1, переполнение — ENOBUFS, прочее — 1.
    let code = 0;
    let ok = true;
    let errText = g.err;
    if (g.spawnError) {
      ok = false;
      const e = g.spawnError;
      if (e.code === "ENOENT") code = 127;
      // EINVAL, EPERM, EACCES и прочие системные коды нельзя терять в «1»:
      // без них диагноз на отказе запуска невозможен.
      else if (typeof e.code === "string") code = e.code;
      else code = 1;
      if (!errText) errText = String(e.message || e);
    } else if (g.timedOut) {
      ok = false;
      code = -1; // таймаут
      if (!errText) errText = "Команда не уложилась в " + g.limitMs + " мс — остановлена вместе с дочерними процессами.";
    } else if (g.overflow) {
      ok = false;
      code = "ENOBUFS"; // прежний код переполнения maxBuffer у execFile
      if (!errText) errText = "maxBuffer length exceeded";
    } else if (g.code === 0) {
      ok = true;
      code = 0;
    } else {
      ok = false;
      code = Number.isInteger(g.code) ? g.code : 1; // смерть от чужого сигнала
      if (!errText) {
        errText = g.signal ? "Процесс завершён сигналом " + g.signal + "." : "Команда завершилась с кодом " + code + ".";
      }
    }
    return { ok, code, out: stripAnsi(g.out), err: stripAnsi(errText) };
  });
}

// ── Системные запросы PowerShell через живую сессию (ускорение №5) ──────────
// Разовый `powershell.exe -NoProfile -Command "..."` — это холодный старт .NET
// (0,4–1,5 с) на КАЖДЫЙ запрос справки. Живая сессия держит ОДИН процесс;
// при любом сбое (нет PowerShell, таймаут, процесс умер) — обычный разовый
// запуск, то есть поведение инструментов не меняется ни в одном сценарии.
async function psScript(script, timeoutMs) {
  const ms = timeoutMs || 30000;
  if (process.platform === "win32") {
    const r = await winPs.exec(script, { timeoutMs: ms });
    if (!r.noSession) return r;
  }
  return spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: os.homedir(),
    timeoutMs: ms,
  });
}

// Кэш системных справок: агент часто спрашивает одно и то же подряд (что за ПК,
// жив ли процесс). Живёт коротким TTL, чтобы не отдавать протухшее состояние.
// isBad(v) — «это не результат, а ошибка»: такое не кэшируем.
const _sysCache = new Map(); // key → { t, val }
async function cachedPs(key, ttlMs, fn, isBad) {
  const hit = _sysCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.val;
  const val = await fn();
  if (val && !(typeof isBad === "function" && isBad(val))) _sysCache.set(key, { t: Date.now(), val });
  return val;
}
function invalidatePsCache(prefix) {
  for (const k of Array.from(_sysCache.keys())) {
    if (!prefix || k.indexOf(prefix) === 0) _sysCache.delete(k);
  }
}

// Обновить PATH текущего процесса из системного окружения (после установок).
async function refreshEnvFromOS() {
  const before = envPathInfo().value;
  let sysPath = "";
  if (process.platform === "win32") {
    const r = await psScript(
      "$m=[Environment]::GetEnvironmentVariable('Path','Machine'); $u=[Environment]::GetEnvironmentVariable('Path','User'); Write-Output ($m + ';' + $u)",
      30000
    );
    sysPath = (r.out || "").trim();
  } else {
    for (const shell of ["bash", "sh"]) {
      const r = await spawnRaw([shell, "-lc", 'printf "%s" "$PATH"'], { cwd: os.homedir(), timeoutMs: 30000 });
      if (r.ok && (r.out || "").trim()) {
        sysPath = (r.out || "").trim();
        break;
      }
    }
  }
  if (!sysPath) return "Не удалось прочитать системный PATH — вызови refreshEnv() ещё раз после перезапуска приложения.";
  const all = setMergedPath(before, sysPath);
  const beforeParts = (before || "").split(path.delimiter).map((x) => x.trim()).filter(Boolean);
  const added = all.filter((x) => !beforeParts.includes(x));
  return (
    "PATH обновлён в текущей сессии (до перезапуска).\n" +
    "Записей было: " + beforeParts.length + ", стало: " + all.length +
    (added.length ? "\nДобавлено (новые пути):\n" + added.slice(0, 20).join("\n") + (added.length > 20 ? "\n… и ещё " + (added.length - 20) : "") : "\nНовых путей не появилось.") +
    "\n\nПроверь установку: checkInstalledProgram(имя). Уже открытые shell-сессии PATH не меняют — обновляются только новые процессы приложения."
  );
}

const WINGET_IDS = {
  git: "Git.Git",
  node: "OpenJS.NodeJS.LTS",
  npm: "OpenJS.NodeJS.npm",
  python: "Python.Python.3.12",
  python3: "Python.Python.3.12",
  ffmpeg: "Gyan.FFmpeg",
  gh: "GitHub.cli",
  "7zip": "7zip.7zip",
  "7z": "7zip.7zip",
  powershell: "Microsoft.PowerShell",
  yarn: "Yarn.Yarn",
  pnpm: "pnpm.pnpm",
  bun: "Oven-sh.Bun",
  docker: "Docker.DockerDesktop",
  dotnet: "Microsoft.DotNet.SDK.8",
  java: "EclipseAdoptium.Temurin.21.JDK",
  jdk: "EclipseAdoptium.Temurin.21.JDK",
  curl: "curl.curl",
  wget: "GNU.Wget2",
  make: "GnuWin32.Make",
  cmake: "Kitware.CMake",
  sqlite: "SQLite.SQLite",
  redis: "Redis.Redis",
  nginx: "Nginx.Nginx",
  postgresql: "PostgreSQL.PostgreSQL.16",
  postgres: "PostgreSQL.PostgreSQL.16",
  mysql: "Oracle.MySQL",
  mongodb: "MongoDB.Server",
  ollama: "Ollama.Ollama",
  chrome: "Google.Chrome",
  chromium: "Chromium.Chromium",
  firefox: "Mozilla.Firefox",
  vscode: "Microsoft.VisualStudioCode",
  notepadpp: "Notepad++.Notepad++",
  vlc: "VideoLAN.VLC",
  winrar: "RARLab.WinRAR",
  powertoys: "Microsoft.PowerToys",
  terminal: "Microsoft.WindowsTerminal",
  imagemagick: "ImageMagick.ImageMagick",
  telegram: "Telegram.TelegramDesktop",
  discord: "Discord.Discord",
  slack: "SlackTechnologies.Slack",
  obs: "OBSProject.OBSStudio",
  blender: "BlenderFoundation.Blender",
  gimp: "GIMP.GIMP",
  inkscape: "Inkscape.Inkscape",
  figma: "Figma.Figma",
  drawio: "JGraph.Draw",
  obsidian: "Obsidian.Obsidian",
  everything: "voidtools.Everything",
  spotify: "Spotify.Spotify",
  zoom: "Zoom.Zoom",
  putty: "PuTTY.PuTTY",
  wireshark: "WiresharkFoundation.Wireshark",
};

const EXIT_HINTS = {
  0: "Успех — команда завершилась корректно (код 0).",
  1: "Общая ошибка: команда упала. Смотри вывод выше — чаще всего ошибка в коде/конфигурации, а не в системе.",
  2: "Неправильное использование команды: неверные аргументы или синтаксис.",
  126: "Команда найдена, но не может выполниться: нет прав на запуск или файл не исполняемый.",
  127: "Команда НЕ НАЙДЕНА: программы нет в PATH / она не установлена. Проверь через checkInstalledProgram, при необходимости установи (installSystemPackage) и обнови PATH (refreshEnv).",
  130: "Прервано пользователем (Ctrl+C / SIGINT).",
  137: "Процесс убит (SIGKILL) — обычно нехватка памяти или принудительная остановка.",
  143: "Завершён по SIGTERM (мягкая остановка).",
  9009: "Windows: команда не найдена (аналог кода 127).",
  740: "Windows: нужны права администратора — используй runCommandAsAdmin или установи из-под администратора.",
  5: "Windows: отказано в доступе — файл занят, нет прав или нужен администратор (runCommandAsAdmin).",
  206: "Windows: слишком длинная командная строка — сократи команду.",
};

function explainExit(exitCode, cmdText) {
  const code = typeof exitCode === "number" ? exitCode : NaN;
  const lines = [];
  if (cmdText) lines.push("Команда: " + String(cmdText).slice(0, 300));
  lines.push("Код завершения: " + (Number.isNaN(code) ? "— (не число)" : code) + (code === -1 ? " (таймаут — процесс убит по времени)" : ""));
  lines.push("");
  lines.push(
    EXIT_HINTS[code] ||
      (Number.isNaN(code)
        ? "Укажи exitCode числом, чтобы получить объяснение."
        : "Код " + code + " не входит в типовую таблицу. Смотри текст ошибки: если там «not found» / «не является внутренней или внешней командой» — программа не установлена; «denied»/«доступ запрещён» — нужны права; иначе это ошибка самой команды.")
  );
  if (code === 127 || code === 9009) {
    lines.push("Что делать: 1) canExecute(имя) — проверить наличие; 2) installSystemPackage(имя) — установить; 3) refreshEnv() — обновить PATH; 4) проверить заново.");
  }
  if (code === 740 || code === 5) {
    lines.push("Что делать: запусти через runCommandAsAdmin (появится системный запрос прав) либо установи программу из-под администратора.");
  }
  return lines.join("\n");
}

async function installSystemPkg(pkg) {
  const name = String(pkg || "").trim();
  if (!name) return "Ошибка: укажи packageName (например git, node, python, ffmpeg или winget-ID вида Vendor.Name).";
  const plat = process.platform;
  const info = findProgram(name.split(/[\\/]/).pop() || name);
  if (info.found) {
    const v = await runProgVersion(info.path);
    return "«" + name + "» уже установлен: " + info.path + (v ? "\n" + v : "") + "\nУстановка не нужна.";
  }
  if (plat === "win32") {
    const id = name.includes(".") ? name : WINGET_IDS[name.toLowerCase()];
    if (!id) {
      return "Не знаю winget-ID для «" + name + "». Найди точный ID: wingetSearch(\"" + name + "\"), затем installSystemPackage('Vendor.Name'). Известные ID: " + Object.keys(WINGET_IDS).join(", ") + ". Либо укажи прямую ссылку на установщик: installExe(url, name).";
    }
    const wg = findProgram("winget");
    if (!wg.found) {
      const choco = findProgram("choco");
      if (choco.found) {
        const cmd = "choco install -y " + name.split(".").pop();
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        return "$ " + cmd + "\n\n" + out + "\n\nДальше: 1) refreshEnv() — обновить PATH; 2) checkInstalledProgram(\"" + name + "\"). Если нужен администратор — повтори через runCommandAsAdmin(\"" + cmd + "\").";
      }
      const scoop = findProgram("scoop");
      if (scoop.found) {
        const cmd = "scoop install " + name.split(".").pop();
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        return "$ " + cmd + "\n\n" + out + "\n\nДальше: 1) refreshEnv() — обновить PATH; 2) checkInstalledProgram(\"" + name + "\").";
      }
      return "winget не установлен (choco и scoop тоже не найдены). Установи winget из Microsoft Store («App Installer»), либо укажи прямую ссылку на установщик: installExe(url, name).";
    }
    const cmd = "winget install --id " + id + " --exact --accept-package-agreements --accept-source-agreements --disable-interactivity";
    const out = await runTerminalCommand(cmd, os.homedir(), 300000);
    return (
      "$ " + cmd + "\n\n" + out +
      "\n\nДальше: 1) refreshEnv() — обновить PATH; 2) checkInstalledProgram(имя) — проверить. " +
      "Если установка потребовала UAC/администратора и прервалась — повтори через runCommandAsAdmin(\"" + cmd + "\") или установи вручную."
    );
  }
  if (plat === "darwin") {
    const brew = findProgram("brew");
    if (!brew.found) return "На macOS установка идёт через Homebrew, но он не найден. Поставь Homebrew (brew.sh) и вызови installSystemPackage снова.";
    const cmd = "brew install " + name;
    const out = await runTerminalCommand(cmd, os.homedir(), 600000);
    return "$ " + cmd + "\n\n" + out + "\n\nПроверь: checkInstalledProgram(" + name + ").";
  }
  const isRoot = typeof process.getuid === "function" && process.getuid && process.getuid() === 0;
  let mgr = null;
  for (const [bin, flag] of [["apt-get", "install -y"], ["dnf", "install -y"], ["apk", "add"]]) {
    if (findProgram(bin).found) { mgr = bin + " " + flag; break; }
  }
  if (!mgr) return "Не нашёл пакетный менеджер (apt-get/dnf/apk). Установи " + name + " вручную.";
  const sudo = isRoot ? "" : "sudo -n ";
  const cmd = sudo + mgr + " " + name;
  const out = await runTerminalCommand(cmd, os.homedir(), 600000);
  const looksFailed = /кодом (1|100|127|126)|not found|E: |Unable to/i.test(out);
  return (
    "$ " + cmd + "\n\n" + out +
    (looksFailed
      ? "\n\nПохоже, установка не удалась: без sudo пакетный менеджер требует пароль. Запусти через runCommandAsAdmin(\"" + cmd + "\") — появится системный запрос прав."
      : "\n\nПроверь: checkInstalledProgram(" + name + ").")
  );
}

// Скачивает файл по URL в указанный путь с проверкой размера. Поток не собирается
// целиком в RAM: это важно для установщиков и архивов, которыми управляет агент.
async function downloadResponseToFile(res, dest, limit) {
  let size = 0;
  const tmp = dest + ".part-" + process.pid + "-" + Date.now().toString(36);
  try {
    const out = fs.createWriteStream(tmp, { flags: "wx" });
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > limit) {
        out.destroy();
        throw new Error("__LIMIT__");
      }
      if (!out.write(chunk)) await new Promise((resolve, reject) => {
        out.once("drain", resolve);
        out.once("error", reject);
      });
    }
    await new Promise((resolve, reject) => {
      out.end((err) => err ? reject(err) : resolve());
      out.once("error", reject);
    });
    fs.renameSync(tmp, dest);
    return { size };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

async function downloadFileTo(url, dest, limitMb) {
  const limit = (limitMb || 800) * 1024 * 1024;
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "AI-Developer-Agent" } });
  } catch (e) {
    return { ok: false, error: "Ошибка загрузки " + url + ": " + (e.message || String(e)) };
  }
  if (!res.ok) return { ok: false, error: "Ошибка HTTP " + res.status + " при загрузке " + url };
  const announced = Number(res.headers.get("content-length") || 0);
  if (announced > limit) return { ok: false, error: "Файл слишком большой (> " + (limitMb || 800) + " МБ)." };
  try {
    const r = await downloadResponseToFile(res, dest, limit);
    return { ok: true, size: r.size };
  } catch (e) {
    return { ok: false, error: e && e.message === "__LIMIT__" ? "Файл слишком большой (> " + (limitMb || 800) + " МБ)." : "Не удалось сохранить файл: " + (e.message || String(e)) };
  }
}

// ── Проверка скачанного установщика ──────────────────────────────────────────
// Хэш и подпись считаются ДО запуска: сначала показываем, что именно запускаем,
// и только потом запускаем. Если хэш задан заранее — файл с другим хэшем не
// запускается вообще, а не «с предупреждением».
function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function verifyInstaller(file, expectedSha) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    return { ok: false, error: "Файл установщика не найден: " + file };
  }
  let sha256 = "";
  try {
    sha256 = fileSha256(file);
  } catch (e) {
    return { ok: false, error: "Не удалось прочитать файл для проверки: " + (e.message || String(e)) };
  }
  // «sha256:» перед хэшем — как в объявлениях на сайтах загрузки.
  const want = String(expectedSha || "").trim().toLowerCase().replace(/^sha256:/, "");
  // Подпись Authenticode есть только у исполняемых файлов Windows. В остальных
  // случаях честно говорим «нет данных», а не «подпись в порядке».
  let sig = null;
  if (process.platform === "win32" && /\.(exe|msi|msix|appx)$/i.test(String(file))) {
    const script =
      "Get-AuthenticodeSignature -LiteralPath '" + String(file).replace(/'/g, "''") + "' | " +
      "Select-Object Status,@{n='Signer';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress";
    const r = await winPs.exec(script, { timeoutMs: 30000 });
    if (r && !r.noSession && r.ok) {
      try {
        const j = JSON.parse(String(r.out || "").trim().split("\n").pop() || "{}");
        sig = { status: String(j.Status || "Unknown"), signer: String(j.Signer || "") };
      } catch (e) {
        sig = { status: "Unknown", signer: "" };
      }
    }
  }
  return { ok: true, size, sha256, expected: want, hashOk: !want || want === sha256, sig };
}

// ── Отчёт о проверенном установщике и решение о запуске ─────────────────────
// Держим рядом с verifyInstaller: отчёт и решение — часть одной проверки, и
// проверяются они в plain-node, а не срезом текста инструмента.
function installerFacts(file, v) {
  const size = v.size >= 1024 * 1024
    ? Math.round(v.size / 1024 / 1024) + " МБ"
    : Math.max(1, Math.round(v.size / 1024)) + " КБ";
  const hashNote = v.expected ? (v.hashOk ? " ✓ совпал с заданным" : " ✗ НЕ совпал с заданным " + v.expected) : "";
  const sigNote = v.sig
    ? (v.sig.status === "Valid" ? "действительна" : "НЕ действительна — " + v.sig.status) + (v.sig.signer ? " · " + v.sig.signer : "")
    : "нет данных (Authenticode проверяется только в Windows)";
  return "Файл: " + file + " (" + size + ")\nSHA-256: " + v.sha256 + hashNote + "\nПодпись: " + sigNote;
}

// Решение «запускать или нет»: возвращает причину отказа, либо "" — можно.
function installerGate(v, args) {
  const a = args || {};
  if (!v.hashOk) {
    return "Установка остановлена: хэш файла не совпал с заданным.\n  ожидали: " + v.expected + "\n  получили: " + v.sha256 +
      "\nФайл мог быть подменён при загрузке — запускать его нельзя. Скачай заново или сверь хэш на сайте издателя.";
  }
  if (v.sig && v.sig.status !== "Valid" && a.allowUnsigned !== true) {
    return "Установка остановлена: подпись издателя недействительна (" + v.sig.status + ").\n" +
      "Если источник проверен и ты ему доверяешь — повтори вызов с allowUnsigned: true.";
  }
  return "";
}

// Ищет установщики в распакованном архиве (не глубже 3 уровней; сначала те,
// что лежат ближе к корню — обычно это setup.exe верхнего уровня).
function findInstallersIn(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || out.length >= 40) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      const full = path.join(d, en.name);
      if (en.isDirectory()) { walk(full, depth + 1); continue; }
      if (/\.(exe|msi|bat|cmd)$/i.test(en.name)) out.push(full);
    }
  };
  walk(dir, 0);
  out.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return out;
}

// Чем распаковывать скачанное: имя файла решает ПЕРВЫМ, тип — только как подсказка.
// Так потому, что «application/gzip» СОДЕРЖИТ «zip»: от одной подстроки в типе
// .tar.gz уезжал в ветку unzip и падал на любом сервере, который отдаёт tar.gz
// стандартным типом. Нашёл живой прогон сети (часть 40, заход 6a), набор такого
// не видел, потому что проверял текст, а не решение.
function archiveKind(url, contentType) {
  const pathLow = String(url || "").toLowerCase();
  const ct = String(contentType || "").toLowerCase();
  if (/\.zip$/.test(pathLow)) return "zip";
  if (/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar)$/.test(pathLow)) return "tar";
  const ctTar = ct.includes("gzip") || ct.includes("tar");
  const ctZip = ct.includes("zip") && !ctTar; // «gzip» — это НЕ zip
  if (ctTar) return "tar";
  if (ctZip) return "zip";
  return "";
}

function safeArchiveEntry(name) {
  const raw = String(name || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return false;
  const parts = raw.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || p.includes("\0"))) return false;
  return true;
}

async function downloadAndExtractTo(url, destDir) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Ошибка: укажи полный URL (https://…/archive.zip, .tar.gz и т.п.)";
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    return "Ошибка: не удалось создать папку " + destDir + ": " + (e.message || String(e));
  }
  let res;
  try {
    res = await fetch(u, { redirect: "follow", headers: { "User-Agent": "AI-Developer-Agent" } });
  } catch (e) {
    return "Ошибка загрузки " + u + ": " + (e.message || String(e));
  }
  if (!res.ok) return "Ошибка HTTP " + res.status + " при загрузке " + u;
  const archiveLimit = 300 * 1024 * 1024;
  const announced = Number(res.headers.get("content-length") || 0);
  if (announced > archiveLimit) return "Архив слишком большой (>300 МБ): " + announced + " байт.";
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const pathLow = u.toLowerCase();
  const kind = archiveKind(u, contentType);
  if (!kind) return "Не похоже на архив (.zip / .tar.gz / .tgz): " + u + ". Скачивать обычные файлы через runCommand (curl / Invoke-WebRequest).";
  const isZip = kind === "zip";
  const tmpFile = path.join(os.tmpdir(), "ai-agent-dl-" + Date.now().toString(36) + (isZip ? ".zip" : ".tar"));
  const staging = tmpFile + "-out";
  try {
    await downloadResponseToFile(res, tmpFile, archiveLimit);
    // Сначала проверяем имена архива, затем распаковываем только во временный
    // каталог. Так ни traversal, ни частично распакованный архив не попадают в
    // рабочую папку. Символические ссылки отбрасываются отдельной проверкой ниже.
    const list = isZip
      ? await spawnRaw(["unzip", "-Z1", tmpFile], { timeoutMs: 30000 })
      : await spawnRaw(["tar", "-tf", tmpFile], { timeoutMs: 30000 });
    if (!list.ok) return "Не удалось проверить архив: " + ((list.err || list.out || "").trim() || "код " + list.code);
    const archiveNames = String(list.out || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const bad = archiveNames.find((name) => !safeArchiveEntry(name));
    if (bad) return "Архив отклонён: опасный путь или ссылка в записи «" + bad + "».";
    const details = isZip
      ? await spawnRaw(["unzip", "-Z", "-l", tmpFile], { timeoutMs: 30000 })
      : await spawnRaw(["tar", "-tvf", tmpFile], { timeoutMs: 30000 });
    if (!details.ok) return "Не удалось проверить типы записей архива: " + ((details.err || details.out || "").trim() || "код " + details.code);
    if ((!isZip && /^l|^h/m.test(details.out || "")) || (isZip && /\s->\s/.test(details.out || ""))) {
      return "Архив отклонён: символические и жёсткие ссылки запрещены.";
    }
    fs.mkdirSync(staging, { recursive: true });
    if (process.platform === "win32" && isZip) {
      const ps = "Expand-Archive -Path '" + tmpFile.replace(/'/g, "''") + "' -DestinationPath '" + staging.replace(/'/g, "''") + "' -Force";
      const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 180000 });
      if (!r.ok) return "Не удалось распаковать: " + ((r.err || r.out || "").trim() || "код " + r.code);
    } else if (isZip) {
      const r = await spawnRaw(["unzip", "-q", "-o", tmpFile, "-d", staging], { timeoutMs: 180000 });
      if (!r.ok) return "Не удалось распаковать (нужен unzip): " + ((r.err || r.out || "").trim() || "код " + r.code) + "\nВарианты: установи unzip (installSystemPackage) или скачай tar-архив (.tar.gz).";
    } else {
      const flag = /\.(tar\.gz|tgz)$/.test(pathLow) || contentType.includes("gzip") ? "-xzf" : "-xf";
      const r = await spawnRaw(["tar", flag, tmpFile, "-C", staging], { timeoutMs: 180000 });
      if (!r.ok) return "Не удалось распаковать: " + ((r.err || r.out || "").trim() || "код " + r.code);
    }
    const stagedEntries = [];
    const checkStaging = (d) => {
      for (const en of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, en.name);
        if (en.isSymbolicLink() || en.isBlockDevice() || en.isCharacterDevice() || en.isSocket()) throw new Error("опасная ссылка: " + path.relative(staging, full));
        if (en.isDirectory()) checkStaging(full);
        else stagedEntries.push(full);
      }
    };
    checkStaging(staging);
    fs.cpSync(staging, destDir, { recursive: true, force: true });
    const names = [];
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const en of entries) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) walk(full);
        else names.push(path.relative(destDir, full).split(path.sep).join("/"));
      }
    };
    walk(destDir);
    return "OK — скачано и распаковано в " + destDir + "\nФайлов: " + names.length + (names.length ? "\nПримеры:\n" + names.slice(0, 15).map((n) => "• " + n).join("\n") : "");
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function runAsAdmin(cmd) {
  const command = String(cmd || "").trim();
  if (!command) return "Ошибка: укажи команду для запуска с правами администратора.";
  if (process.platform === "win32") {
    const tmp = path.join(os.tmpdir(), "ai-agent-elev-" + Date.now().toString(36) + ".cmd");
    fs.writeFileSync(tmp, "@echo off\r\n" + command + "\r\n", "utf8");
    try {
      const ps = "Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/c','" + tmp + "' -Verb RunAs -Wait";
      const enc = Buffer.from(ps, "utf16le").toString("base64");
      const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { timeoutMs: 600000 });
      return (r.ok
        ? "OK — команда запущена с правами администратора (UAC подтверждён)."
        : "Не удалось запустить с правами администратора: " + ((r.err || "").trim() || "код " + r.code) + " — возможно, запрос UAC отклонён.") +
        "\nВывод администрируемого окна приложение не перехватывает. После установки: refreshEnv() → checkInstalledProgram(имя).";
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  if (process.platform === "darwin") {
    const esc = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const r = await spawnRaw(["osascript", "-e", 'do shell script "' + esc + '" with administrator privileges'], { timeoutMs: 600000 });
    return (r.ok ? "OK — команда выполнена с правами администратора." : "Не удалось: " + ((r.err || "").trim() || "код " + r.code)) + "\nВывод: " + ((r.out || r.err || "(пусто)").trim() || "(пусто)").slice(0, 2000);
  }
  const pkexec = findProgram("pkexec");
  if (pkexec.found) {
    const r = await spawnRaw(["pkexec", "/bin/sh", "-c", command], { timeoutMs: 600000 });
    return (r.ok ? "OK — команда выполнена с правами администратора." : "Не удалось / отклонено: " + ((r.err || "").trim() || "код " + r.code)) + "\nВывод: " + ((r.out || r.err || "(пусто)").trim() || "(пусто)").slice(0, 2000);
  }
  return "На Linux нужен pkexec (policykit) или sudo с паролем. Установи pkexec либо выполни команду вручную в терминале с sudo.";
}

  return {
    envPathInfo,
    setMergedPath,
    findProgram,
    runProgVersion,
    spawnRaw,
    psScript,
    _sysCache,
    cachedPs,
    invalidatePsCache,
    refreshEnvFromOS,
    WINGET_IDS,
    EXIT_HINTS,
    explainExit,
    installSystemPkg,
    downloadFileTo,
    fileSha256,
    verifyInstaller,
    installerFacts,
    installerGate,
    findInstallersIn,
    downloadAndExtractTo,
    // Решение «zip или tar» — наружу: оно чистое, и его сторожит набор (живой
    // прогон проверяет следствие — что настоящий .tar.gz РАСПАКОВАЛСЯ).
    archiveKind,
    runAsAdmin,
  };
}

module.exports = { createSystemStack };

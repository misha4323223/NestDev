"use strict";

/* ─── Пользовательский терминал (нижняя панель, как в Replit) ────────────────
   Вынесено из main.js (этап B, часть 12). Здесь живёт постоянная оболочка
   рабочей папки: человек запускает её из панели и вводит команды, а агент
   ДУБЛИРУЕТ туда свои команды и их вывод — чтобы было видно, что он делает,
   даже если панель откроют позже.

   Ошибки здесь тихие и дорогие:
     • остановка убьёт только оболочку — рабочие процессы останутся сиротами
       и будут держать порт (за это отвечает переданный bgKill — он гасит дерево);
     • вывод перестанет копиться — панель покажет пустоту вместо истории;
     • кольцевой буфер перестанет обрезаться — долгая сессия съест память.

   Живое значение одно — окно: оно создаётся позже сборки модуля и может быть
   уже закрыто, поэтому приходит ФУНКЦИЕЙ (getWindow), а не значением. */

function createTerminalPanel(deps) {
  const { fs, path, os, spawn, stripAnsi, envFor, bgKill, agentWorkDir, loadSettings, getWindow } = deps;

let userTerm = null; // { child, buf, exited, startedAt }

function termEmit(ev) {
  const mainWindow = getWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("term:event", ev);
}

// Показывает команду и вывод агента в нижнем терминале приложения (как Replit Agent):
// пользователь видит, что агент выполняет, даже если панель откроют позже.
function termAgentEcho(text) {
  const clean = stripAnsi(String(text || ""));
  if (!clean) return;
  if (userTerm && !userTerm.exited) {
    const lines = clean.split("\n");
    userTerm.buf.push(...lines);
    if (userTerm.buf.length > 2000) userTerm.buf.splice(0, userTerm.buf.length - 2000);
  }
  termEmit({ type: "agent", text: clean });
}

function termStart(cwd) {
  if (userTerm && !userTerm.exited) return { ok: false, error: "Терминал уже запущен" };
  const isWin = process.platform === "win32";
  const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/Q"] : [];
  let child = null;
  try {
    child = spawn(shell, args, {
      cwd: cwd || os.homedir(),
      detached: !isWin,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...envFor("terminal.execute"), GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0" },
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const rec = { child, buf: [], exited: false, startedAt: Date.now() };
  userTerm = rec;
  const push = (chunk) => {
    const text = stripAnsi(chunk.toString());
    rec.buf.push(text);
    if (rec.buf.length > 2000) rec.buf.splice(0, rec.buf.length - 2000);
    termEmit({ type: "out", text });
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("exit", (code) => {
    rec.exited = true;
    termEmit({ type: "exit", code });
  });
  child.on("error", (e) => {
    rec.exited = true;
    termEmit({ type: "exit", code: null, error: e.message });
  });
  termEmit({ type: "start", cwd });
  return { ok: true, cwd };
}

function termInput(text) {
  if (!userTerm || userTerm.exited) return { ok: false, error: "Терминал не запущен. Перезапусти панель." };
  try {
    userTerm.child.stdin.write(String(text) + "\n");
    termEmit({ type: "in", text: String(text) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function termStop() {
  if (!userTerm) return { ok: false, error: "Терминал не запущен" };
  const rec = userTerm;
  userTerm = null;
  bgKill(rec);
  return { ok: true };
}

// Состояние для панели: выражение было прямо в канале term:status, переехало
// сюда, чтобы снаружи не пришлось держать кусок чужого состояния.
function termStatus() {
  return { running: !!(userTerm && !userTerm.exited) };
}

// Остановка при выходе приложения: ответ окну не нужен — оно уже закрывается.
function termShutdown() {
  if (!userTerm) return;
  const rec = userTerm;
  userTerm = null;
  bgKill(rec);
}

// Автодополнение команды в терминале (Tab): команды из PATH или файлы рабочей папки.
function termComplete(line) {
  const text = String(line || "");
  const cwd = agentWorkDir(loadSettings());
  const sp = text.lastIndexOf(" ");
  const token = sp >= 0 ? text.slice(sp + 1) : text;
  const base = sp >= 0 ? text.slice(0, sp + 1) : "";
  const matches = [];
  const listDir = (dir, prefix, fullPrefix) => {
    try {
      for (const e of fs.readdirSync(dir)) {
        if (!e.startsWith(prefix)) continue;
        let isDir = false;
        try { isDir = fs.statSync(path.join(dir, e)).isDirectory(); } catch {}
        matches.push(fullPrefix + e + (isDir ? "/" : ""));
      }
    } catch {}
  };
  if (!token) {
    listDir(cwd, "", ""); // пустой токен — файлы рабочей папки
  } else if (token.includes("/") || token.startsWith(".")) {
    const isAbs = path.isAbsolute(token);
    const slash = token.lastIndexOf("/");
    const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
    const filePart = slash >= 0 ? token.slice(slash + 1) : token;
    const searchDir = isAbs ? (dirPart || "/") : path.join(cwd, dirPart);
    listDir(searchDir, filePart, dirPart);
  } else {
    const pathDirs = (process.env.PATH || "").split(path.delimiter);
    for (const d of pathDirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (e.toLowerCase().startsWith(token.toLowerCase())) matches.push(e);
        }
      } catch {}
    }
    // Команд с таким префиксом нет — дополняем файлами рабочей папки (как в bash)
    if (!matches.length) listDir(cwd, token, "");
  }
  return { matches: [...new Set(matches)].sort().slice(0, 30), base, tokenLen: token.length };
}
/* Каналы окна для панели: раньше стояли в main.js (этап B, часть 32). Рабочая папка
   и настройки берутся те же, что и у остальных функций панели, — модуль уже получает
   их своими зависимостями, и копий снаружи держать не нужно. Старт терминала читает
   рабочую папку В МОМЕНТ вызова: человек мог переключить проект, пока панель была
   закрыта, и терминал обязан открыться в нынешней папке, а не в прежней. */
function registerTermIpc(ipcMain) {
  ipcMain.handle("term:start", () => termStart(agentWorkDir(loadSettings())));
  ipcMain.handle("term:input", (_e, text) => termInput(text));
  ipcMain.handle("term:stop", () => termStop());
  ipcMain.handle("term:status", () => termStatus());
  ipcMain.handle("term:complete", (_e, line) => termComplete(line));
}

  return { termEmit, termAgentEcho, termStart, termInput, termStop, termStatus, termShutdown, termComplete, registerTermIpc };
}

module.exports = { createTerminalPanel };

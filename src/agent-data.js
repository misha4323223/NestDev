"use strict";

/* ─── Где лежат рабочие данные агента: миссии, прогоны и дела (часть 44) ──────
   Раньше работа агента ложилась в двух местах: миссии и прогоны — в папке
   `.agent/` РЯДОМ С ПРОЕКТОМ, а дела — в папке приложения (userData). Человек
   просил иначе: и то, и другое должно уезжать в папку, которую ОН выберет сам,
   чтобы папки проектов не забивались рабочим грузом.

   Этот модуль — единственная точка правды о раскладке. Ни хранилище миссий, ни
   каналы дел, ни панель настроек не считают пути сами: они спрашивают раскладку
   здесь, поэтому «выбрал папку» и «где на самом деле лежат файлы» разойтись не
   могут. Правила намеренно скучные:

     • Пустая настройка = ПРЕЖНЕЕ место. Ничего не выбрано — всё работает, как
       работало: `.agent/` рядом с проектом, дела в папке приложения. Это и делает
       обновление безопасным: старые файлы лежат там же, где лежали, и приложение
       НИЧЕГО не переносит (перенос существующего — это потеря данных на ровном
       месте; человек сам решает, что делать со старым).

     • Своя папка для миссий — внутри неё заводится ПОДПАПКА ПРОЕКТА
       (<имя>-<отпечаток пути>). Без неё миссии двух проектов смешались бы в одной
       папке: панель «Миссия» показывала бы чужую работу, а кнопка «▶ Продолжить»
       могла бы вернуть в работу чужую задачу. Отпечаток считается по абсолютному
       пути и не различает регистр на Windows (D:\proj и d:\proj — один проект).

     • Дела общие для всех проектов (так было и раньше), поэтому у своей папки дел
       подпапки проекта нет: tasks.json и зеркало tasks.md лежат прямо в ней.

   Настройка, а не константа времени запуска: раскладка спрашивается НА КАЖДЫЙ
   вызов (layoutOf), потому что папку могут сменить в открытом приложении. Поэтому
   же сюда ставится одна функция (install) — её пишет main.js, когда настройки и
   рабочая папка уже читаются; если не поставили (тесты, ранний вызов), работает
   прежняя раскладка, а не пустота.

   Модуль чистый: ни Electron, ни fs — только пути и отпечаток пути. Поэтому
   проверяется обычными тестами без подставного диска. */

const path = require("path");
const crypto = require("crypto");

const AGENT_DIR = ".agent";

// Путь из настроек: обрезаем пробелы и хвостовые разделители (иначе path.join дал
// бы «папка//missions», и текст пути в панели выглядел бы сломанным).
function cleanDir(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  return s.replace(/[\\/]+$/, "") || "";
}

// Один проект — одно имя подпапки. Имя нужно человеку (видно в проводнике),
// отпечаток — машине: он различает проекты с одинаковым именем (две папки «site»).
function projectKey(workDir) {
  const abs = path.resolve(String(workDir || "") || ".");
  const norm = (process.platform === "win32" ? abs.toLowerCase() : abs).replace(/[\\/]+$/, "");
  const hash = crypto.createHash("sha1").update(norm, "utf8").digest("hex").slice(0, 8);
  const base = String(path.basename(abs) || "project")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё._-]+/gi, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 30);
  return (base || "project") + "-" + hash;
}

// Вложена ли папка в рабочую папку проекта. Нужна только для честного
// предупреждения в интерфейсе: выбор папки внутри проекта оставит груз в проекте,
// и об этом надо сказать, а не делать вид, что всё уехало.
function isInside(child, parent) {
  const c = cleanDir(child);
  const p = cleanDir(parent);
  if (!c || !p) return false;
  const norm = (s) => (process.platform === "win32" ? path.resolve(s).toLowerCase() : path.resolve(s));
  const cc = norm(c);
  const pp = norm(p);
  return cc === pp || cc.indexOf(pp + path.sep) === 0;
}

// Раскладка по настройкам. Пустое поле настройки — прежнее место (см. шапку).
function layout(settings, workDir, userDataDir) {
  const s = settings || {};
  const wd = String(workDir || "");
  const ud = String(userDataDir || "");
  const missionsDir = cleanDir(s.missionsDir);
  const tasksDir = cleanDir(s.tasksDir);
  const defaultRoot = path.join(wd, AGENT_DIR);
  const missionsRoot = missionsDir ? path.join(missionsDir, projectKey(wd)) : defaultRoot;
  return {
    workDir: wd,
    defaultRoot: defaultRoot, // <проект>/.agent — как было: зеркала контекста живут здесь
    missionsRoot: missionsRoot, // корень миссий и прогонов
    runsRoot: path.join(missionsRoot, "runs"),
    missionsCustom: !!missionsDir,
    missionsDir: missionsDir, // выбранная человеком папка ("" — не выбрана)
    tasksRoot: tasksDir || ud, // папка данных дел (tasks.json)
    tasksDir: tasksDir,
    tasksCustom: !!tasksDir,
    tasksMirrorRoot: tasksDir || defaultRoot, // где лежит зеркало tasks.md
    missionsInsideProject: !!missionsDir && isInside(missionsDir, wd),
    tasksInsideProject: !!tasksDir && isInside(tasksDir, wd),
  };
}

// Раскладка по умолчанию — она же ответ на «настройки ещё не читаются».
function defaultLayout(workDir) {
  const wd = String(workDir || "");
  const root = path.join(wd, AGENT_DIR);
  return {
    workDir: wd,
    defaultRoot: root,
    missionsRoot: root,
    runsRoot: path.join(root, "runs"),
    missionsCustom: false,
    missionsDir: "",
    tasksRoot: "",
    tasksDir: "",
    tasksCustom: false,
    tasksMirrorRoot: root,
    missionsInsideProject: false,
    tasksInsideProject: false,
  };
}

// Одна подстановка на приложение: main.js ставит функцию, которая читает настройки
// в момент вызова. Копия настроек тут «застыла» бы: папку меняют в открытом окне.
let installed = null;
function install(fn) {
  installed = typeof fn === "function" ? fn : null;
}

function layoutOf(workDir) {
  const wd = String(workDir || "");
  if (installed) {
    try {
      const L = installed(wd);
      if (L && typeof L.missionsRoot === "string" && L.missionsRoot) return L;
    } catch {}
  }
  return defaultLayout(wd);
}

// Папка данных дел для хранилища (src/tasks.js). Пусто в настройке — папка
// приложения, как было.
function tasksDataDir(settings, workDir, userDataDir) {
  return layout(settings, workDir, userDataDir).tasksRoot;
}

module.exports = {
  AGENT_DIR,
  cleanDir,
  projectKey,
  isInside,
  layout,
  defaultLayout,
  install,
  layoutOf,
  tasksDataDir,
};

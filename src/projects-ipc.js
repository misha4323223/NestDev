"use strict";

/* ─── Проекты (до 10, переключение) — каналы окна и телефона ──────────────────
   Раньше стояли в main.js (этап B, часть 31): четыре канала списка проектов.
   Хранилище (settings.json, схема и миграции) живёт в src/settings-store.js,
   проверка «папка существует и в неё можно писать» — в самой оболочке
   (ensureWritableDir), туда же она и передана.

   Почему это место нельзя переносить механически. Переключение проекта меняет
   рабочую папку — а вместе с ней в оболочке сбрасываются ТРИ живых значения, и
   каждое из них ошибается тихо:

     • lastAgentRepoDir — папка, куда агент последний раз клонировал репозиторий:
       не сбросить значит оставить агента работать в папке прошлого проекта;
     • clonedRepoPending — одноразовый флаг «только что склонирован»: перенести его
       в новый проект значит впустить в первый же ответ толчок про чужой клон;
     • activeRunUndo — снимки отката предыдущего проекта: не очистить значит
       предложить человеку «вернуть правки» из чужого проекта.

   Переменные принадлежат оболочке (их читают пути-и-git, GitHub-каналы, прогон и
   инструменты), поэтому модуль получает СЕТТЕРЫ мостом live — копии значений
   «застыли» бы, и сбросов бы не случилось.

   Ошибку этих четырёх каналов человек видит как «проект не переключился» или
   «агент работает не там», поэтому у них свои проверки и живой прогон. */

function registerProjectsIpc(deps) {
  const { ipcMain, fs, path, os, loadSettings, saveSettings, ensureWritableDir, live } = deps;

// ─────────────────────────── Проекты (до 10, переключение) ───────────────────────────
// Возвращает список проектов (свежие сверху) и id активного.
ipcMain.handle("projects:list", () => {
  const s = loadSettings();
  const list = (Array.isArray(s.projects) ? s.projects : [])
    .map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      exists: !!(p.dir && fs.existsSync(p.dir)),
      lastOpened: p.lastOpened || 0,
    }))
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  return { ok: true, projects: list, activeId: s.activeProjectId || "" };
});

// Создаёт проект: имя + папка (если не указана — ~/Имя). Становится активным. Максимум 10.
ipcMain.handle("projects:create", async (_e, name, dir) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  if (list.length >= 10) return { ok: false, error: "Достигнут лимит: максимум 10 проектов. Удали один из списка (🗑 — папка не удаляется)." };
  const nm = String(name || "").trim();
  if (!nm) return { ok: false, error: "Введи название проекта." };
  if (nm.length > 60) return { ok: false, error: "Название слишком длинное (до 60 символов)." };
  const safe = nm.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "Проект";
  const target = (typeof dir === "string" && dir.trim()) ? dir.trim() : path.join(os.homedir(), safe);
  const prep = ensureWritableDir(target);
  if (!prep.ok) return prep;
  const abs = prep.dir;
  const dup = list.find((p) => p.dir && path.resolve(p.dir) === abs);
  if (dup) return { ok: false, error: "Эта папка уже используется проектом «" + dup.name + "»." };
  const id = "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = { id, name: nm, dir: abs, createdAt: Date.now(), lastOpened: Date.now() };
  const merged = { ...s, projects: [...list, entry], activeProjectId: id, workingDir: abs, githubRepoDir: "" };
  saveSettings(merged);
  live.setLastAgentRepoDir(null); // рабочая папка сменилась — сбрасываем «активный репозиторий»
  return { ok: true, project: entry };
});

// Переключает активный проект: его папка становится workingDir.
ipcMain.handle("projects:activate", (_e, id) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  const p = list.find((x) => x.id === id);
  if (!p) return { ok: false, error: "Проект не найден." };
  if (!p.dir || !fs.existsSync(p.dir)) {
    return { ok: false, error: "Папка проекта больше не существует: " + (p.dir || "?") + " — убери проект из списка (🗑) и создай заново." };
  }
  p.lastOpened = Date.now();
  const merged = { ...s, projects: list, activeProjectId: id, workingDir: p.dir, githubRepoDir: "" };
  saveSettings(merged);
  live.setLastAgentRepoDir(null);
  live.setClonedRepoPending(false); // флаг «только что склонирован» не переносится между проектами
  live.setActiveRunUndo([]); // undo-снимки предыдущего проекта не применяются в новом
  return { ok: true, project: p };
});

// Убирает проект из списка (папка на диске НЕ удаляется).
ipcMain.handle("projects:remove", (_e, id) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  const rest = list.filter((p) => p.id !== id);
  if (rest.length === list.length) return { ok: false, error: "Проект не найден." };
  let activeId = s.activeProjectId;
  const merged0 = { ...s, projects: rest };
  if (activeId === id) {
    const next = [...rest].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0];
    if (next) {
      activeId = next.id;
      merged0.workingDir = next.dir;
    } else {
      activeId = "";
      merged0.workingDir = s.workingDir; // текущая папка не выдёргивается, просто список пуст
    }
  }
  const merged = { ...merged0, activeProjectId: activeId };
  // Смена активного проекта (в том числе на «никакой»): сбрасываем ровно то же,
  // что и projects:activate. Найдено при выносе (1.5.187) и вылечено здесь:
  // раньше сбросы шли только при ОПУСТЕВШЕМ списке, а переключение на следующий
  // проект оставляло агента в папке удалённого (“активный репозиторий” указывал
  // на чужой клон), снимки отката — от прошлого проекта, а флаг «только что
  // склонирован» уезжал в новый проект толчком про чужой клон.
  const switched = activeId !== s.activeProjectId;
  if (switched) merged.githubRepoDir = "";
  saveSettings(merged);
  if (switched) {
    live.setLastAgentRepoDir(null);
    live.setClonedRepoPending(false);
    live.setActiveRunUndo([]);
  }
  return { ok: true, activeId };
});
}

module.exports = { registerProjectsIpc };

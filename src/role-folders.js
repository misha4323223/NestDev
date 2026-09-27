"use strict";

/* ─── Папка роли: промт роли из файла ────────────────────────────────────────
   Человек в настройках задаёт КАЖДОЙ роли (Разработчик / Ассистент / Менеджер /
   Исследователь) свою папку — и папки эти свои У КАЖДОГО ПРОЕКТА. Когда чат
   работает в этой роли, приложение читает из папки файл PROMPT.md и дописывает
   его в системный промпт (рядом с «САММАРИ ПРОЕКТА»). Так у роли появляется свой
   тон, свои правила и знание о бренде, и агенту не надо напоминать о них руками.

   Ошибается это тихо и дорого:
     • нет папки или файла — промпт обязан остаться НЕИЗМЕННЫМ (ни одного лишнего
       байта): иначе на пустой настройке поедут все замеры промпта и бюджеты;
     • файл разросся — он съест контекст целиком, поэтому чтение ОГРАНИЧЕНО
       (и «хвост» тоже сохраняем: правила бывают и в конце);
     • недоступная папка (диск отключили, путь стёрли) роняет сборку промпта —
       прогон не начинается вовсе, хотя без папки он работал бы. Поэтому любая
       ошибка чтения — это пустая строка, а не исключение.

   Модуль чистый (fs/path приходят снаружи), как src/project-brief.js. */

function createRoleFolders(deps) {
  const { fs, path } = deps;

  // Имена файла пробуем как README: регистр и расширение у людей разные.
  const PROMPT_FILES = ["PROMPT.md", "prompt.md", "Prompt.md", "PROMPT.MD", "PROMPT.txt", "prompt.txt"];
  const PROMPT_MAX_CHARS = 8000; // потолок одной вставки в промпт
  // Роль — свой текст на каждую; список ОБЯЗАН совпадать с ядром (AGENT_ROLES).
  // Совпадение держит тест test/role-folders.test.js: разойдётся — упадёт он, а не человек.
  const ROLE_IDS = ["dev", "assistant", "manager", "researcher"];

  // Путь из настроек: пробелы и хвостовые разделители снимаем (как missionsDir):
  // иначе в панели путь выглядит сломанным («D:\роли\менеджер\»).
  function cleanPath(v) {
    return typeof v === "string" ? v.trim().replace(/[\\/]+$/, "") : "";
  }

  // Раскладка папок ролей: { <projectId>: { dev, assistant, manager, researcher } }.
  // Мусор (чужие роли, не-строки, пустые записи) отбрасывается здесь — на диск и в
  // промпт уходит только понятное.
  function normalizeRoleDirs(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const pid of Object.keys(raw)) {
      const id = String(pid || "").trim();
      if (!id) continue;
      const src = raw[pid];
      if (!src || typeof src !== "object") continue;
      const one = {};
      let any = false;
      for (const role of ROLE_IDS) {
        const val = cleanPath(src[role]);
        one[role] = val;
        if (val) any = true;
      }
      if (any) out[id] = one; // совсем пустую запись проекта не держим
    }
    return out;
  }

  // Папки ролей активного проекта из настроек. Проект берём по activeProjectId,
  // как и всё остальное приложение; нет активного — папок нет.
  function dirsForSettings(settings) {
    const map = normalizeRoleDirs(settings && settings.roleDirs);
    const pid = String((settings && settings.activeProjectId) || "").trim();
    if (!pid) return null;
    return map[pid] || null;
  }

  // Путь папки КОНКРЕТНОЙ роли активного проекта (пусто — настройка не задана).
  function roleDir(settings, roleId) {
    const id = String(roleId || "").trim().toLowerCase();
    if (ROLE_IDS.indexOf(id) < 0) return "";
    const one = dirsForSettings(settings);
    return (one && one[id]) || "";
  }

  // Файл промта в папке: первый найденный из PROMPT_FILES.
  function promptFileIn(dir) {
    if (!dir) return "";
    for (const name of PROMPT_FILES) {
      try {
        const full = path.join(dir, name);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        // недоступный путь — просто пробуем следующее имя
      }
    }
    return "";
  }

  // Обрезка длинного файла с ОБОИХ концов (как truncateText в приложении):
  // начало — правила, конец — ограничения; терять второе нельзя.
  function clip(text, cap) {
    if (text.length <= cap) return text;
    const head = Math.floor(cap * 0.7);
    const tail = cap - head;
    return text.slice(0, head) + "\n… (PROMPT.md показан не целиком: " + (text.length - cap) +
      " символов пропущено; остальное читай сам — readFile)\n" + text.slice(text.length - tail);
  }

  // Чтение промта роли. Всегда объект, никогда исключение.
  function readRolePrompt(dir) {
    const clean = cleanPath(dir);
    if (!clean) return { ok: false, dir: "", file: "", name: "", text: "", error: "папка не задана" };
    const full = promptFileIn(clean);
    if (!full) return { ok: false, dir: clean, file: "", name: "", text: "", error: "нет файла PROMPT.md" };
    try {
      let text = fs.readFileSync(full, "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
      text = text.replace(/\r\n/g, "\n").trim();
      if (!text) return { ok: false, dir: clean, file: full, name: path.basename(full), text: "", error: "файл пуст" };
      return { ok: true, dir: clean, file: full, name: path.basename(full), text: clip(text, PROMPT_MAX_CHARS), error: "" };
    } catch (e) {
      return { ok: false, dir: clean, file: full, name: "", text: "", error: (e && e.message) || String(e) };
    }
  }

  // Блок в системный промпт. Пустая папка/файл/ошибка → "" (промпт не меняется).
  function blockFor(settings, roleId, roleTitle) {
    const dir = roleDir(settings, roleId);
    if (!dir) return "";
    const r = readRolePrompt(dir);
    if (!r.ok) return "";
    const title = String(roleTitle || roleId || "роль");
    return (
      "\n\n=== ПАПКА РОЛИ «" + title + "» (" + r.name + ") ===\n" +
      "Папка этой роли: " + dir + "\n" +
      "Остальные файлы роли лежат в этой же папке — при необходимости посмотри их сам (listDirectory / readFile).\n\n" +
      r.text
    );
  }

  return {
    PROMPT_FILES,
    PROMPT_MAX_CHARS,
    ROLE_IDS,
    cleanPath,
    normalizeRoleDirs,
    dirsForSettings,
    roleDir,
    promptFileIn,
    readRolePrompt,
    blockFor,
  };
}

module.exports = { createRoleFolders };

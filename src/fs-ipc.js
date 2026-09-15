"use strict";

/* ─── Файлы: каналы панели проекта ────────────────────────────────────────────
   Раньше эти десять каналов лежали в main.js между почтой и git: файл дорос до
   7,5 тысяч строк, и найти нужный обработчик можно было только поиском.

   Что внутри: карта папки для дерева (fs:listTree), чтение файла и картинки,
   создание файла и папки, запись, удаление, импорт перетащенных файлов и открытие
   в проводнике, плюс открытие ссылки в системном браузере.

   Два правила, которые здесь соблюдаются:
   - каждый путь проходит через sanitizePath/sanitizeDir: наружу можно смотреть
     только внутрь рабочей папки, иначе канал стал бы способом прочитать /etc;
   - бинарные файлы не отдаются как текст (BINARY_EXT) — иначе просмотрщик
     показывает мусор, а поиск по проекту тонет в нём.

   BINARY_EXT отдаётся наружу: по нему агент решает, стоит ли вообще открывать
   файл (main.js использует тот же список, чтобы не держать копию). */

function registerFsIpc(deps) {
  const { ipcMain, shell, path, fs, sanitizeDir, sanitizePath } = deps;

// ─────────────────────────── Файлы (панель проекта) ───────────────────────────
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svg", "avif", "heic",
  "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "sqlite3",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "jar", "apk", "ipa",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "ogg", "flac", "webm",
  "woff", "woff2", "ttf", "otf", "eot", "wasm", "pyc", "class", "lock",
]);

ipcMain.handle("fs:listTree", (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  try {
    const entries = fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.name !== ".git")
      .map((e) => {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(path.join(d, e.name));
          size = e.isFile() ? st.size : 0;
          mtime = st.mtimeMs;
        } catch {}
        return { name: e.name, isDir: e.isDirectory(), size, mtime };
      })
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, "ru")));
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle("fs:readFile", (_e, p) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Файл не найден" };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: "Это не файл" };
    const ext = path.extname(abs).toLowerCase().replace(".", "");
    if (BINARY_EXT.has(ext)) return { ok: false, error: "Бинарный файл — предпросмотр недоступен", binary: true };
    let content = fs.readFileSync(abs, "utf8");
    if (content.includes("\u0000")) return { ok: false, error: "Бинарный файл — предпросмотр недоступен", binary: true };
    let truncated = false;
    if (content.length > 300000) {
      content = content.slice(0, 300000);
      truncated = true;
    }
    return { ok: true, content, size: st.size, truncated };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle("fs:readImage", (_e, p) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Файл не найден" };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: "Это не файл" };
    if (st.size > 8 * 1024 * 1024) return { ok: false, error: "Файл слишком большой (максимум 8 МБ)" };
    const ext = path.extname(abs).toLowerCase();
    const IMG = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"];
    if (!IMG.includes(ext)) return { ok: false, error: "Не изображение" };
    const mime = ext === ".svg" ? "image/svg+xml" : "image/" + ext.slice(1);
    const dataUrl = "data:" + mime + ";base64," + fs.readFileSync(abs).toString("base64");
    return { ok: true, dataUrl, size: st.size };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// ── Файлы: ручное создание / редактирование / удаление / импорт перетаскиванием ──
function fsNameError(name) {
  const n = String(name || "").trim();
  if (!n) return "Пустое имя";
  if (n === "." || n === "..") return "Недопустимое имя: " + n;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return "Имя содержит недопустимые символы: " + n;
  if (n.length > 150) return "Имя слишком длинное (максимум 150 символов)";
  return null;
}

ipcMain.handle("fs:createFile", (_e, dir, name, content) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const err = fsNameError(name);
  if (err) return { ok: false, error: err };
  const target = path.join(d, String(name).trim());
  if (fs.existsSync(target)) return { ok: false, error: "Файл уже существует: " + target };
  try {
    fs.writeFileSync(target, content == null ? "" : String(content), "utf8");
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)) + " — проверь права на запись в папку." };
  }
});

ipcMain.handle("fs:createFolder", (_e, dir, name) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const err = fsNameError(name);
  if (err) return { ok: false, error: err };
  const target = path.join(d, String(name).trim());
  if (fs.existsSync(target)) return { ok: false, error: "Папка уже существует: " + target };
  try {
    fs.mkdirSync(target, { recursive: false });
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)) + " — проверь права на запись в папку." };
  }
});

ipcMain.handle("fs:writeFile", (_e, p, content) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Файл не найден" };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: "Это не файл" };
    const text = content == null ? "" : String(content);
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) return { ok: false, error: "Слишком большой файл для сохранения из панели (максимум 2 МБ)" };
    fs.writeFileSync(abs, text, "utf8");
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)) + " — проверь права на запись." };
  }
});

ipcMain.handle("fs:delete", (_e, p) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Путь не найден" };
  try {
    const isDir = fs.statSync(abs).isDirectory();
    fs.rmSync(abs, { recursive: true, force: true });
    return { ok: true, deleted: abs, isDir };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Импорт перетаскиванием: items = [{ src, rel }] — src абсолютный путь на диске,
// rel — относительный путь внутри targetDir (может содержать подпапки).
ipcMain.handle("fs:importDropped", async (_e, targetDir, items) => {
  const d = sanitizeDir(targetDir);
  if (!d) return { ok: false, error: "Папка назначения не найдена" };
  if (!Array.isArray(items)) return { ok: false, error: "Нет данных для импорта" };
  const created = [];
  const errors = [];
  for (const it of items) {
    const src = it && typeof it.src === "string" ? it.src : "";
    const rel = String((it && it.rel) || "").split(/[\\/]/).map((x) => x.trim()).filter(Boolean).join("/");
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      if (src) errors.push((it.name || src) + " — источник не найден");
      continue;
    }
    if (!rel) continue;
    const bad = rel.split("/").some((part) => fsNameError(part));
    if (bad) { errors.push(rel + " — недопустимое имя"); continue; }
    const dest = path.join(d, rel);
    if (!dest.startsWith(d + path.sep)) { errors.push(rel + " — недопустимый путь"); continue; }
    if (fs.existsSync(dest)) {
      // не перезаписываем молча — добавляем суффикс -2, -3…
      const ext = path.extname(dest);
      const base = dest.slice(0, dest.length - ext.length);
      let i = 2;
      let final = path.join(path.dirname(dest), path.basename(base) + "-" + i + ext);
      while (fs.existsSync(final)) { i++; final = path.join(path.dirname(dest), path.basename(base) + "-" + i + ext); }
      try {
        fs.mkdirSync(path.dirname(final), { recursive: true });
        fs.copyFileSync(src, final);
        created.push(final);
      } catch (e) {
        errors.push(path.basename(final) + " — " + (e.message || String(e)));
      }
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      created.push(dest);
    } catch (e) {
      errors.push(rel + " — " + (e.message || String(e)));
    }
  }
  return { ok: created.length > 0 || errors.length === 0, created, errors };
});

ipcMain.handle("fs:openInExplorer", (_e, p) => {
  const abs = sanitizePath(p);
  if (abs) shell.showItemInFolder(abs);
  return true;
});

ipcMain.handle("shell:openExternal", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

  return { BINARY_EXT };
}

module.exports = { registerFsIpc };

"use strict";

/* ─── Файлы для облака: системные диалоги выбора файла и места сохранения ─────
   Зачем отдельный модуль. У окна был ровно ОДИН системный диалог — выбор папки
   (`dialog:pickDir` в src/settings-ipc.js). Для Object Storage его мало: чтобы
   положить файл в бакет, надо выбрать ФАЙЛ, а чтобы забрать объект к себе —
   назвать, КУДА его сохранить. Оба вопроса задаёт человек в системном окне, и
   ответ — путь на диске.

   Почему не в settings-ipc.js. Тот модуль держит ровно шесть каналов и это
   проверяется набором (`test/settings-ipc.test.js`): настройки, группы выдачи,
   папки работы агента и выбор рабочей папки — один предмет. Файл в бакете и
   папка работы агента — разные вещи, поэтому две новые ручки живут своим
   модулем, а «сколько каналов у настроек» остаётся ровно тем же.

   Что модуль НЕ делает. Он не читает файлы и не ходит в облако: он только
   спрашивает путь и возвращает его наружу. Размер файла отдаётся тем же
   ответом (он нужен, чтобы сразу сказать «это не залить»), но читает байты и
   кладёт их в бакет канал `yc:storage` — там же, где живёт предел одного
   запроса. Так у предела ОДНА копия, и модуль не может с ним разойтись.

   Родитель диалога — ЖИВОЕ окно: оно создаётся позже сборки модуля,
   пересоздаётся и закрывается, поэтому приходит функцией. Без живого окна
   диалог всё равно открывается, просто без родителя — иначе на закрытом окне
   Electron бросил бы ошибку и выбор файла не работал бы вовсе. */

function registerCloudFilesIpc(deps) {
  const { ipcMain, dialog, path, fs, getWindow, ipcGuard } = deps;
  // Кто позвал: диалог открывается поверх рабочего стола человека, поэтому его
  // не должен звать ни телефон, ни чужой рендерер.
  const deniedFor = (e, channel) => ipcGuard.denyReason(e, { window: getWindow ? getWindow() : null, channel });
  const parentOf = () => {
    const w = getWindow ? getWindow() : null;
    return w && !w.isDestroyed() ? w : undefined;
  };
  const startDirOf = (v) => {
    const s = String(v || "").trim();
    if (!s) return "";
    try {
      return fs.statSync(s).isDirectory() ? s : path.dirname(s);
    } catch {
      return ""; // папки больше нет — открываем диалог во «Загрузках», а не падаем
    }
  };

  // ── Выбрать файл, который положить в бакет ────────────────────────────────
  // Возвращаем путь, имя и размер: канал `yc:storage` покажет имя в поле «Ключ»
  // и откажет ДО запроса, если файл больше предела одного запроса.
  ipcMain.handle("cloud:pickFile", async (e, args) => {
    const bad = deniedFor(e, "cloud:pickFile");
    if (bad) return bad;
    const a = args || {};
    const opts = { properties: ["openFile"], title: "Выберите файл для загрузки в бакет" };
    const start = startDirOf(a.startDir);
    if (start) opts.defaultPath = start;
    const r = await dialog.showOpenDialog(parentOf(), opts);
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      size = 0; // файл исчез между выбором и чтением — размер покажем нулём
    }
    return { path: p, name: path.basename(p), size: size, dir: path.dirname(p) };
  });

  // ── Назвать, куда сохранить скачанный объект ──────────────────────────────
  // Имя объекта предлагаем по умолчанию: у ключа бакета оно уже есть, и
  // заставлять человека печатать его заново незачем.
  ipcMain.handle("cloud:pickSave", async (e, args) => {
    const bad = deniedFor(e, "cloud:pickSave");
    if (bad) return bad;
    const a = args || {};
    const opts = { title: "Куда сохранить объект из бакета" };
    const name = String(a.name || "").trim();
    const start = startDirOf(a.startDir);
    if (name && start) opts.defaultPath = path.join(start, name);
    else if (name) opts.defaultPath = name;
    else if (start) opts.defaultPath = start;
    const r = await dialog.showSaveDialog(parentOf(), opts);
    if (!r || r.canceled || !r.filePath) return null;
    return { path: r.filePath, name: path.basename(r.filePath) };
  });
}

module.exports = { registerCloudFilesIpc };

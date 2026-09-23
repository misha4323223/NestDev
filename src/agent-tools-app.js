"use strict";

/* ─── Инструменты окна приложения и рабочего стола ───────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 8). Здесь двенадцать обработчиков:

     • окно САМОГО приложения — appRead/appClick/appFill/appSelect/appPress/
       appWait/appScreenshot (работу делает app-ui-tools.js, модуль только
       передаёт ему живое окно);
     • askUser / suggestRole — заглушки: эти инструменты обрабатываются отдельно,
       самим прогоном (он ждёт ответа человека и подставляет его в историю), поэтому
       здесь только честный отказ, если вызов дошёл до реестра;
     • буфер обмена (clipboardRead/clipboardWrite) и скриншот ЭКРАНА
       (screenshotDesktop) — системные возможности главного процесса;
     • openPath — открыть файл или папку системным приложением.

   Живой мост нужен: окно приложения и отправитель событий живут в main.js (окно
   меняется, а картинка скриншота сразу уходит в ленту событием). Остальное
   приходит в deps.
   Тела перенесены ПОБАЙТОВО, порядок инструментов в реестре сохранён ссылками. */

function createAppTools(deps, live) {
  const {
    appUi,
    clipboard,
    desktopCapturer,
    encodeShot,
    saveScreenshotPng,
    truncateText,
    resolvePath,
    fs,
    shell,
  } = deps;

  return {
    "appRead": async (args, settings) => {
        return await appUi.read(args, live.mainWindow);
    },
    "appClick": async (args, settings) => {
        return await appUi.click(args, live.mainWindow);
    },
    "appFill": async (args, settings) => {
        return await appUi.fill(args, live.mainWindow);
    },
    "appSelect": async (args, settings) => {
        return await appUi.select(args, live.mainWindow);
    },
    "appPress": async (args, settings) => {
        return await appUi.press(args, live.mainWindow);
    },
    "appWait": async (args, settings) => {
        return await appUi.wait(args, live.mainWindow);
    },
    "appScreenshot": async (args, settings) => {
        const dataUrl = await appUi.screenshot(args, live.mainWindow);
        if (live.activeEmit) live.activeEmit({ type: "image", path: "app:window", dataUrl });
        return "OK — скриншот окна приложения снят и показан во встроенном просмотрщике. Детали разбирай через analyzeImage.";
    },
    "askUser": async (args, settings) => {
        return "Ошибка: askUser обрабатывается отдельно — дождись ответа пользователя.";
    },
    "suggestRole": async (args, settings) => {
        return "Ошибка: suggestRole обрабатывается отдельно — окно покажет кнопку смены роли, а прогон дождётся ответа человека.";
    },
    "clipboardWrite": async (args, settings) => {
        const text = String(args.text == null ? "" : args.text);
        try {
          await clipboard.writeText(text);
        } catch (e) {
          return "Ошибка: не удалось записать в буфер обмена: " + (e.message || String(e));
        }
        return "OK — текст скопирован в буфер обмена (" + text.length + " симв.).";
    },
    "clipboardRead": async (args, settings) => {
        let text = "";
        try {
          text = String((await clipboard.readText()) || "");
        } catch (e) {
          return "Ошибка: не удалось прочитать буфер обмена: " + (e.message || String(e));
        }
        if (!text.trim()) return "Буфер обмена пуст (текста нет).";
        return "Содержимое буфера обмена:\n\n" + truncateText(text, 4000);
    },
    "screenshotDesktop": async (args, settings) => {
        const winFilter = String(args.window || "").trim().toLowerCase();
        let sources = [];
        try {
          sources = await desktopCapturer.getSources({
            types: winFilter ? ["window"] : ["screen"],
            thumbnailSize: { width: 1920, height: 1080 },
            fetchWindowIcons: false,
          });
        } catch (e) {
          return "Ошибка захвата экрана: " + (e.message || String(e)) + " (работает только в десктоп-приложении).";
        }
        let src = sources[0];
        if (winFilter) src = sources.find((s) => s.name.toLowerCase().indexOf(winFilter) !== -1) || sources[0];
        if (!src) return "Не удалось получить источники экрана/окон.";
        const shot = encodeShot(src.thumbnail, args);
        if (!shot.buf || !shot.buf.length) return "Пустой скриншот «" + src.name + "» — не удалось захватить.";
        const sz = src.thumbnail.getSize();
        const dataUrl = "data:" + shot.mime + ";base64," + shot.buf.toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: "desktop:" + src.name, dataUrl });
        let saved = null;
        try {
          if (shot.buf.length) saved = saveScreenshotPng(shot.buf, "screen", shot.mime);
        } catch {}
        return "OK — скриншот «" + src.name + "» (" + sz.width + "×" + sz.height + ") снят, показан пользователю во встроенном просмотрщике" +
          (saved ? " и сохранён: " + saved : "") +
          ". Чтобы понять, что на экране, вызови analyzeImage(path: '" + (saved || "") + "') — вернёт описание вспомогательной vision-моделью.";
    },
    "openPath": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: путь не найден: " + p;
        const err = await shell.openPath(p);
        return err ? "Не удалось открыть: " + err : "OK — открыто системным приложением: " + p;
    },
  };
}

module.exports = { createAppTools };

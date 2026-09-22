"use strict";

/* ─── Инструменты медиа, просмотра и справки ─────────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 10). Здесь десять обработчиков,
   которыми агент показывает и разбирает картинки, открывает ссылки и просмотрщики,
   ловит кадр экрана и ищет подходящие инструменты:

     • findTools — поиск инструмента по словам и подключение его группы схем
       (живой роутер: он знает, что уже помещается в окно модели, поэтому модуль
       берёт его ЖИВЫМ, а не копией);
     • openUrl — ссылка системным браузером; showImage/previewUI — показать картинку
       и открыть просмотрщик (событием в ленту через live.activeEmit);
     • analyzeImage — разбор картинки вспомогательной vision-моделью, а если её нет —
       честный отказ с объяснением, каким должно быть соединение;
     • generateImage — картинка по описанию вспомогательной моделью (с тем же
       честным отказом), имя файла берётся из ответа модели;
     • diffView — сравнить два файла (патч уходит событием в просмотрщик приложения);
     • screenshotCapture — кадр экрана/окна, догружается до папки скриншотов;
     • waitForIdle — пауза до покоя прогона;
     • agentGuide — справка по возможностям приложения из data-файлов.

   Живой мост нужен: роутер инструментов и отправитель событий живут в main.js и
   меняются по ходу работы. Тела перенесены ПОБАЙТОВО, порядок инструментов в
   реестре сохранён ссылками. */

function createMediaTools(deps, live) {
  const {
    agentGuideCall,
    agentWorkDir,
    auxConfig,
    browserTools,
    describeImageRemote,
    fmtError,
    generateImageRemote,
    resolvePath,
    saveScreenshotPng,
    screenshotUrl,
    searchTools,
    shell,
    truncateText,
    unifiedDiff,
    fs,
    path,
  } = deps;

  return {
    "findTools": async (args, settings) => {
        const query = String(args.query || "").trim();
        if (!query) return "Укажи query — что нужно сделать словами (например «отправить письмо»).";
        const found = searchTools(query, args.limit);
        if (!found.length) {
          return "Ничего не нашлось по запросу «" + query + "». Сформулируй иначе (действие + объект: «клик по элементу страницы», «запуш ветки») или используй runCommand.";
        }
        const groups = [...new Set(found.map((f) => f.group).filter(Boolean))];
        if (live.activeToolRouter && groups.length) live.activeToolRouter.addGroups(groups);
        // Схемы могут НЕ поместиться в узкое окно модели (группа включается, а вес не лезет).
        // Раньше ответ безусловно обещал «схемы уже добавлены», и модель ждала, что вызов
        // сработает сам. Говорим, что реально в запросе сейчас, а что видно только по имени.
        const inSchemas = live.activeToolRouter ? live.activeToolRouter.names() : [];
        const missing = found.filter((f) => inSchemas.indexOf(f.name) < 0).map((f) => f.name);
        return (
          "Нашёл инструменты по запросу «" + query + "»:\n" +
          found.map((f) => "• " + f.name + (f.group ? " [" + f.group + "]" : "") + " — " + truncateText(f.description, 160)).join("\n") +
          (groups.length ? "\nВключены группы: " + groups.join(", ") + "." : "") +
          (missing.length
            ? "\n⚠ В набор схем не поместились (узкое окно модели): " + missing.join(", ") +
              ". Вызывай их так же по имени — вызов выполнится, просто схема не отправлена."
            : "\nВсе найденные инструменты уже в запросе — вызывай как обычно.") +
          (live.activeToolRouter ? "\nСейчас в запросе " + inSchemas.length + " инструментов." : "")
        );
    },
    "openUrl": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^(https?|file):\/\//i.test(url)) return "Ошибка: укажи полный URL";
        shell.openExternal(url).catch(() => {});
        return "OK — открыто в браузере: " + url;
    },
    "showImage": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const ext = path.extname(p).toLowerCase();
        const IMG_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"];
        if (!IMG_EXTS.includes(ext)) return "Ошибка: это не изображение (" + (ext || "без расширения") + "). Поддерживаются: " + IMG_EXTS.join(", ");
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Максимум 8 МБ.";
        const IMG_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif" };
        const dataUrl = "data:" + (IMG_MIME[ext] || "image/png") + ";base64," + fs.readFileSync(p).toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: p, dataUrl });
        return "OK — изображение показано пользователю: " + p + " (" + st.size + " байт)";
    },
    "analyzeImage": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const ext = path.extname(p).toLowerCase();
        const IMG_EXTS_AN = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"];
        if (!IMG_EXTS_AN.includes(ext)) return "Ошибка: это не изображение (" + (ext || "без расширения") + "). Поддерживаются: " + IMG_EXTS_AN.join(", ");
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Максимум 8 МБ.";
        const dataUrl = "data:image/" + (ext === ".svg" ? "svg+xml" : ext.slice(1)) + ";base64," + fs.readFileSync(p).toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: p, dataUrl });
        const cfg = auxConfig(settings);
        if (!cfg.enabled) return "Ошибка: вспомогательная модель выключена. Включи «🖼 Зрение и генерация» в Настройках.";
        if (!cfg.visionModel) return "Ошибка: не указана модель для чтения изображений (поле «Модель-зрение» в Настройках).";
        const question = args.question || "Опиши подробно, что изображено на картинке: объекты, текст, UI, цвета, расположение. Это описание пойдёт программисту.";
        try {
          const desc = await describeImageRemote(cfg, dataUrl, question, cfg.visionModel);
          return "Описание изображения (" + p + "):\n" + (desc || "(пусто)") + "\n\nЕсли пользователь ждёт правок по этой картинке — вноси изменения и сообщи итог.";
        } catch (e) {
          return "Ошибка анализа изображения: " + fmtError(e) + ". Проверь ключ и модель-зрение в Настройках → «🖼 Зрение и генерация».";
        }
    },
    "generateImage": async (args, settings) => {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return "Ошибка: укажи prompt — текстовое описание картинки.";
        const cfg = auxConfig(settings);
        if (!cfg.enabled) return "Ошибка: вспомогательная модель выключена. Включи «🖼 Зрение и генерация» в Настройках.";
        if (!cfg.imageModel) return "Ошибка: не указана модель для генерации картинок (поле «Модель-генерация» в Настройках).";
        let name = String(args.filename || "").trim();
        if (!name) name = "generated-" + Date.now() + ".png";
        name = path.basename(name).replace(/[^\w.\-]+/g, "_");
        const extG = path.extname(name).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp"].includes(extG)) name += ".png";
        const out = path.join(agentWorkDir(settings), name);
        try {
          // Ядро отдаёт base64 (оно же работает в браузере, где нет Buffer),
          // файл на диск пишет главный процесс.
          const img = await generateImageRemote(cfg, prompt, cfg.imageModel, { aspectRatio: args.aspect_ratio });
          const buf = Buffer.from(img.b64, "base64");
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, buf);
          const dataUrl = "data:" + img.mediaType + ";base64," + img.b64;
          if (live.activeEmit) live.activeEmit({ type: "image", path: out, dataUrl });
          return "OK — изображение сгенерировано и сохранено: " + out + " (" + buf.length + " байт, " + img.mediaType + ", провайдер: " + img.label + "). Превью уже показано пользователю. Встраивай файл в проект (относительный путь: " + name + ")."
        } catch (e) {
          // Подробности (адрес, все попытки, код и тело ответа) уже внутри ошибки
          // из ядра — здесь только напоминаем, где смотреть настройки.
          return (
            "Ошибка генерации изображения: " + fmtError(e) +
            "\nВспомогательная модель: " + (cfg.url || "адрес не задан") + " · модель «" + (cfg.imageModel || "не задана") + "». Тип подключения приложение определяет по адресу само."
          );
        }
    },
    "diffView": async (args, settings) => {
        const p1 = resolvePath(args.path1, settings);
        const p2 = resolvePath(args.path2, settings);
        if (!fs.existsSync(p1)) return "Ошибка: не найден путь: " + p1;
        if (!fs.existsSync(p2)) return "Ошибка: не найден путь: " + p2;
        const r = await unifiedDiff(p1, p2);
        if (!r.patch) return "Файлы идентичны: " + p1 + " = " + p2;
        if (live.activeEmit) live.activeEmit({ type: "diff", a: p1, b: p2, patch: r.patch });
        return "Дифф " + p1 + " ↔ " + p2 + " (открыт в просмотрщике приложения):\n\n" + truncateText(r.patch, 8000);
    },
    "previewUI": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL вида http://localhost:3000";
        if (live.activeEmit) live.activeEmit({ type: "preview", url });
        return "OK — открыт встроенный предпросмотр: " + url + " (закрывается кнопкой ✕ в углу окна предпросмотра)";
    },
    "screenshotCapture": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL вида http://localhost:3000";
        const shot = await screenshotUrl(url);
        if (!shot.ok) return "Ошибка скриншота: " + shot.err;
        if (live.activeEmit) live.activeEmit({ type: "image", path: url, dataUrl: shot.dataUrl });
        let saved = null;
        try {
          const buf = Buffer.from(String(shot.dataUrl).split(",")[1] || "", "base64");
          if (buf.length) saved = saveScreenshotPng(buf, "page", shot.mime);
        } catch {}
        return "OK — скриншот " + url + " снят (1280×800), показан пользователю во встроенном просмотрщике" +
          (saved ? " и сохранён: " + saved : "") +
          ". Чтобы понять, что на экране, вызови analyzeImage(path: '" + (saved || "") + "') — вернёт описание вспомогательной vision-моделью.";
    },
    "waitForIdle": async (args, settings) => {
        return await browserTools.waitForIdle(args);
    },
    "agentGuide": async (args, settings) => {
        return agentGuideCall(args);
    },
  };
}

module.exports = { createMediaTools };

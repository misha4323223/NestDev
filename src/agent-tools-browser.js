"use strict";

/* ─── Агентские инструменты: браузер агента ──────────────────────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 13). Двадцать один обработчик:

     • сессия и вкладки: browserConnect (подключиться к своему Chrome по CDP), browserOpen
       (открыть адрес; если по сайту есть справочник — он называется сразу), browserClose,
       browserStatus, browserClearProfile;
     • действия на странице: browserSnapshot (карта с ref), browserFill, browserClick,
       browserAct (составное действие), browserSelect, browserPress, browserText,
       browserScroll, browserHover, browserWait (покой);
     • разбор страницы: browserEval (JS на странице), browserDOM (HTML слоя),
       browserOverlays (слои и помехи), browserNetwork (сеть вкладки), browserReplay
       (повтор прогона шагов);
     • browserScreenshot: снимок сохраняется ФАЙЛОМ (data URL в контексте — это десятки
       тысяч токенов), картинка уходит человеку СОБЫТИЕМ, а если настроено зрение —
       разбирается вспомогательной моделью; модель не ответила — честно об этом говорим.

   Тела перенесены ПОБАЙТОВО, порядок инструментов в реестре сохранён ссылками
   agentBrowser.имя (имя именно agentBrowser: browserTools занято настоящим браузерным
   набором из deps).

   Живой мост НУЖЕН одному обработчику: browserScreenshot кладёт картинку в ленту через
   live.activeEmit. Всё остальное приходит тем же плоским deps: сам браузерный набор
   browserTools, справочник по адресу guideForUrl, path и os (папка для снимков во
   временной папке системы), auxConfig и describeImageRemote (зрение вспомогательной модели). */

function createBrowserTools(deps, live) {
  const {
    browserTools,
    guideForUrl,
    path,
    os,
    auxConfig,
    describeImageRemote,
  } = deps;

  return {
    "browserConnect": async (args, settings) => {
        return await browserTools.connect(args);
    },
    "browserOpen": async (args, settings) => {
        const opened = await browserTools.open(args);
        // Есть справочник по этому сайту — говорим сразу, а не после блужданий.
        if (typeof opened === "string" && !/^Ошибка/.test(opened)) {
          const g = guideForUrl(args && args.url);
          if (g) {
            return (
              opened +
              "\n📘 По этому сайту есть справочник агента «" + g.name + "»" + (g.title ? " (" + g.title + ")" : "") +
              " — прочитай ПЕРЕД действиями: agentGuide { name: \"" + g.name + "\" } (маршруты, подводные камни, селекторы)."
            );
          }
        }
        return opened;
    },
    "browserSnapshot": async (args, settings) => {
        return await browserTools.snapshot(args);
    },
    "browserFill": async (args, settings) => {
        return await browserTools.fill(args);
    },
    "browserClick": async (args, settings) => {
        return await browserTools.click(args);
    },
    "browserAct": async (args, settings) => {
        return await browserTools.act(args);
    },
    "browserSelect": async (args, settings) => {
        return await browserTools.select(args);
    },
    "browserPress": async (args, settings) => {
        return await browserTools.press(args);
    },
    "browserText": async (args, settings) => {
        return await browserTools.text(args);
    },
    "browserScreenshot": async (args, settings) => {
        // Скриншот сохраняем ФАЙЛОМ (data URL в контексте агента — это десятки
        // тысяч токенов). Файл показываем пользователю и, если настроено зрение,
        // разбираем vision-моделью. Модель может не ответить — тогда честно
        // говорим об этом и оставляем агенту пути по DOM.
        const shotDir = path.join(os.tmpdir(), "ai-agent-shots");
        const shot = await browserTools.screenshotFile(Object.assign({}, args, { dir: shotDir }));
        if (shot.error) return shot.error;
        const shotData = "data:image/png;base64," + shot.buf.toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: shot.path, dataUrl: shotData });
        let shotOut =
          "OK — скриншот сохранён" + (shot.path ? ": " + shot.path : " (файл записать не удалось, картинка показана в чате)") +
          "\nСтраница: " + (shot.url || "—") + (shot.title ? " («" + shot.title + "»)" : "");
        const vcfg = auxConfig(settings);
        if (args && args.analyze === false) {
          shotOut += "\nДальше: analyzeImage { path: \"" + shot.path + "\" } при необходимости.";
        } else if (vcfg.visionModel && vcfg.key) {
          // Зрение включается, как только указана модель и есть ключ (галочка «Зрение»
          // лишь разрешает авто-пре-пасс присланных картинок). Спрашиваем про кликабельное:
          // карта DOM врёт на кастомных компонентах, а разбор скриншота — нет.
          try {
            const q =
              args && args.question
                ? String(args.question)
                : "Разбери скриншот страницы как инструкцию к действию, коротко и по делу: 1) что это за экран (сайт, диалог, шаг); 2) какие элементы КЛИКАБЕЛЬНЫ (кнопки, ссылки, вкладки, чекбоксы) — их точные подписи; 3) какие поля ввода и что в них; 4) что мешает (баннеры, согласия, перекрытия) и что нажать, чтобы их убрать; 5) что находится ЗА пределами экрана (видно начало списка/край элемента). Без воды — это уйдёт программисту, который видит только текст.";
            const desc = await describeImageRemote(vcfg, shotData, q, vcfg.visionModel);
            shotOut += "\n\nЧто видно (vision-модель):\n" + (desc || "(пусто)");
          } catch (e) {
            shotOut +=
              "\n\nVision-модель не ответила (" + String((e && e.message) || e).slice(0, 120) + ") — это не блокер: работай по DOM." +
              "\nbrowserSnapshot (карта с ref) · browserDOM (HTML слоя) · browserEval (JS на странице) · browserOverlays (слои и помехи).";
          }
        } else {
          shotOut +=
            "\n\nЗрение не настроено — работай по DOM: browserSnapshot, browserDOM, browserEval, browserOverlays." +
            "\nЧтобы я видел страницу: Настройки → вкладка «Зрение» → включи и укажи модель (например gemini-2.5-flash), затем повтори скриншот.";
        }
        return shotOut;
    },
    "browserEval": async (args, settings) => {
        return await browserTools.evalJs(args);
    },
    "browserDOM": async (args, settings) => {
        return await browserTools.domHtml(args);
    },
    "browserOverlays": async (args, settings) => {
        return await browserTools.overlays(args);
    },
    "browserWait": async (args, settings) => {
        return await browserTools.wait(args);
    },
    "browserScroll": async (args, settings) => {
        return await browserTools.scroll(args);
    },
    "browserHover": async (args, settings) => {
        return await browserTools.hover(args);
    },
    "browserNetwork": async (args, settings) => {
        return await browserTools.network(args);
    },
    "browserReplay": async (args, settings) => {
        return await browserTools.replay(args);
    },
    "browserClose": async (args, settings) => {
        return await browserTools.close(args);
    },
    "browserStatus": async (args, settings) => {
        return await browserTools.status();
    },
    "browserClearProfile": async (args, settings) => {
        return await browserTools.clearProfile();
    },
  };
}

module.exports = { createBrowserTools };

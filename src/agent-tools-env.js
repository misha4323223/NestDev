"use strict";

/* ─── Агентские инструменты: окружение агента и OTA ──────────────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 12). Шесть обработчиков:

     • envSet / envList / envUnset — переменные окружения, которые агент подставляет
       своим командам. Значения НЕ выводятся в чат: envList показывает только имена,
       длины и то, кому переменная выдана (scopes);
     • otaStatus / otaCheck / otaRollback — самосовершенствование (OTA): что
       установлено, применить свежий набор на ходу и откатиться к предыдущему.

   Живой мост НУЖЕН ветке окружения: набор значений и «кому выдана» живут в main.js
   и меняются на ходу (свойство-доступор, а не копия). OTA-веткам мост не нужен —
   они читают настройки в момент вызова.
   Тела перенесены ПОБАЙТОВО, порядок инструментов в реестре сохранён ссылками. */

function createEnvTools(deps, live) {
  const {
    applyAgentEnv,
    loadSettings,
    saveSettings,
    ycAutoEnv,
    ota,
  } = deps;

  return {
    "envSet": async (args, settings) => {
        const key = String(args.key || "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return "Ошибка: имя переменной должно быть вида DATABASE_URL (латиница, цифры, подчёркивание)";
        }
        const value = String(args.value ?? "");
        const s = loadSettings();
        live.userAgentEnv[key] = value;
        // Читаем ИМЕННО через мост: после разреза модуля «голое» имя main.js здесь
        // недоступно — было ReferenceError, и envSet отвечал ошибкой вместо работы.
        s.agentEnv = { ...live.userAgentEnv };
        // Выдача: вручную ограничить, кому переменная подставляется. Без scopes —
        // как раньше, всем командам агента. Имена проверяет политика при сохранении.
        const askedScope = args.scopes !== undefined;
        if (askedScope) {
          const list = Array.isArray(args.scopes) ? args.scopes : [args.scopes];
          s.agentEnvScopes = { ...(s.agentEnvScopes || {}), [key]: list };
        }
        saveSettings(s);
        applyAgentEnv(s);
        const scopeNote = askedScope ? " Выдача: " + live.scopeSummary(key) + "." : "";
        const who = askedScope
          ? " Значение получат только названные команды."
          : " Она подставляется командам агента (всем, пока не ограничишь выдачу).";
        return "OK — переменная " + key + " задана." + scopeNote + who + " Значение в чат не выводится.";
    },
    "envList": async (args, settings) => {
        const keys = Object.keys(live.agentEnv);
        if (!keys.length) return "Переменные окружения агента не заданы. Задай через envSet(key, value).";
        const auto = ycAutoEnv(loadSettings());
        return "Доступные переменные (" + keys.length + "):\n" +
          keys.map((k) => {
            const v = String(live.agentEnv[k] || "");
            const scope = live.scopeSummary ? live.scopeSummary(k) : "";
            return "• " + k + " — установлена (" + v.length + " симв.)" + (k in auto ? " [авто: Yandex Cloud]" : "") + (scope ? " [выдача: " + scope + "]" : "");
          }).join("\n") +
          "\n\nЗначения скрыты — их получают только те команды, которым переменная выдана.";
    },
    "envUnset": async (args, settings) => {
        const key = String(args.key || "").trim();
        if (!key) return "Ошибка: укажи key";
        const auto = ycAutoEnv(loadSettings());
        if (!(key in live.userAgentEnv)) {
          if (key in auto) {
            return "Переменная " + key + " подставляется автоматически из настроек Yandex Cloud (Настройки → Yandex Cloud) — вручную её убрать нельзя.";
          }
          return "Переменная «" + key + "» не задана.";
        }
        const s = loadSettings();
        delete live.userAgentEnv[key];
        s.agentEnv = { ...live.userAgentEnv };
        saveSettings(s);
        applyAgentEnv(s);
        return "OK — переменная " + key + " удалена.";
    },
    "otaStatus": async (args, settings) => {
        const os = ota.status(loadSettings());
        return (
          "OTA-статус:\n" +
          "• Включено: " + (os.enabled ? "да" : "нет — включи в настройках «🔄 Самосовершенствование (OTA)»\n") +
          "• Установленная версия кода: " + os.installed + "\n" +
          "• Папка OTA: " + os.dir + "\n" +
          "• Источники бандлов: " + (os.sources && os.sources.length ? "\n  " + os.sources.join("\n  ") : "—")
        );
    },
    "otaCheck": async (args, settings) => {
        const oc = await ota.check(loadSettings());
        if (oc.status === "disabled") return "OTA отключено в настройках (галочка «Разрешить локальные обновления на ходу»).";
        if (oc.status === "busy") return "Сейчас идёт работа агента — применять обновление нельзя. Бандл применится автоматически в течение минуты после завершения задачи.";
        if (oc.status === "applied") return "✅ Обновление применено до версии " + oc.version + " — приложение перезапускается с новым кодом.";
        if (oc.status === "error") return "Ошибка применения OTA: " + (oc.message || "неизвестная") + "\nПроверь синтаксис изменённых файлов (node --check) и пересобери бандл (node scripts/make-ota.js).";
        return "Обновлений нет — код актуален.";
    },
    "otaRollback": async (args, settings) => {
        if (global.__agentRunning) return "Нельзя откатываться во время работы агента — дождись завершения текущей задачи.";
        const or = ota.rollback();
        return or.ok ? "↩ Откат выполнен — приложение перезапускается с предыдущей версией кода." : "Ошибка отката: " + (or.message || "предыдущей версии нет");
    },
  };
}

module.exports = { createEnvTools };

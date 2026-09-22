"use strict";

/* ─── Облачные инструменты агента: Yandex Cloud ─────────────────────────────
   Вынесены из agent-tools.js своим модулем (этап «дробление крупных модулей»,
   часть 40, заход 1): девять обработчиков облака — визитка сервиса (ycStatus),
   список ресурсов (ycList), создание (ycCreate), стоимость (ycCosts), удаление
   (ycDelete), выкладка (ycDeploy), контейнеры и ревизии (ycContainer), логи
   (ycLogs) и установка yc CLI (ycInstall).

   Тела перенесены ПОБАЙТОВО (сверка `fn.toString()` до/после): поведение не
   менялось ни на строку.

   Почему этот шов. Ни один из обработчиков не трогает живое состояние прогона
   (мост `live`), не зовёт помощников ребра «миссия прогона» (missionOfRun,
   notifyMission) и не пользуется общими помощниками файла (checkWrittenFile,
   envNoteFor). Всё нужное приходит в `deps` — тем же плоским объектом, что и в
   agent-tools.js, поэтому проводка в main.js осталась как была.

   Модуль чистый: Electron не тянет и состояния уровня файла не держит — его
   можно проверить в обычном Node (та же конвенция, что у createYcService и
   createDeployEngine). */

function createCloudTools(deps) {
  const {
    path,
    fs,
    secrets,
    yandexCloud,
    ycLogs,
    loadSettings,
    resolvePath,
    agentWorkDir,
    ycCosts,
    ycConfig,
    ycFindContainerByRef,
    ycActiveRevision,
    ycJsonArg,
    ycRevisionLine,
    ycRevisionDetails,
    readYcLogsText,
    ycCliStatus,
    ycCliInstall,
    ycIamEnvToken,
    applyAgentEnv,
    runCloudDeploy,
    cloudDeployBrief,
  } = deps;

  return {
    "ycStatus": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) {
          return "Yandex Cloud не подключён. Скажи пользователю: Настройки → «☁️ Yandex Cloud» → получить OAuth-токен и вставить его. После авторизации инструмент заработает.";
        }
        if (!cfg.folderId) return "Авторизация есть, но не выбран каталог. Открой Настройки → Yandex Cloud и выбери каталог (или дождись, пока приложение выберет первый автоматически).";
        try {
          const svcs = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
          const rows = svcs.map((s) => "• " + s.icon + " " + s.title + ": " + (s.ok ? s.count : "ошибка: " + String(s.error || "").slice(0, 120)));
          return (
            "Yandex Cloud · каталог «" + cfg.folderName + "» (" + cfg.folderId + ")\n" +
            "Создание агентом: " + (cfg.allowCreate ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n" +
            "Удаление агентом: " + (cfg.allowDelete ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n" +
            "Правка контейнеров (ycContainer: ревизии, откат, настройки): " + (cfg.allowUpdate ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n\nРесурсы:\n" +
            rows.join("\n") +
            cloudDeployBrief(agentWorkDir(loadSettings())) +
            "\n\nСоздание: ycCreate(service, name). Доступны: " + yandexCloud.creatableKeys().join(", ") + ". Удаление: ycDelete(service, id) — id виден в ycList." +
    "\nСтоимость: ycCosts(service) — проверь ДО создания и назови ориентир пользователю. Платное создаётся только с confirm: true после его согласия."
          );
        } catch (e) {
          return "Ошибка Yandex Cloud: " + ((e && e.message) || String(e));
        }
    },
    "ycList": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → Yandex Cloud.";
        const serviceKey = String(args.service || args.key || "").trim();
        const svcDef = serviceKey ? yandexCloud.serviceByKey(serviceKey) : null;
        if (serviceKey && !svcDef) return "Неизвестный сервис: " + serviceKey + ". Доступны: " + yandexCloud.SERVICES.map((s) => s.key).join(", ") + ".";
        try {
          if (svcDef) {
            const r = await yandexCloud.listService(cfg.oauth, cfg.folderId, svcDef);
            // Каталог отдаёт объекты { id, name }, а Postbox (SES) — просто строки.
            const items = r.items.slice(0, 30).map((it) => {
              if (it == null) return "• —";
              if (typeof it !== "object") return "• " + String(it);
              return "• " + (it.name || it.id || "—") + (it.id ? "  (" + it.id + ")" : "");
            });
            return "«" + svcDef.title + "» в каталоге «" + cfg.folderName + "»: всего " + r.count + (r.count ? ":\n" + items.join("\n") : " — пусто.");
          }
          const all = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
          return all.map((s) => "• " + s.icon + " " + s.title + ": " + (s.ok ? s.count : "ошибка: " + String(s.error || "").slice(0, 100))).join("\n");
        } catch (e) {
          return "Ошибка Yandex Cloud: " + ((e && e.message) || String(e));
        }
    },
    "ycCreate": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → Yandex Cloud.";
        if (!cfg.allowCreate) {
          return "⛔ Создание ресурсов в Yandex Cloud агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». (Удаление — отдельным чекбоксом.)";
        }
        const serviceKey = String(args.service || args.key || "").trim();
        const name = String(args.name || "").trim();
        if (!serviceKey || !name) return "Ошибка: укажи service (например ydb, serverlessContainers, storage, lockbox, containerRegistry, dns, vpc) и name. Создание платных ресурсов — только по явной просьбе пользователя.";
        // Платный ресурс агентом — только после согласия пользователя: сначала
        // называем цену, потом создаём. Иначе счёт появляется вслепую.
        const est = ycCosts.estimate(serviceKey, {});
        if (est && est.needsConfirm && args.confirm !== true) {
          return (
            "⛔ Не создаю без согласия: «" + est.title + "» платный.\n" +
            ycCosts.formatLines(est).join("\n") +
            "\n\nНазови пользователю ориентир цены и получи согласие (askUser), затем повтори вызов с confirm: true."
          );
        }
        try {
          const r = await yandexCloud.createResource(cfg.oauth, cfg.folderId, serviceKey, name);
          const priceNote = est ? " Ориентир стоимости: " + ycCosts.formatLines(est)[0] : "";
          return "OK — " + r.message + " (service=" + serviceKey + ", каталог «" + cfg.folderName + "»)." + priceNote + " Проверить список: ycList(service: \"" + serviceKey + "\").";
        } catch (e) {
          return "Ошибка создания: " + ((e && e.message) || String(e));
        }
    },
    "ycCosts": async (args, settings) => {
        const key = String(args.service || args.key || "").trim();
        if (!key) {
          const rows = ycCosts.keys().map((k) => "• " + k + ": " + ycCosts.hint(k));
          return (
            "Ориентир по стоимости ресурсов Yandex Cloud (тарифы на " + ycCosts.PRICED_AT + ", ₽ с НДС):\n" +
            rows.join("\n") +
            "\n\nДорого, если понадобится (мы это не создаём): " + ycCosts.EXPENSIVE.map((e) => e.title + " — " + e.why).join("; ") +
            "\nДетали по ресурсу: ycCosts(service: \"storage\", gb: 10). Ревизия контейнера: ycCosts(service: \"serverlessContainers\", memoryMb: 512, cores: 1)." +
            "\nЭто ориентир, а не счёт: регион и договор у всех разные, точная цифра — в калькуляторе " + ycCosts.CALCULATOR + "."
          );
        }
        const est = ycCosts.estimate(key, Object.assign({}, args.params || {}, args));
        if (!est) return "Неизвестный ресурс: " + key + ". Доступны: " + ycCosts.keys().join(", ") + ".";
        return "Стоимость (ориентир, тарифы на " + ycCosts.PRICED_AT + "):\n" + ycCosts.formatLines(est).join("\n");
    },
    "ycDelete": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.allowDelete) {
          return "⛔ Удаление ресурсов в Yandex Cloud агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы».";
        }
        const serviceKey = String(args.service || args.key || "").trim();
        const id = String(args.id || args.resourceId || "").trim();
        if (!serviceKey || !id) return "Ошибка: укажи service и id (id ресурса виден в ycList). Удаление необратимо — только по явной просьбе пользователя.";
        try {
          const r = await yandexCloud.deleteResource(cfg.oauth, serviceKey, id);
          return "OK — " + r.message + " (" + serviceKey + ").";
        } catch (e) {
          return "Ошибка удаления: " + ((e && e.message) || String(e));
        }
    },
    "ycDeploy": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.allowCreate) {
          return "⛔ Деплой создаёт ресурсы в Yandex Cloud (реестр, контейнер, SA). Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Деплой платный (Serverless Containers).";
        }
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "Ошибка: папка проекта не найдена: " + dir;
        const appName = String(args.name || "").trim() || path.basename(dir);
        // Порядок стадий, проверка после выката и откат — в src/deploy-engine.js.
        // Агент это не придумывает: конвейер детерминированный, как у кнопки.
        const r = await runCloudDeploy(dir, appName, {
          env: args.env || {},
          memoryMb: args.memoryMb,
          cores: args.cores,
          timeoutSec: args.timeoutSec,
          public: args.public,
          runTests: args.runTests,
          // Значения секретов через агента не проходят: он передаёт готовый
          // секрет ссылкой (secretId + secretKeys — только имена ключей), а
          // значения человек вводит в панели деплоя, и они сразу уходят в Lockbox.
          secretId: args.secretId,
          secretKeys: args.secretKeys,
          triggeredBy: "agent",
        });
        const head = r.ok
          ? "✅ Задеплоено (#" + r.number + "). URL: " + (r.url || "—")
          : r.rolledBack
            ? "⚠️ Деплой #" + r.number + " не прошёл, я откатил на прошлую рабочую версию (#" + r.rolledBackTo + "). URL: " + (r.url || "—")
            : "❌ Деплой #" + r.number + " не завершился.";
        const body = [head];
        if (r.error) body.push("", "Причина: " + r.error);
        if (r.warnings && r.warnings.length) body.push("", "Замечания:", "• " + r.warnings.join("\n• "));
        if (r.steps && r.steps.length) body.push("", "Стадии:", "• " + r.steps.join("\n• "));
        if (r.ok) {
          body.push("", "Проверка после деплоя: HTTP " + (r.health && r.health.status) + (r.health && r.health.path ? " по " + r.health.path : "") + ".");
          if (r.browserCheck && r.browserCheck.metrics) {
            body.push("Страница в браузере: HTTP " + r.browserCheck.metrics.status + ", текста " + r.browserCheck.metrics.textLen + " символов" + (r.browserCheck.metrics.title ? ", заголовок «" + r.browserCheck.metrics.title + "»" : "") + ".");
          }
          body.push("Образ: " + r.image + (r.revisionId ? ", ревизия " + r.revisionId : ""));
          if (r.secretKeys && r.secretKeys.length) {
            // Наружу — только имена ключей: значения секретов не отдаём.
            body.push("Секреты (Lockbox " + r.secretId + "): " + r.secretKeys.join(", "));
          }
          body.push('Логи: ycLogs(service: "serverlessContainers", id: "' + (r.containerId || "") + '").');
        }
        body.push("", "История и текущее состояние — в панели «☁️ Cloud» → Деплой.");
        return body.join("\n");
    },
    "ycContainer": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        const action = String(args.action || "overview").trim().toLowerCase();
        const ref = String(args.container || args.id || "").trim();
        if (!ref) return "Ошибка: укажи container — имя или id контейнера. Список: ycList(service: \"serverlessContainers\").";
        // Чтение разрешено всегда; смена настроек и ревизии — только с чекбоксом.
        if ((action === "deploy" || action === "rollback" || action === "update") && !cfg.allowUpdate) {
          return "⛔ Менять контейнеры и деплоить ревизии агенту ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры». Чтение доступно и сейчас: action overview / revisions / revision.";
        }
        try {
          const cont = await ycFindContainerByRef(cfg, ref);
          const who = "Контейнер «" + (cont.name || cont.id) + "» (" + cont.id + ")";
          const line = "URL: " + (cont.url || "— (публичный доступ не настроен)");
          const logsHint = "Логи: ycLogs(service: \"serverlessContainers\", id: \"" + cont.id + "\").";

          if (action === "overview") {
            const { revs, active } = await ycActiveRevision(cfg, cont.id);
            const head = [
              who,
              "Статус: " + (cont.status || "—") + (cont.description ? " · " + cont.description : ""),
              "Создан: " + (cont.createdAt || "—"),
              line,
              logsHint,
            ];
            if (!revs.length) {
              return head.join("\n") + "\n\nРевизий нет: контейнер создан, но ни разу не деплоился. Создать ревизию: ycContainer { action: \"deploy\", container: \"" + (cont.name || cont.id) + "\", image: \"cr.yandex/<registry-id>/<image>:tag\" }.";
            }
            head.push("Ревизий: " + revs.length + " · активная — " + (active ? active.id : "—"));
            return head.join("\n") + "\n\nНастройки активной ревизии (вкладка «Редактор»):\n" + ycRevisionDetails(yandexCloud.revisionSummary(active)) +
              "\n\nСписок ревизий: ycContainer { action: \"revisions\", container: \"" + (cont.name || cont.id) + "\" }.";
          }

          if (action === "revisions") {
            const revs = await yandexCloud.listRevisions(cfg.oauth, {
              containerId: cont.id,
              pageSize: 100,
              filter: args.filter ? String(args.filter) : "",
            });
            if (!revs.length) return who + "\n\nРевизий нет (фильтр: " + (args.filter || "нет") + ").";
            const activeId = (revs.find((r) => r.status === "ACTIVE") || revs[0]).id;
            const limit = Math.min(Math.max(parseInt(args.limit, 10) || 15, 1), 100);
            const rows = revs.slice(0, limit).map((r) => ycRevisionLine(yandexCloud.revisionSummary(r), r.id === activeId));
            return who + "\n" + line + "\n\nРевизии (свежие сверху), всего " + revs.length + ":\n" + rows.join("\n") +
              "\n\nДетали: ycContainer { action: \"revision\", container: \"…\", revisionId: \"…\" }. Откат: action \"rollback\" (нужно разрешение).";
          }

          if (action === "revision") {
            const rid = String(args.revisionId || args.revision || "").trim();
            if (!rid) return "Ошибка: укажи revisionId — id виден в action: revisions.";
            const rev = await yandexCloud.getRevision(cfg.oauth, rid);
            return who + "\n\n" + ycRevisionDetails(yandexCloud.revisionSummary(rev));
          }

          if (action === "deploy") {
            const { active } = await ycActiveRevision(cfg, cont.id);
            const opts = yandexCloud.revisionToDeployOpts(active, {
              imageUrl: args.image || args.imageUrl,
              memoryMb: args.memoryMb,
              cores: args.cores,
              coreFraction: args.coreFraction,
              timeoutSec: args.timeoutSec,
              concurrency: args.concurrency,
              serviceAccountId: args.serviceAccountId,
              networkId: args.networkId,
              minInstances: args.minInstances,
              maxInstancesPerZone: args.maxInstancesPerZone,
              env: ycJsonArg(args.env),
              envReplace: args.envReplace === true,
              command: ycJsonArg(args.command),
              args: ycJsonArg(args.args),
              secrets: ycJsonArg(args.secrets),
              mounts: ycJsonArg(args.mounts),
              storageMounts: ycJsonArg(args.storageMounts),
              runtime: args.runtime,
              logGroupId: args.logGroupId,
              logMinLevel: args.logMinLevel,
              description: args.description,
              folderId: cfg.folderId,
            });
            if (!opts.imageUrl) {
              return "Ошибка: у новой ревизии нет образа. Контейнер «" + (cont.name || cont.id) + "» ещё не деплоился — укажи image, например cr.yandex/<registry-id>/<image>:latest (реестр: ycList(service: \"containerRegistry\")).";
            }
            await yandexCloud.deployContainerRevision(cfg.oauth, Object.assign({ containerId: cont.id }, opts));
            const after = await ycActiveRevision(cfg, cont.id);
            const src = active ? "настройки взяты из активной ревизии " + active.id + " (указанные поля переопределены)" : "первая ревизия контейнера";
            return "✅ Ревизия контейнера «" + (cont.name || cont.id) + "» развёрнута: " + src + ".\n" + line + "\n\n" + ycRevisionDetails(yandexCloud.revisionSummary(after.active || {})) +
              "\n\n" + logsHint + " Проверь вызов по URL. Откат: ycContainer { action: \"rollback\", container: \"" + (cont.name || cont.id) + "\", revisionId: \"" + (active ? active.id : "") + "\" }.";
          }

          if (action === "rollback") {
            const rid = String(args.revisionId || args.revision || "").trim();
            if (!rid) return "Ошибка: укажи revisionId, на которую откатить (список: action: revisions).";
            await yandexCloud.rollbackContainer(cfg.oauth, cont.id, rid);
            const after = await ycActiveRevision(cfg, cont.id);
            return "✅ Контейнер «" + (cont.name || cont.id) + "» откачен на ревизию " + rid + ".\nАктивная ревизия теперь: " + ((after.active && after.active.id) || "—") + "\n" + line + "\n\n" + logsHint;
          }

          if (action === "update") {
            const patchObj = {};
            if (args.name != null) patchObj.name = args.name;
            if (args.description != null) patchObj.description = args.description;
            const labels = ycJsonArg(args.labels);
            if (labels) patchObj.labels = labels;
            const updated = await yandexCloud.updateContainer(cfg.oauth, cont.id, patchObj);
            const labelKeys = Object.keys(updated.labels || {});
            return "✅ Контейнер обновлён: «" + (updated.name || cont.name) + "»" + (updated.description ? " — " + updated.description : "") +
              (labelKeys.length ? "\nМетки: " + labelKeys.map((k) => k + "=" + updated.labels[k]).join(", ") : "") +
              "\n\nВажно: образ, переменные окружения и ресурсы правятся ТОЛЬКО новой ревизией — action \"deploy\" (текущие настройки подставятся сами). " + line;
          }

          return "Ошибка: неизвестное действие ycContainer «" + action + "». Доступно: overview, revisions, revision, deploy, rollback, update.";
        } catch (e) {
          return "Yandex Cloud (ycContainer, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },
    "ycLogs": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const id = String(args.id || args.resourceId || "").trim();
        if (!id) return "Ошибка: укажи id ресурса (виден в ycList).";
        try {
          return await readYcLogsText(cfg, String(args.service || "").trim(), id, args);
        } catch (e) {
          return "Логи (" + (args.service || "ресурс") + "): " + ((e && e.message) || String(e));
        }
    },
    "ycInstall": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        const st = ycCliStatus();
        if (st.installed && !args.force) {
          // Пересобираем окружение: PATH и свежий YC_IAM_TOKEN — без перезапуска.
          applyAgentEnv(loadSettings());
          return "yc CLI уже встроен: " + st.path + " — доступен всем командам как «yc». YC_IAM_TOKEN (свежий IAM), YC_CLOUD_ID и YC_FOLDER_ID подставляются автоматически, yc init не нужен. Переустановить: ycInstall(force: true).";
        }
        try {
          const r = await ycCliInstall();
          if (!r.ok) return "Не удалось установить yc CLI: " + r.error;
          applyAgentEnv(loadSettings());
          const iamReady = !!ycIamEnvToken(ycConfig(loadSettings()));
          return "yc CLI установлен: " + r.path + " (версия " + r.version + ", " + r.os + "/" + r.arch + ", " + r.sizeMb + " МБ).\n" +
            "Папка добавлена в PATH всех команд агента — вызывай просто «yc ...». YC_IAM_TOKEN (свежий IAM), YC_CLOUD_ID и YC_FOLDER_ID подставляются автоматически, yc init не нужен. Проверка: yc config list" +
            (iamReady ? "" : "\n⚠ Свежий IAM-токен ещё не получен (нет сети или токен не принят) — если первая команда yc скажет «The token is invalid», повтори её через минуту.");
        } catch (e) {
          return "Не удалось установить yc CLI: " + ((e && e.message) || String(e));
        }
    },
  };
}

module.exports = { createCloudTools };

"use strict";

const { createYcDb } = require("./yc-db.js"); // таблицы и записи базы YDB

/* ─── Облачные инструменты агента: Yandex Cloud ─────────────────────────────
   Вынесены из agent-tools.js своим модулем (этап «дробление крупных модулей»,
   часть 40, заход 1): девять обработчиков облака — визитка сервиса (ycStatus),
   список ресурсов (ycList), создание (ycCreate), стоимость (ycCosts), удаление
   (ycDelete), выкладка (ycDeploy), контейнеры и ревизии (ycContainer), логи
   (ycLogs) и установка yc CLI (ycInstall).

   Позже сюда легли ещё три инструмента, которых не хватало для полного цикла
   работы с облаком руками агента: ycSecret (версии секретов Lockbox — без
   значения секрета ревизия ссылается на несуществующий ключ), ycDns (записи
   зоны Cloud DNS — без записи созданный домен никуда не ведёт) и ycRegistry
   (образы Container Registry: посмотреть и почистить, иначе каждая выкатка
   оставляет в платном хранилище ещё один образ навсегда), а следом — ycStorage
   (файлы в бакете Object Storage: посмотреть, положить, забрать и убрать; без
   этого созданный «бакет для файлов и статики» оставался пустой полкой).

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

  // Document API базы YDB берёт готовые помощники облака: тот же IAM-токен и
  // тот же разбор сетевых отказов, что у остальных сервисов (src/yc-db.js).
  // Собираем защитно: стенды, у которых облако не нужно (например буфер обмена),
  // присылают deps без yandexCloud — они не должны падать на сборке.
  const ycApi = yandexCloud || {};
  const ycDbApi = createYcDb({
    getIamToken: ycApi.getIamToken,
    fetchJson: ycApi._fetchJson,
    endpoint: ycApi.endpoint,
    listService: ycApi.listService,
    serviceByKey: ycApi.serviceByKey,
    hostOf: ycApi.hostOf,
    serviceError: ycApi.serviceError,
    isNetworkError: ycApi.isNetworkError,
  });

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
    // ── Секреты Lockbox ────────────────────────────────────────────────────
    // Раньше секрет можно было только СОЗДАТЬ: версий у него не было, а без
    // версии он бесполезен — ревизия ссылается на ключ, которого не существует.
    // Тот же код версии, что у панели облака (yandexCloud.putSecretVersion).
    "ycSecret": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "list").trim().toLowerCase();
        const ref = String(args.secret || args.id || args.name || "").trim();
        // Разбор действия — ДО проверок имени: на «стирай» честнее ответить
        // «нет такого действия», чем требовать у секрета имя.
        if (["list", "versions", "putversion"].indexOf(action) === -1) {
          return "Ошибка: неизвестное действие ycSecret «" + action + "». Доступно: list, versions, putversion.";
        }
        // Новая версия меняет то, что получит ревизия, — это создание, а не чтение.
        if (action === "putversion" && !cfg.allowCreate) {
          return "⛔ Добавлять версии секретов агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть секреты и версии можно и сейчас: action list / versions.";
        }
        try {
          if (action === "list") {
            const list = await yandexCloud.listSecrets(cfg.oauth, cfg.folderId);
            if (!list.length) return "Секретов в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создать: ycCreate { service: \"lockbox\", name: \"app-env\" }, потом наполнить: ycSecret { action: \"putversion\", secret: \"app-env\", entries: { \"API_KEY\": \"…\" } }.";
            const rows = list.map((s) => "• " + (s.name || "—") + " — " + s.id + (s.status ? " · " + s.status : ""));
            return "Секреты Lockbox · каталог «" + (cfg.folderName || cfg.folderId) + "» (" + list.length + "):\n" + rows.join("\n") +
              "\n\nВерсии секрета: ycSecret { action: \"versions\", secret: \"<имя или id>\" }. Новая версия: action \"putversion\" (нужно разрешение на создание).";
          }
          if (!ref) return "Ошибка: укажи secret — имя или id (список: ycSecret { action: \"list\" }).";
          // Ищем по имени, как в консоли; не нашли — пробуем принять ref как id.
          let secret = null;
          try {
            secret = await yandexCloud.findSecret(cfg.oauth, cfg.folderId, ref);
          } catch (e) {}
          const found = secret && secret.id ? secret : await yandexCloud.getSecret(cfg.oauth, ref);
          const who = "Секрет «" + (found.name || ref) + "» (" + found.id + ")";

          if (action === "versions") {
            const versions = await yandexCloud.listSecretVersions(cfg.oauth, found.id);
            if (!versions.length) return who + "\n\nВерсий нет: секрет создан, но пуст. Добавить: ycSecret { action: \"putversion\", secret: \"…\", entries: { \"KEY\": \"value\" } }.";
            const rows = versions.map((v) => {
              const keys = v.payloadEntryKeys || [];
              return "• " + v.id + " — " + String(v.createdAt || "—").replace("T", " ").slice(0, 19) + (v.status ? " · " + v.status : "") + (keys.length ? " · ключи: " + keys.join(", ") : "");
            });
            return who + "\n\nВерсии (свежие сверху), всего " + versions.length + ":\n" + rows.join("\n") +
              "\n\nЗначения секретов API не отдаёт — видны только имена ключей. Их и подставляй в ревизию: ycContainer { action: \"deploy\", container: \"…\", secrets: [{ id: \"" + found.id + "\", key: \"КЛЮЧ\", environmentVariable: \"КЛЮЧ\" }] }.";
          }

          if (action === "putversion") {
            const r = await yandexCloud.putSecretVersion(cfg.oauth, found.id, args.entries || args.payload || args.values);
            return "✅ Новая версия секрета «" + (found.name || ref) + "»: " + r.versionId + "\nКлючи: " + (r.keys.join(", ") || "—") +
              "\n\nЗначения в ответе не показываю: они ушли в облако и обратно не читаются. Подставить ключ в ревизию: ycContainer { action: \"deploy\", container: \"…\", secrets: [{ id: \"" + found.id + "\", key: \"" + (r.keys[0] || "КЛЮЧ") + "\", environmentVariable: \"" + (r.keys[0] || "КЛЮЧ") + "\" }] }. Версии: ycSecret { action: \"versions\", secret: \"" + (found.name || ref) + "\" }.";
          }

          return "Ошибка: неизвестное действие ycSecret «" + action + "». Доступно: list, versions, putversion.";
        } catch (e) {
          return "Yandex Cloud (ycSecret, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },
    // ── Записи DNS-зоны ────────────────────────────────────────────────────
    // Зону агенту было чем создать (ycCreate), а запись — нечем: список записей
    // читался, но домен подключить было некуда. Строгость API Cloud DNS (нельзя
    // удалить несуществующее и добавить поверх существующего) разобрана в
    // yandex-cloud.js — здесь выбор зоны, разрешения и человеческий ответ.
    "ycDns": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "records").trim().toLowerCase();
        if (["records", "add", "delete"].indexOf(action) === -1) {
          return "Ошибка: неизвестное действие ycDns «" + action + "». Доступно: records, add, delete.";
        }
        // Добавление записи — это создание, удаление — удаление: разрешения те же
        // и называются так же, как у остальных ресурсов каталога.
        if (action === "add" && !cfg.allowCreate) {
          return "⛔ Создавать записи DNS агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть записи можно и сейчас: action records.";
        }
        if (action === "delete" && !cfg.allowDelete) {
          return "⛔ Удалять записи DNS агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть записи можно и сейчас: action records.";
        }
        try {
          const zones = await yandexCloud.listService(cfg.oauth, cfg.folderId, yandexCloud.serviceByKey("dns"));
          const list = zones.items || [];
          if (!list.length) {
            return "DNS-зон в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создать зону: ycCreate { service: \"dns\", name: \"example.com\" } (имя — домен без точки), потом добавить запись: ycDns { action: \"add\", zone: \"example.com.\", name: \"www.example.com.\", type: \"A\", value: \"203.0.113.10\" }.";
          }
          const ref = String(args.zone || args.zoneId || args.id || "").trim();
          const zone = ref
            ? list.find((z) => z.id === ref) || list.find((z) => z.name === ref) || list.find((z) => z.name === ref + ".")
            : list.length === 1 ? list[0] : null;
          if (!zone) {
            return "Не нашёл зону «" + (ref || "") + "»." + (ref ? "" : " Зон несколько — укажи zone.") + "\nВ каталоге: " + list.map((z) => z.name + " (" + z.id + ")").join(", ");
          }
          const who = "Зона «" + zone.name + "» (" + zone.id + ")";

          if (action === "records") {
            const sets = await yandexCloud.listRecordSets(cfg.oauth, zone.id);
            if (!sets.length) return who + "\n\nЗаписей нет — в зоне только служебные NS, и API их не показывает. Добавить: ycDns { action: \"add\", zone: \"" + zone.name + "\", name: \"www." + String(zone.name || "").replace(/\.$/, "") + ".\", type: \"A\", value: \"203.0.113.10\" }.";
            const rows = sets.map((r) => "• " + r.type + " " + r.name + " (TTL " + r.ttl + ") → " + r.data.join(", "));
            return who + "\n\nЗаписи (" + sets.length + "):\n" + rows.join("\n") +
              "\n\nПоставить или заменить: ycDns { action: \"add\", zone: \"…\", name: \"…\", type: \"A\", value: \"…\" } (есть — заменит, нет — добавит). Удалить: ycDns { action: \"delete\", zone: \"…\", name: \"…\", type: \"A\" }.";
          }

          if (action === "add") {
            const r = await yandexCloud.upsertRecordSet(cfg.oauth, zone.id, {
              name: args.name,
              type: args.type,
              ttl: args.ttl,
              data: args.values || args.value || args.data,
            });
            return "✅ " + (r.replaced ? "Запись заменена: " : "Запись добавлена: ") + r.type + " " + r.name + " (TTL " + r.ttl + ") — значений " + r.values + "\n" + who +
              "\n\nИмя записи всегда FQDN с точкой на конце, а вершина зоны — само её имя. Обновление DNS в интернете занимает от минуты до часов: проверять сразу после добавления бессмысленно, но если запись указывает на адрес деплоя — проверь его сам: checkUrl(\"https://" + String(r.name || "").replace(/\.$/, "") + "\"). Проверить содержимое зоны: ycDns { action: \"records\", zone: \"" + zone.name + "\" }.";
          }

          const r = await yandexCloud.deleteRecordSet(cfg.oauth, zone.id, { name: args.name, type: args.type });
          return "🗑 Запись удалена: " + r.type + " " + r.name + " (значений было " + r.values + ")\n" + who +
            "\n\nЧто осталось: ycDns { action: \"records\", zone: \"" + zone.name + "\" }.";
        } catch (e) {
          return "Yandex Cloud (ycDns, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },
    // ── Container Registry: образы и их чистка ─────────────────────────────
    // Реестр чистить было нечем: список образов читался только карточкой панели,
    // а удаление образа жило в скрипте E2E. Между тем образы копятся с каждой
    // выкаткой и занимают платное хранилище, поэтому у агента есть и список, и
    // удаление — по id или по тегу.
    "ycRegistry": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "images").trim().toLowerCase();
        if (["images", "delete"].indexOf(action) === -1) {
          return "Ошибка: неизвестное действие ycRegistry «" + action + "». Доступно: images, delete.";
        }
        if (action === "delete" && !cfg.allowDelete) {
          return "⛔ Удалять образы агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть образы можно и сейчас: action images.";
        }
        const imageRef = String(args.image || args.imageId || args.tag || "").trim();
        if (action === "delete" && !imageRef) {
          return "Ошибка: укажи образ — id (виден в action images) или тег: ycRegistry { action: \"delete\", image: \"v1.2\" }.";
        }
        try {
          const regs = await yandexCloud.listService(cfg.oauth, cfg.folderId, yandexCloud.serviceByKey("containerRegistry"));
          const list = regs.items || [];
          if (!list.length) {
            return "Реестров в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создать: ycCreate { service: \"containerRegistry\", name: \"app\" } — реестр нужен один раз, дальше в него кладут образы (dockerBuild), а лишние убираются через ycRegistry { action: \"delete\" }.";
          }
          const ref = String(args.registry || args.registryId || args.registryName || "").trim();
          const reg = ref
            ? list.find((r) => r.id === ref) || list.find((r) => r.name === ref)
            : list.length === 1 ? list[0] : null;
          if (!reg) {
            return "Не нашёл реестр «" + ref + "»." + (ref ? "" : " Реестров несколько — укажи registry.") + "\nВ каталоге: " + list.map((r) => r.name + " (" + r.id + ")").join(", ");
          }
          const who = "Реестр «" + reg.name + "» (" + reg.id + ")";

          if (action === "images") {
            const images = await yandexCloud.listRegistryImages(cfg.oauth, reg.id);
            if (!images.length) return who + "\n\nОбразов нет — реестр пустой. Собрать и положить первый: dockerBuild (тег вида cr.yandex/<id-реестра>/<образ>:<тег>).";
            const rows = images.map((img) => {
              const tags = Array.isArray(img.tags) && img.tags.length ? img.tags.join(", ") : "без тега";
              const bytes = Number(img.size || img.compressedSize || 0);
              const size = bytes > 0 ? (bytes >= 1048576 ? Math.round(bytes / 1048576) + " МБ" : Math.round(bytes / 1024) + " КБ") : "";
              return "• " + (img.name || img.id) + " — теги: " + tags + (size ? " · " + size : "") + " · id " + img.id;
            });
            return who + "\n\nОбразы (" + images.length + "):\n" + rows.join("\n") +
              "\n\nУдалить образ вместе с его тегами: ycRegistry { action: \"delete\", registry: \"" + reg.name + "\", image: \"<id или тег>\" }. Удаление необратимо и забирает все теги образа: если на тег ссылается контейнер, следующая выкатка его не соберёт.";
          }

          const img = await yandexCloud.findRegistryImage(cfg.oauth, reg.id, imageRef);
          if (!img) {
            return "В реестре «" + reg.name + "» нет образа «" + imageRef + "» — возможно, его уже удалили. Посмотреть, что осталось: ycRegistry { action: \"images\", registry: \"" + reg.name + "\" }.";
          }
          await yandexCloud.deleteRegistryImage(cfg.oauth, img.id);
          const tags = Array.isArray(img.tags) ? img.tags : [];
          return "🗑 Образ удалён: " + (img.name || img.id) + (tags.length ? " (теги: " + tags.join(", ") + ")" : "") + "\n" + who +
            "\n\nЧто осталось: ycRegistry { action: \"images\", registry: \"" + reg.name + "\" }.";
        } catch (e) {
          return "Yandex Cloud (ycRegistry, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },
    // ── Object Storage: файлы в бакете ─────────────────────────────────────
    // Бакет было чем СОЗДАТЬ (ycCreate), а положить в него файл — нечем: ни одна
    // операция с объектами не была доступна ни агенту, ни панели, хотя бакет
    // создаётся «для файлов и статики». Объекты лежат в S3-совместимом API и
    // ходят тем же IAM-токеном, что и остальное облако (разбор строгостей — в
    // yandex-cloud.js), поэтому отдельного ключа доступа не нужно.
    "ycStorage": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "list").trim().toLowerCase();
        if (["list", "upload", "download", "delete", "public", "private"].indexOf(action) === -1) {
          return "Ошибка: неизвестное действие ycStorage «" + action + "». Доступно: list, upload, download, delete, public, private.";
        }
        // Класть файл в облако — это создание, убирать — удаление: разрешения у
        // них те же и называются так же, как у остальных ресурсов каталога.
        if (action === "upload" && !cfg.allowCreate) {
          return "⛔ Класть файлы в облако агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть, что уже лежит: action list.";
        }
        if (action === "delete" && !cfg.allowDelete) {
          return "⛔ Удалять файлы из облака агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть, что лежит: action list.";
        }
        // Публичность бакета — не создание и не удаление, а ПРАВО доступа: после
        // него содержимое читает кто угодно из интернета, и отменить «нечаянно»
        // уже нельзя. Поэтому своё разрешение, а не вместе с созданием.
        if ((action === "public" || action === "private") && !cfg.allowPublic) {
          return "⛔ Менять публичный доступ к бакету ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту делать бакет публичным». Посмотреть, что лежит: action list.";
        }
        const key = String(args.key || args.object || args.path || "").replace(/^\/+/, "");
        // Ключ объекта нужен upload/download/delete. У public/private его нет:
        // права меняются у всего бакета сразу.
        if (action !== "list" && action !== "public" && action !== "private" && !key) {
          return "Ошибка: укажи key — путь объекта в бакете, например site/index.html (что уже лежит: ycStorage { action: \"list\" }).";
        }
        const size = (n) => {
          const v = Number(n) || 0;
          if (v >= 1048576) return (Math.round((v / 1048576) * 10) / 10) + " МБ";
          if (v >= 1024) return Math.round(v / 1024) + " КБ";
          return v + " Б";
        };
        try {
          const buckets = await yandexCloud.listService(cfg.oauth, cfg.folderId, yandexCloud.serviceByKey("storage"));
          const list = buckets.items || [];
          if (!list.length) {
            return "Бакетов в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создать: ycCreate { service: \"storage\", name: \"my-site\" } — бакет нужен один раз, дальше в него кладут файлы.";
          }
          const ref = String(args.bucket || args.name || "").trim();
          const bucket = ref
            ? list.find((b) => b.id === ref) || list.find((b) => b.name === ref)
            : list.length === 1 ? list[0] : null;
          if (!bucket) {
            return "Не нашёл бакет «" + ref + "»." + (ref ? "" : " Бакетов несколько — укажи bucket.") + "\nВ каталоге: " + list.map((b) => b.name + " (" + b.id + ")").join(", ");
          }
          const who = "Бакет «" + bucket.name + "» (" + bucket.id + ")";

          // Публичность бакета. Состояние читаем ПЕРВЫМ, чтобы в ответе сказать
          // правду о ссылке, а не предполагать; и чтобы «сделать публичным» уже
          // публичного бакета не выглядело переменой.
          if (action === "public" || action === "private") {
            const want = action === "public";
            const was = await yandexCloud.getBucketAccess(cfg.oauth, bucket.name);
            if (was.flags.read === want) {
              return (want ? "🌐 Бакет уже публичный" : "🔒 Бакет уже закрытый") + ": " + who +
                "\nАнонимное чтение " + (want ? "включено" : "выключено") + ", перечисление содержимого анонимно — нет.";
            }
            const r = await yandexCloud.setBucketPublicAccess(cfg.oauth, bucket.name, want);
            const first = await yandexCloud.listBucketObjects(cfg.oauth, { bucket: bucket.name, limit: 1 });
            const sample = (first.items && first.items[0] && first.items[0].key) || "";
            return (want ? "🌐 Бакет открыт для чтения из интернета" : "🔒 Бакет снова закрыт") + ": " + who +
              "\nАнонимное чтение: " + (r.flags.read ? "ВКЛ" : "выкл") +
              ". Перечисление содержимого анонимно: выкл (файлы видны только по прямой ссылке)." +
              (want
                ? "\nТеперь объекты бакета откроются у любого, кто знает ссылку: " +
                  (sample ? yandexCloud.objectPublicUrl(bucket.name, sample) : "https://storage.yandexcloud.net/" + bucket.name + "/<ключ файла>") +
                  "\nЭто значит и то, что содержимое бакета видно ПОИСКОВИКАМ. Не клади туда пароли, ключи и личные файлы — для закрытого хранения есть ycSecret (Lockbox). " +
                  "Закрыть обратно: ycStorage { action: \"private\", bucket: \"" + bucket.name + "\" }."
                : "\nПо открытым адресам файлы больше не откроются (403). Содержимое цело — вернуть доступ можно тем же action public.");
          }

          if (action === "list") {
            const prefix = String(args.prefix || "").trim();
            const r = await yandexCloud.listBucketObjects(cfg.oauth, { bucket: bucket.name, prefix: prefix, limit: args.limit });
            if (!r.items.length) {
              return who + "\n\n" + (prefix ? "По префиксу «" + prefix + "» пусто." : "В бакете нет ни одного объекта — он пустой.") +
                " Положить файл: ycStorage { action: \"upload\", bucket: \"" + bucket.name + "\", file: \"index.html\", key: \"index.html\" }." +
                "\nЧтобы файл открывался у других, у бакета должен быть включён публичный доступ на чтение: ycStorage { action: \"public\", bucket: \"" + bucket.name + "\" } — иначе открытый адрес вернёт отказ.";
            }
            const rows = r.items.map((it) => "• " + it.key + (it.size ? " · " + size(it.size) : "") + (it.lastModified ? " · " + String(it.lastModified).slice(0, 16).replace("T", " ") : ""));
            return who + "\n\nОбъекты" + (prefix ? " по префиксу «" + prefix + "»" : "") + ": " + r.count + (r.truncated ? " (показаны первые)" : "") + "\n" + rows.join("\n") +
              "\n\nСкачать к себе: ycStorage { action: \"download\", key: \"…\" }. Положить файл: action \"upload\" (file — путь на ПК, key — куда в бакете). Убрать: action \"delete\"." +
              "\nОткрытый адрес объекта: " + yandexCloud.objectPublicUrl(bucket.name, r.items[0].key) +
              " (работает у других, только если у бакета разрешено анонимное чтение — спроси пользователя, можно ли его включить: action \"public\").";
          }

          if (action === "upload") {
            const fromFile = String(args.file || args.from || "").trim();
            const content = args.content != null ? String(args.content) : null;
            if (!fromFile && content == null) {
              return "Ошибка: для загрузки нужен либо файл с ПК — file: \"index.html\" (путь от рабочей папки), либо готовое содержимое — content: \"…\".";
            }
            let body = null;
            let where = "";
            if (fromFile) {
              const p = resolvePath(fromFile, loadSettings());
              if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return "Ошибка: файла «" + fromFile + "» нет (путь от рабочей папки). Проверь: " + p;
              if (fs.statSync(p).size > yandexCloud.S3_MAX_BYTES) {
                return "Ошибка: файл больше " + Math.round(yandexCloud.S3_MAX_BYTES / 1048576) + " МБ — одним запросом такое не залить. Сожми его или положи частями.";
              }
              body = fs.readFileSync(p);
              where = " из файла «" + fromFile + "»";
            } else {
              body = Buffer.from(content, "utf8");
            }
            const r = await yandexCloud.putBucketObject(cfg.oauth, { bucket: bucket.name, key: key, body: body, contentType: args.contentType });
            return "✅ Файл положили в облако" + where + ": " + r.key + " (" + size(r.size) + ", " + yandexCloud.contentTypeFor(r.key) + ")\n" + who +
              "\nОткрытый адрес: " + r.url +
              "\nОн откроется у других, только если у бакета разрешено анонимное чтение — включить его может и агент: ycStorage { action: \"public\", bucket: \"" + bucket.name + "\" } (спроси пользователя: файлы станут видны всем, кто знает ссылку). Проверить, что лежит: ycStorage { action: \"list\" }.";
          }

          if (action === "download") {
            const obj = await yandexCloud.getBucketObject(cfg.oauth, { bucket: bucket.name, key: key });
            const to = String(args.to || args.saveAs || "").trim();
            const p = to ? resolvePath(to, loadSettings()) : path.join(agentWorkDir(loadSettings()), path.basename(obj.key));
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, obj.body);
            return "✅ Объект скачан: " + obj.key + " → " + p + " (" + size(obj.size) + ", " + obj.contentType + ")\n" + who +
              "\nДальше с файлом можно работать как с обычным: читать, править, запускать.";
          }

          const removed = await yandexCloud.deleteBucketObject(cfg.oauth, { bucket: bucket.name, key: key });
          return "🗑 Объект удалён: " + removed.key + "\n" + who +
            "\n\nЧто осталось: ycStorage { action: \"list\", bucket: \"" + bucket.name + "\" }.";
        } catch (e) {
          return "Yandex Cloud (ycStorage, action=" + action + "): " + ((e && e.message) || String(e));
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
    // ── YDB: таблицы и записи базы ─────────────────────────────────────────
    // Базу YDB было чем СОЗДАТЬ (ycCreate), а работать с ней — нечем: ни таблиц,
    // ни записей не видел никто, хотя serverless-база создаётся ради данных. То
    // же, что секрет без версии (часть 46) и бакет без файлов (часть 47).
    // Таблицы живут в HTTP Document API (протокол DynamoDB-совместимый) — разбор
    // его строгостей и адрес базы: src/yc-db.js.
    "ycDb": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "tables").trim().toLowerCase();
        const known = ["tables", "create", "describe", "put", "get", "scan", "delete", "drop"];
        if (known.indexOf(action) === -1) {
          return "Ошибка: неизвестное действие ycDb «" + action + "». Доступно: tables, create, describe, put, get, scan, delete, drop.";
        }
        // Наполнять базу данными — это создание, стирать — удаление: разрешения
        // те же и называются так же, как у остальных ресурсов каталога.
        if ((action === "create" || action === "put") && !cfg.allowCreate) {
          return "⛔ Создавать таблицы и записи в базе агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть, что уже есть: action tables.";
        }
        if ((action === "delete" || action === "drop") && !cfg.allowDelete) {
          return "⛔ Удалять данные из базы агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть, что есть: action tables.";
        }
        const table = String(args.table || "").trim();
        try {
          const found = await ycDbApi.findDatabase(cfg.oauth, cfg.folderId, args.database || args.db);
          const list = found.list || [];
          if (!list.length) {
            return "Баз YDB в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создать: ycCreate { service: \"ydb\", name: \"app-db\" } — база нужна один раз, дальше в неё кладут таблицы и записи.";
          }
          const db = found.db;
          if (!db) {
            return "Баз несколько — укажи database (имя или id).\nВ каталоге: " + list.map((d) => d.name + " (" + d.id + ")").join(", ");
          }
          const who = "База «" + (db.name || db.id) + "» (" + db.id + ")";

          if (action === "tables") {
            const r = await ycDbApi.listDocumentTables(cfg.oauth, db);
            if (!r.tables.length) {
              return who + "\n\nТаблиц нет — база пустая. Создать: ycDb { action: \"create\", table: \"pets\", keys: { \"species\": \"S\", \"name\": \"S\" } } (первый ключ — ключ поиска, остальные — сортировки).";
            }
            return who + "\n\nТаблицы (" + r.tables.length + "):\n" + r.tables.map((t) => "• " + t).join("\n") +
              "\n\nЗаписи: ycDb { action: \"scan\", table: \"…\" }. Одна запись: action \"get\" с key. Структура таблицы: action \"describe\".";
          }

          if (!table) return "Ошибка: укажи table — имя таблицы (что уже есть: ycDb { action: \"tables\" }).";

          if (action === "create") {
            const r = await ycDbApi.createDocumentTable(cfg.oauth, db, { table: table, keys: args.keys });
            return "✅ Таблица создана: " + r.table + " (ключ: " + r.keys.join(", ") + ")\n" + who +
              "\nПоложить запись: ycDb { action: \"put\", table: \"" + r.table + "\", item: { \"…\": \"…\" } } — поля ключа обязательны. Посмотреть: action \"tables\".";
          }

          if (action === "describe") {
            const d = await ycDbApi.describeDocumentTable(cfg.oauth, db, table);
            return "Таблица «" + d.table + "»" + (d.status ? " · " + d.status : "") + "\n" + who +
              "\nЗаписей: " + d.itemCount + " · размер: " + d.sizeBytes + " Б" +
              "\nКлюч: " + (d.keys.map((k) => k.name + " [" + k.type + "]").join(", ") || "—") +
              "\n\nЗаписи: ycDb { action: \"scan\", table: \"" + d.table + "\" }.";
          }

          if (action === "put") {
            const item = args.item && typeof args.item === "object" ? args.item : null;
            if (!item) return "Ошибка: укажи item — запись полями, например { \"species\": \"cat\", \"name\": \"Tom\", \"price\": 10.5 }. Поля первичного ключа обязательны (ключ виден в action describe).";
            const r = await ycDbApi.putDocumentItem(cfg.oauth, db, { table: table, item: item });
            return "✅ Запись сохранена в «" + r.table + "» (полей: " + r.fields.length + ")\n" + who +
              "\nПрочитать: ycDb { action: \"get\", table: \"" + r.table + "\", key: { \"…\": \"…\" } } — нужны поля ключа.";
          }

          if (action === "get") {
            const key = args.key && typeof args.key === "object" ? args.key : null;
            if (!key) return "Ошибка: укажи key — значения полей первичного ключа записи (ключ виден в action describe).";
            const r = await ycDbApi.getDocumentItem(cfg.oauth, db, { table: table, key: key });
            if (!r.item) return "Такой записи в «" + r.table + "\" нет.\n" + who + "\nЧто есть: ycDb { action: \"scan\", table: \"" + r.table + "\" }.";
            return "Запись из «" + r.table + "\":\n" + JSON.stringify(r.item, null, 2) + "\n" + who;
          }

          if (action === "scan") {
            const r = await ycDbApi.scanDocumentTable(cfg.oauth, db, { table: table, limit: args.limit });
            if (!r.items.length) return "В таблице «" + r.table + "» пусто.\n" + who + "\nПоложить запись: ycDb { action: \"put\", table: \"" + r.table + "\", item: { … } }.";
            return "Таблица «" + r.table + "\": записей " + r.count + (r.count >= r.limit ? " (показаны первые " + r.limit + ")" : "") + "\n" + who +
              "\n" + JSON.stringify(r.items, null, 2) +
              "\n\nОдна запись: action \"get\" с key. Структура: action \"describe\".";
          }

          if (action === "delete") {
            const key = args.key && typeof args.key === "object" ? args.key : null;
            if (!key) return "Ошибка: укажи key — значения полей первичного ключа записи.";
            const r = await ycDbApi.deleteDocumentItem(cfg.oauth, db, { table: table, key: key });
            return "🗑 Запись удалена из «" + r.table + "\"\n" + who +
              "\nЧто осталось: ycDb { action: \"scan\", table: \"" + r.table + "\" }.";
          }

          const r = await ycDbApi.deleteDocumentTable(cfg.oauth, db, table);
          return "🗑 Таблица удалена ВМЕСТЕ со всеми записями: " + r.table + "\n" + who +
            "\nЭто необратимо. Что осталось: ycDb { action: \"tables\" }.";
        } catch (e) {
          return "Yandex Cloud (ycDb, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },
  };
}

module.exports = { createCloudTools };

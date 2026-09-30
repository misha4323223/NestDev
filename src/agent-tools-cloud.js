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
   оставляет в платном хранилище ещё один образ навсегда), а следом — ycBilling
   (деньги: платёжный аккаунт и баланс, пороги-бюджеты, НАСТОЯЩИЕ цены из
   каталога облака и «платные хвосты» в рублях за месяц), ycCdn (HTTPS-сайт:
   бесплатный сертификат Certificate Manager и CDN-ресурс, который его носит)
   и ycStorage
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
    ycVpc,
    ycCompute,
    ycIam,
    ycFunctions,
    ycBilling,
    ycCdn,
    ycAi,
    ycMonitoring,
    ycMdb,
    ycIg,
    ycAlb,
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
    "\nСтоимость: ycCosts(service) — проверь ДО создания и назови ориентир пользователю. Платное создаётся только с confirm: true после его согласия." +
    "\nМашины: ycCompute — список, карточка, наборы конфигураций, создание, питание, удаление, снимки, serial-консоль и метрики." +
    " Машина платит за каждый час работы, а её диски — и после удаления: предложи остановку вместо простоя и снимок перед удалением."
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
          return "⛔ Менять контейнеры и деплоить ревизии агенту ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры и правила сети». Чтение доступно и сейчас: action overview / revisions / revision.";
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
    // ── Monitoring: метрики каталога ──────────────────────────────────────────
    // Публичный справочник API у Monitoring знает ДВА ресурса — данные метрик
    // (MetricsData) и их метаданные (MetricsMeta); алертов в нём нет, и «поставить
    // порог с письмом» этим инструментом нельзя — об этом сказано в самом ответе,
    // чтобы агент не искал несуществующее действие. Зато можно ЧЕСТНО узнать, какие
    // метрики есть (метаданные) и что они показывают (данные): имена метрик и их
    // метки меняются от сервиса к сервису, и список, записанный по памяти, устареет
    // молча — а метаданные не устаревают.
    "ycMonitor": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "overview").trim().toLowerCase();
        const ALL = ["overview", "names", "metrics"];
        if (ALL.indexOf(action) === -1) return "Ошибка: неизвестное действие ycMonitor «" + action + "». Доступно: " + ALL.join(", ") + ".";
        const resource = String(args.resource || args.resourceId || args.id || "").trim();
        try {
          if (action === "overview" || action === "names") {
            const selectors = action === "names" ? ycMonitoring.selectorFor({ service: args.service, resource_id: resource }) : "";
            const r = await ycMonitoring.listMetrics(cfg.oauth, { folderId: cfg.folderId, selectors: selectors, limit: args.limit });
            const lines = ycMonitoring.linesNames(r);
            if (!lines.length) {
              return "Метрик в каталоге «" + (cfg.folderName || cfg.folderId) + "» не нашлось" + (selectors ? " по селектору " + selectors : "") +
                ". Облако наполняет метрики, только когда ресурсы что-то делают: пустой список — это не ошибка, а пустой каталог.";
            }
            return "Monitoring · каталог «" + (cfg.folderName || cfg.folderId) + "»" + (selectors ? " · селектор " + selectors : "") +
              "\nМетрик-имён: " + r.namesTotal + ", рядов (имя + набор меток): " + r.total + "\n" + lines.join("\n") +
              "\n\nПрочитать данные: ycMonitor { action: \"metrics\", metric: \"cpu_usage\", service: \"compute\", resource: \"<id>\" } — за сколько минут берётся поле minutes, а прореживание (AVG/MAX/MIN/SUM/LAST/COUNT) и число точек — aggregation и maxPoints." +
              "\nПорог с письмом этим инструментом не поставить: публичного REST для алертов у облака нет, алерты настраиваются в консоли Monitoring.";
          }
          if (action === "metrics") {
            const query = String(args.query || "").trim() || ycMonitoring.queryFor(args.metric, { service: args.service, resource_id: resource });
            const minutes = Number(args.minutes) > 0 ? Number(args.minutes) : 60;
            const rows = await ycMonitoring.readMetrics(cfg.oauth, {
              folderId: cfg.folderId,
              query: query,
              minutes: minutes,
              maxPoints: args.maxPoints,
              aggregation: args.aggregation,
              gapFilling: args.gapFilling,
            });
            const alive = rows.filter((r) => !r.error && r.summary && r.summary.count).length;
            return "Метрики за " + minutes + " мин · каталог «" + (cfg.folderName || cfg.folderId) + "»\n" + ycMonitoring.linesMetrics(rows, { minutes: minutes }).join("\n") +
              "\n\nПрочитано: " + alive + " из " + rows.length + ". " +
              (alive
                ? "Ряд отдаётся сводкой (среднее, максимум, последнее и число точек) — читай метрики по делу, а не в цикле."
                : "Пусто — проверь имя метрики и метки: с чужим resource_id ряд вернётся пустым, а без метки — целиком. Что есть на самом деле, покажет ycMonitor { action: \"names\", service: \"compute\", resource: \"…\" }.");
          }
          return "Ошибка: неизвестное действие ycMonitor «" + action + "». Доступно: " + ALL.join(", ") + ".";
        } catch (e) {
          return "Monitoring (ycMonitor, действие " + action + "): " + ((e && e.message) || String(e));
        }
    },

    // ── Managed-базы: PostgreSQL, MySQL и ClickHouse ───────────────────────────
    // Три базы в ОДНОМ инструменте, потому что у них один API (один хост
    // mdb.api.cloud.yandex.net и один набор методов): меняется только сегмент
    // пути. База выбирается полем engine и понимает и «postgresql», и
    // «постгрес», и «pg» — человек называет её по-разному.
    //
    // Создание и удаление платные/необратимые и требуют confirm: true после
    // согласия человека. Пароль пользователя облако отдаёт РОВНО ОДИН раз —
    // при создании; повторно его не покажут ни в списке, ни в консоли.
    // ── Группы одинаковых машин (Instance Groups) ──────────────────────────────
    // Группа — не «несколько машин», а другой ресурс: она создаёт машины по
    // шаблону, держит их число и пересоздаёт удалённые руками. Платят МАШИНЫ
    // группы — как обычные машины, за каждый час работы, поэтому создание и
    // удаление требуют confirm: true после согласия человека, а размер группы
    // называется прямо: это и есть цена.
    "ycIg": async (args) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud — группы машин живут в каталоге.";
        const action = String(args.action || "list").trim().toLowerCase();
        const ALL = ["list", "card", "instances", "operations", "create", "start", "stop", "delete"];
        if (ALL.indexOf(action) === -1) return "Ошибка: неизвестное действие ycIg «" + action + "». Доступно: " + ALL.join(", ") + ".";
        const ref = String(args.group || args.groupId || args.id || args.name || "").trim();
        try {
          if (action === "list") {
            const list = await ycIg.groups(cfg.oauth, cfg.folderId);
            if (!list.length) {
              return "Групп машин в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создать: ycIg { action: \"create\", name: \"web\", subnet: \"<имя подсети>\", size: 2, confirm: true } — каждая машина группы платит за час работы, как обычная машина Compute Cloud.";
            }
            return "Группы машин · каталог «" + (cfg.folderName || cfg.folderId) + "»\n" + list.map((g) => ycIg.groupLine(g)).join("\n") +
              "\n\nМашины группы создаёт САМА группа: удалённая руками машина вернётся — число меняют размером группы, а не удалением машин. Каждая машина платит за час работы (ориентир: ycCosts { service: \"compute\" })." +
              "\nКарточка: ycIg { action: \"card\", group: \"<имя>\" } — шаблон, машины, операции.";
          }
          if (action === "create") {
            if (args.confirm !== true) {
              return "Создание группы машин — решение с ценой: каждая машина группы платит за час работы, как обычная машина, а группа сама создаёт и пересоздаёт машины. Проверь имя, размер и подсеть и вызови снова с confirm: true.\n" +
                "Будет создана группа «" + (args.name || "?") + "» · машин: " + (Number(args.size) > 0 ? Number(args.size) : 2) + " · на машину: " + (args.cores || 2) + " vCPU" + (args.memoryGb ? ", " + args.memoryGb + " ГБ" : "") + " · подсеть: " + (args.subnet || "?") + ".\n" +
                "Ориентир цены даёт ycCosts { service: \"compute\" }, цену за час — каталог облака: ycBilling { action: \"price\", query: \"Compute\" }.";
            }
            const r = await ycIg.create(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              subnet: args.subnet || args.subnetId,
              size: args.size,
              cores: args.cores,
              memoryGb: args.memoryGb,
              coreFraction: args.coreFraction,
              diskSizeGb: args.diskSizeGb != null ? args.diskSizeGb : args.diskGb,
              diskType: args.diskType,
              zone: args.zone,
              imageFamily: args.imageFamily || args.image,
              imageId: args.imageId,
              platformId: args.platformId || args.platform,
              publicIp: args.publicIp,
              preemptible: args.preemptible,
              securityGroups: args.securityGroups || args.securityGroupIds,
              serviceAccountId: args.serviceAccountId,
              sshPublicKey: args.sshPublicKey,
              sshUser: args.sshUser,
              description: args.description,
            });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "") +
              (r.groupId ? "\nСледить: ycIg { action: \"card\", group: \"" + r.groupId + "\" }." : "");
          }
          const g = await ycIg.findGroup(cfg.oauth, cfg.folderId, ref);
          if (!g && action !== "delete") return "Ошибка: не нашёл группу «" + ref + "» в каталоге. Список — ycIg { action: \"list\" }.";
          if (action === "card") {
            const c = await ycIg.card(cfg.oauth, cfg.folderId, ref);
            if (!c) return "Ошибка: не нашёл группу «" + ref + "» в каталоге.";
            const t = c.group.template;
            return ycIg.groupLine(c.group) + "\n" +
              "Шаблон: " + (t.platformId || "—") + " · " + (t.cores || "?") + " vCPU" + (t.memoryHuman ? ", " + t.memoryHuman : "") + (t.diskHuman ? " · диск " + t.diskHuman : "") + (t.hasPublicIp ? " · с публичным адресом" : " · без публичного адреса") + (t.preemptible ? " · прерываемые" : "") +
              ((c.group.targetGroupId || c.group.appTargetGroupId) ? "\nОтдаёт трафик балансировщику: target group " + (c.group.targetGroupId || c.group.appTargetGroupId) : "") +
              "\nМашины (" + c.instances.length + "):" + (c.instances.length ? "\n  " + c.instances.map((i) => ycIg.instanceLine(i)).join("\n  ") : " пока нет") +
              (c.operations.length ? "\nОперации: " + c.operations.slice(0, 5).map((o) => (o.done ? "✓" : "…") + " " + (o.description || o.id)).join(" · ") : "") +
              "\nПитание: ycIg { action: \"stop\", group: \"" + c.group.name + "\" } — машины перестают платить за вычисления (диски продолжают).";
          }
          if (action === "instances") {
            const list = await ycIg.instances(cfg.oauth, g.id);
            return list.length
              ? "Машины группы «" + g.name + "» (" + list.length + "):\n  " + list.map((i) => ycIg.instanceLine(i)).join("\n  ")
              : "Машин в группе «" + g.name + "» нет: группа их создаёт по шаблону — подожди или проверь состояние группы (карточка).";
          }
          if (action === "operations") {
            const list = await ycIg.operations(cfg.oauth, g.id);
            return list.length
              ? "Операции группы «" + g.name + "» (" + list.length + "):\n  " + list.map((o) => (o.done ? "✓" : "…") + " " + (o.description || o.id) + (o.createdAt ? " · " + o.createdAt : "")).join("\n  ")
              : "Операций у группы «" + g.name + "» не видно.";
          }
          if (action === "start" || action === "stop") {
            const r = await ycIg.power(cfg.oauth, action, g, { folderId: cfg.folderId });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "");
          }
          if (action === "delete") {
            const target = g || (await ycIg.findGroup(cfg.oauth, cfg.folderId, ref));
            if (!target) return "Ошибка: не нашёл группу «" + ref + "» в каталоге.";
            if (args.confirm !== true) {
              return "Удаление группы «" + target.name + "» необратимо: она будет удалена ВМЕСТЕ с машинами" + (target.targetSize ? " (" + target.targetSize + " шт.)" : "") + " и их дисками — снимки нужно сделать заранее. Вызови снова с confirm: true после согласия человека.";
            }
            const r = await ycIg.remove(cfg.oauth, { folderId: cfg.folderId, group: target });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "");
          }
          return "Ошибка: неизвестное действие ycIg «" + action + "». Доступно: " + ALL.join(", ") + ".";
        } catch (e) {
          return "Instance Groups (ycIg, действие " + action + "): " + ((e && e.message) || String(e));
        }
    },

    "ycAlb": async (args) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud — балансировщик и его группы целей живут в каталоге.";
        const action = String(args.action || "list").trim().toLowerCase();
        const ALL = ["list", "card", "targets", "routers", "backends", "targetnew", "targetadd", "targetremove", "targetdel", "routernew", "routerdel", "lbnew", "lbstart", "lbstop", "lbdel"];
        if (ALL.indexOf(action) === -1) return "Ошибка: неизвестное действие ycAlb «" + action + "». Доступно: " + ALL.join(", ") + ".";
        const ref = String(args.lb || args.id || args.name || "").trim();
        try {
          if (action === "list") {
            const list = await ycAlb.loadBalancers(cfg.oauth, cfg.folderId);
            if (!list.length) {
              return "Балансировщиков в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Вход в приложение собирают по шагам: группа целей (ycAlb { action: \"targetnew\", name: \"web-targets\", ips: [\"10.10.0.5\"], subnet: \"<подсеть>\" }) → HTTP-роутер → балансировщик (платный, только с confirm: true).";
            }
            return "Балансировщики · каталог «" + (cfg.folderName || cfg.folderId) + "»\n" + list.map((l) => ycAlb.lbLine(l)).join("\n") +
              "\n\nАдрес балансировщика — это адреса его СЛУШАТЕЛЕЙ: пока слушатель не создан, адреса нет, и DNS-запись (ycDns) вешают только после создания. Балансировщик платный — платит за час даже без трафика." +
              "\nКарточка: ycAlb { action: \"card\", lb: \"<имя>\" } — слушатели, роутеры, группы целей.";
          }
          if (action === "targets") {
            const list = await ycAlb.targetGroups(cfg.oauth, cfg.folderId);
            return "Группы целей · каталог «" + (cfg.folderName || cfg.folderId) + "»\n" + (list.length ? list.map((g) => ycAlb.tgLine(g)).join("\n") : "групп целей нет") +
              "\n\nГруппа целей знает ТОЛЬКО адрес и подсеть: ни порта, ни пути, ни проверок здоровья в ней нет — порт задаёт группа бэкендов, путь — роутер. Создать: ycAlb { action: \"targetnew\", name: \"web-targets\", ips: [\"10.10.0.5\"], subnet: \"<подсеть>\" }; добавить адреса: action targetadd.";
          }
          if (action === "routers") {
            const list = await ycAlb.httpRouters(cfg.oauth, cfg.folderId);
            return "HTTP-роутеры · каталог «" + (cfg.folderName || cfg.folderId) + "»\n" + (list.length ? list.map((r) => ycAlb.routerLine(r)).join("\n") : "роутеров нет") +
              "\n\nРоутер — это правила «домен (authority) и путь → группа бэкендов», а не машины и не адреса. Создать: ycAlb { action: \"routernew\", name: \"main-router\", host: \"site.example.com\", backendGroup: \"<группа бэкендов>\" }.";
          }
          if (action === "backends") {
            const list = await ycAlb.backendGroups(cfg.oauth, cfg.folderId);
            return "Группы бэкендов · каталог «" + (cfg.folderName || cfg.folderId) + "»\n" + (list.length ? list.map((b) => "• " + b.name + " · бэкендов: " + b.backendCount).join("\n") : "групп бэкендов нет") +
              "\n\nГруппы бэкендов здесь ТОЛЬКО читаются: в них живут проверки здоровья и балансировка, а создаются они в консоли (или в следующем заходе). Маршрут роутера обязан вести в СУЩЕСТВУЮЩУЮ группу — пустой список значит «роутер создавать некуда».";
          }
          if (action === "card") {
            const c = await ycAlb.card(cfg.oauth, cfg.folderId, ref);
            if (!c) return "Ошибка: не нашёл балансировщик «" + ref + "» в каталоге. Список — ycAlb { action: \"list\" }.";
            const lines = [ycAlb.lbLine(c.lb)];
            if (c.lb.listeners.length) {
              lines.push("Слушатели (" + c.lb.listeners.length + "):");
              for (const l of c.lb.listeners) lines.push("  " + ycAlb.listenerLine(l));
            } else {
              lines.push("Слушателей нет: балансировщик создан, но ни на одном порту не отвечает.");
            }
            for (const pair of c.listeners) {
              lines.push("Роутер «" + pair.router.name + "»:");
              for (const h of pair.router.hosts) {
                for (const rt of h.routes) {
                  lines.push("  " + (h.authority.length ? "домены: " + h.authority.join(", ") : "любой домен") + " · " + (rt.pathExact ? "точный путь " + rt.pathExact : "путь " + (rt.pathPrefix || "/") + "*") + " → группа бэкендов " + (rt.backendGroupId || "—"));
                }
              }
            }
            if (c.backendGroups.length) lines.push("Группы бэкендов: " + c.backendGroups.map((b) => b.name).join(", "));
            if (c.targetGroups.length) {
              lines.push("Группы целей (" + c.targetGroups.length + "):");
              for (const g of c.targetGroups) {
                lines.push("  " + ycAlb.tgLine(g));
                for (const t of g.targets) lines.push("    " + ycAlb.targetLine(t));
              }
            }
            lines.push(!c.targetGroupsResolved && c.targetGroups.length
              ? "Связь с группами целей не подтвердилась (нет групп бэкендов или маршрутов): показаны все группы целей каталога."
              : "Здоровье целей (здорова/не отвечает) отдаёт отдельный метод облака — в карточке его нет.");
            return lines.join("\n");
          }
          if (action === "targetnew") {
            const r = await ycAlb.createTargetGroup(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              ips: args.ips || args.targets,
              subnet: args.subnet || args.subnetId,
              description: args.description,
            });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "") +
              (r.groupId ? "\nСледующий шаг: HTTP-роутер, ycAlb { action: \"routernew\", backendGroup: \"<группа бэкендов>\" }." : "");
          }
          if (action === "targetadd" || action === "targetremove") {
            const r = await ycAlb.changeTargets(cfg.oauth, action === "targetadd" ? "add" : "remove", {
              folderId: cfg.folderId,
              group: args.group || args.targetGroup || args.id,
              ips: args.ips || args.targets,
              subnet: args.subnet || args.subnetId,
            });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "");
          }
          if (action === "targetdel") {
            const g = await ycAlb.findTargetGroup(cfg.oauth, cfg.folderId, args.group || args.targetGroup || args.id || args.name);
            if (!g) return "Ошибка: не нашёл группу целей «" + String(args.group || args.targetGroup || args.id || args.name || "").trim() + "» в каталоге. Список — ycAlb { action: \"targets\" }.";
            if (args.confirm !== true) {
              return "Удаление группы целей «" + g.name + "» необратимо: список из " + g.targetCount + " целей будет потерян. Сами машины не тронутся, но балансировщик перестанет знать, куда ходить. Вызови снова с confirm: true после согласия человека.";
            }
            const r = await ycAlb.removeTargetGroup(cfg.oauth, { folderId: cfg.folderId, group: g });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "");
          }
          if (action === "routernew") {
            const r = await ycAlb.createHttpRouter(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              host: args.host || args.authority,
              pathPrefix: args.pathPrefix || args.prefix,
              pathExact: args.pathExact,
              backendGroup: args.backendGroup || args.backendGroupId,
              routeName: args.routeName,
              description: args.description,
            });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "") +
              (r.routerId ? "\nСледующий шаг: слушатель балансировщика, ycAlb { action: \"lbnew\", listener: \"http\", router: \"" + (r.router && r.router.name ? r.router.name : r.routerId) + "\", confirm: true } — балансировщик платный." : "");
          }
          if (action === "routerdel") {
            const r0 = await ycAlb.findHttpRouter(cfg.oauth, cfg.folderId, args.router || args.id || args.name);
            if (!r0) return "Ошибка: не нашёл HTTP-роутер «" + String(args.router || args.id || args.name || "").trim() + "» в каталоге. Список — ycAlb { action: \"routers\" }.";
            if (args.confirm !== true) {
              return "Удаление HTTP-роутера «" + r0.name + "» необратимо: правила (" + r0.routeCount + ") будут потеряны, а слушатель, который на него смотрит, перестанет отвечать. Вызови снова с confirm: true после согласия человека.";
            }
            const r = await ycAlb.removeRouter(cfg.oauth, { folderId: cfg.folderId, router: r0 });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "");
          }
          if (action === "lbnew") {
            if (args.confirm !== true) {
              return "Создание балансировщика — решение с ценой: ресурсные единицы и сам ресурс тарифицируются за час, даже когда трафика нет. Проверь имя, подсеть, слушателя и вызови снова с confirm: true.\n" +
                "Будет создан балансировщик «" + (args.name || "?") + "» · слушатель: " + (args.listener || "http") + " · порт: " + (args.port || (String(args.listener || "").toLowerCase() === "https" ? 443 : 80)) + " · зона: " + (args.zone || "по подсети " + (args.subnet || "?")) + ".\n" +
                "Ориентир цены — каталог облака: ycBilling { action: \"price\", query: \"Application Load Balancer\" }; расход облако по API не отдаёт.";
            }
            const r = await ycAlb.createLoadBalancer(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              subnet: args.subnet || args.subnetId,
              zone: args.zone || args.zoneId,
              listener: args.listener || args.kind,
              port: args.port,
              listenerName: args.listenerName,
              router: args.router || args.httpRouter || args.httpRouterId,
              certificate: args.certificate || args.certificateId,
              backendGroup: args.backendGroup || args.backendGroupId,
              address: args.address || args.staticAddress,
              securityGroups: args.securityGroups || args.securityGroupIds,
              httpToHttps: args.httpToHttps,
              minZoneSize: args.minZoneSize,
              maxSize: args.maxSize,
              description: args.description,
            });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "") +
              (r.lbId ? "\nСледить: ycAlb { action: \"card\", lb: \"" + r.lbId + "\" }. Адрес появится в карточке после создания — только потом вешай на него DNS-запись (ycDns)." : "");
          }
          if (action === "lbstart" || action === "lbstop") {
            const lb = await ycAlb.findLoadBalancer(cfg.oauth, cfg.folderId, ref);
            if (!lb) return "Ошибка: не нашёл балансировщик «" + ref + "» в каталоге. Список — ycAlb { action: \"list\" }.";
            const r = await ycAlb.power(cfg.oauth, action === "lbstart" ? "start" : "stop", lb, { folderId: cfg.folderId });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "");
          }
          if (action === "lbdel") {
            const lb = await ycAlb.findLoadBalancer(cfg.oauth, cfg.folderId, ref);
            if (!lb) return "Ошибка: не нашёл балансировщик «" + ref + "» в каталоге. Список — ycAlb { action: \"list\" }.";
            if (args.confirm !== true) {
              return "Удаление балансировщика «" + lb.name + "» необратимо: он уйдёт вместе со слушателями и адресами" + (lb.addresses.length ? " (" + lb.addresses.join(", ") + ")" : "") + ", а домен, который на них смотрел, перестанет открываться. Вызови снова с confirm: true после согласия человека.";
            }
            const r = await ycAlb.remove(cfg.oauth, { folderId: cfg.folderId, lb: lb });
            return r.message + ((r.warnings || []).length ? "\n" + r.warnings.join("\n") : "");
          }
          return "Ошибка: неизвестное действие ycAlb «" + action + "». Доступно: " + ALL.join(", ") + ".";
        } catch (e) {
          return "Application Load Balancer (ycAlb, действие " + action + "): " + ((e && e.message) || String(e));
        }
    },

    "ycMdb": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud — кластеры баз живут в каталоге.";
        const action = String(args.action || "overview").trim().toLowerCase();
        const ALL = ["overview", "card", "hosts", "databases", "users", "logs", "operations", "presets", "start", "stop", "create", "delete"];
        if (ALL.indexOf(action) === -1) return "Ошибка: неизвестное действие ycMdb «" + action + "». Доступно: " + ALL.join(", ") + ".";
        const engineKey = String(args.engine || "").trim();
        const eng = ycMdb.engineOf(engineKey);
        const ref = String(args.cluster || args.clusterId || args.id || args.name || "").trim();
        // Для каждого действия своя база: без неё непонятно, ЧТО смотреть —
        // у каждой базы свой список и свои пути.
        const needEngine = (who) =>
          eng ? "" : "Ошибка: укажи engine — " + who + " в PostgreSQL, MySQL и ClickHouse разные. Доступно: " + ycMdb.ENGINE_KEYS.join(", ") + ".";
        try {
          // ── Списки: без engine — сразу все три базы ──
          if (action === "overview") {
            const keys = eng ? [eng.key] : ycMdb.ENGINE_KEYS;
            const blocks = [];
            let total = 0;
            for (const k of keys) {
              const list = await ycMdb.clusters(cfg.oauth, k, cfg.folderId);
              total += list.length;
              const e = ycMdb.engineOf(k);
              blocks.push((e ? e.ru : k) + " — " + (list.length ? list.length + " кластер(ов):\n  " + list.map((c) => ycMdb.clusterLine(c, k)).join("\n  ") : "кластеров нет"));
            }
            return "Managed-базы · каталог «" + (cfg.folderName || cfg.folderId) + "»\n" + blocks.join("\n") +
              "\n\nВсего кластеров: " + total + ". Действия по кластеру: ycMdb { engine: \"postgresql\", cluster: \"имя\", action: \"card\" } — карточка с хостами и строкой подключения." +
              "\nСоздание кластера платное (класс тарифицируется почасово) и требует confirm: true; точную цену за час показывает каталог облака: ycBilling { action: \"price\", query: \"PostgreSQL\" }." +
              "\nОстановка (action: \"stop\") экономит деньги за вычисления, но диск и резервные копии тарифицируются и у остановленного кластера.";
          }
          if (action === "presets") {
            const bad = needEngine("классы хостов");
            if (bad) return bad;
            const list = await ycMdb.presets(cfg.oauth, eng.key);
            if (!list.length) return "Облако не отдало классы хостов для " + eng.ru + " — попробуй позже.";
            const show = list.slice(0, 40);
            return "Классы хостов «" + eng.ru + "» — всего " + list.length + ":\n" +
              show.map((p) => "• " + p.id + " — " + (p.cores || "?") + " vCPU, " + (p.memoryHuman || "?") + (p.zoneIds.length ? " · зоны: " + p.zoneIds.join(", ") : "")).join("\n") +
              (list.length > show.length ? "\n…и ещё " + (list.length - show.length) : "") +
              "\n\nСоздание: ycMdb { engine: \"" + eng.key + "\", action: \"create\", name: \"db-1\", version: \"" + (eng.versions[0] || "?") + "\", preset: \"" + list[0].id + "\", subnet: \"<имя подсети>\", confirm: true }." +
              "\nКлассы различаются ценой в разы: назови человеку выбранный класс и спроси согласие ДО создания.";
          }
          // ── Всё остальное — про конкретный кластер ──
          if (!eng) return needEngine("кластеры");
          if (action === "create") {
            const name = String(args.name || "").trim();
            const version = String(args.version || "").trim();
            const preset = String(args.preset || args.resourcePresetId || "").trim();
            const subnet = String(args.subnet || args.subnetId || "").trim();
            const missing = [];
            if (!name) missing.push("name (имя кластера)");
            if (!version) missing.push("version (версия базы" + (eng.versions.length ? ": " + eng.versions.join(", ") : "") + ")");
            if (!preset) missing.push("preset (класс хоста: ycMdb { engine: \"" + eng.key + "\", action: \"presets\" })");
            if (!subnet) missing.push("subnet (имя или id подсети: ycVpc { action: \"subnets\" })");
            if (missing.length) return "Ошибка: для создания кластера «" + eng.ru + "» нужно указать: " + missing.join(", ") + ".";
            if (args.confirm !== true) {
              return "Создание кластера " + eng.ru + " — ПЛАТНОЕ решение: класс «" + preset + "» и диск " +
                (Number(args.diskGb) > 0 ? Number(args.diskGb) : "по умолчанию") + " ГБ тарифицируются почасово и круглосуточно.\n" +
                "Будет создан кластер «" + name + "» (версия " + version + ", зона " + (args.zone || ycMdb.ZONE_DEFAULT) + ", подсеть «" + subnet + "»).\n" +
                "Точную цену за час назовёт каталог облака: ycBilling { action: \"price\", query: \"" + eng.ru + "\" }. Назови ориентир человеку и получи согласие, затем повтори с confirm: true." +
                "\nПароль пользователя будет сгенерирован и показан ОДИН раз — его место в хранилище секретов (ycSecret), а не в переписке.";
            }
            const r = await ycMdb.create(cfg.oauth, eng.key, {
              folderId: cfg.folderId,
              name: name,
              version: version,
              preset: preset,
              diskGb: args.diskGb,
              diskType: args.diskType,
              zone: args.zone,
              subnet: subnet,
              user: args.user,
              userPassword: args.userPassword,
              database: args.database || args.dbName,
              publicIp: args.publicIp,
            });
            return "✅ " + r.message +
              "\nАдрес подключения даёт ХОСТ, а не кластер: имя хоста покажет карточка — ycMdb { engine: \"" + eng.key + "\", cluster: \"" + name + "\", action: \"card\" }." +
              "\n\nПАРОЛЬ пользователя «" + r.user + "» для базы «" + r.database + "» — показывается один раз:\n" + r.secret +
              "\n\n⚠ " + r.warnings.join("\n⚠ ") +
              "\nСохрани пароль в хранилище секретов (ycSecret) или отдай пользователю: второй раз облако его не покажет. Создание кластера идёт минутами — проверь состояние: ycMdb { engine: \"" + eng.key + "\", action: \"overview\" }.";
          }
          if (!ref && action !== "delete") {
            return "Ошибка: укажи cluster — имя или id кластера. Список: ycMdb { engine: \"" + eng.key + "\", action: \"overview\" }.";
          }
          const cl = await ycMdb.findCluster(cfg.oauth, eng.key, cfg.folderId, ref);
          if (action === "card") {
            const r = await ycMdb.cardLines(cfg.oauth, eng.key, cl || ref, { folderId: cfg.folderId });
            return "Managed-базы · " + eng.ru + "\n" + r.lines.join("\n") +
              "\n\nЛоги за час: ycMdb { engine: \"" + eng.key + "\", cluster: \"" + r.cluster.name + "\", action: \"logs\" }. Остановка экономит деньги за вычисления: action \"stop\".";
          }
          if (!cl) return "Не нашёл кластер «" + ref + "» среди " + eng.ru + " в каталоге.";
          if (action === "hosts") {
            const list = await ycMdb.hosts(cfg.oauth, eng.key, cl.id);
            return "Хосты кластера «" + cl.name + "» — " + list.length + ":\n" + (list.length ? list.map(ycMdb.hostLine).join("\n") : "пусто") +
              "\n\nИмя хоста — это и есть адрес подключения (точки входа у кластера нет).";
          }
          if (action === "databases") {
            const list = await ycMdb.databases(cfg.oauth, eng.key, cl.id);
            return "Базы кластера «" + cl.name + "» — " + list.length + ":\n" + (list.length ? list.map((d) => "• " + d.name + (d.owner ? " — владелец " + d.owner : "")).join("\n") : "баз нет");
          }
          if (action === "users") {
            const list = await ycMdb.users(cfg.oauth, eng.key, cl.id);
            return "Пользователи кластера «" + cl.name + "» — " + list.length + ":\n" +
              (list.length ? list.map((u) => "• " + u.name + (u.permissions.length ? " — доступ: " + u.permissions.join(", ") : "")).join("\n") : "пользователей нет") +
              "\n\nПароли облако в чтении не отдаёт — их можно только сменить. Забытый пароль меняют в консоли Yandex Cloud.";
          }
          if (action === "logs") {
            const minutes = Number(args.minutes) > 0 ? Number(args.minutes) : 60;
            const r = await ycMdb.logs(cfg.oauth, eng.key, cl.id, { minutes: minutes, serviceType: args.serviceType, limit: args.limit });
            if (!r.rows.length) {
              return "Логи кластера «" + cl.name + "» за " + minutes + " мин пусты. Это не ошибка: тишина в логе — обычное дело, если база не делает ничего необычного. Увеличь minutes или посмотри другой тип логов (serviceType: " + (eng.logTypes.join(", ") || "—") + ").";
            }
            return "Логи «" + cl.name + "» за " + minutes + " мин — записей " + r.rows.length + ":\n" +
              r.rows.map((x) => (x.timestamp ? String(x.timestamp).replace("T", " ").slice(0, 19) + "  " : "") + x.text).join("\n");
          }
          if (action === "operations") {
            const list = await ycMdb.operations(cfg.oauth, eng.key, cl.id, { limit: args.limit });
            return "Операции кластера «" + cl.name + "» (свежие сверху) — " + list.length + ":\n" +
              (list.length ? list.map((o) => (o.done ? "✓ " : "⏳ ") + String(o.createdAt || "").replace("T", " ").slice(0, 19) + " — " + (o.description || o.metadataType || o.id) + (o.error ? " · ОШИБКА: " + o.error : "")).join("\n") : "операций не видно");
          }
          if (action === "start" || action === "stop") {
            const r = await ycMdb.power(cfg.oauth, eng.key, action, cl, {});
            return (r.changed ? "✅ " : "") + r.message + ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }
          if (action === "delete") {
            const target = cl || (await ycMdb.findCluster(cfg.oauth, eng.key, cfg.folderId, ref));
            if (!target) return "Не нашёл кластер «" + ref + "» среди " + eng.ru + " в каталоге.";
            if (args.confirm !== true) {
              const hs = await ycMdb.hosts(cfg.oauth, eng.key, target.id).catch(() => []);
              return "Удаление кластера «" + target.name + "» НЕОБРАТИМО: вместе с ним уйдут " + hs.length + " хост(ов), все базы и РЕЗЕРВНЫЕ КОПИИ — восстановить данные будет не из чего." +
                (target.deletionProtection ? "\nУ кластера ВКЛЮЧЕНА защита от удаления (deletionProtection) — сначала сними её в консоли Yandex Cloud, иначе облако откажет." : "") +
                "\nЕсли данные ещё нужны, сначала сделай дамп базы. Получи согласие пользователя и повтори с confirm: true.";
            }
            const r = await ycMdb.remove(cfg.oauth, eng.key, { clusterId: target.id });
            return "🗑 " + r.message + ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }
          return "Ошибка: неизвестное действие ycMdb «" + action + "». Доступно: " + ALL.join(", ") + ".";
        } catch (e) {
          return "Managed-базы (ycMdb, действие " + action + "): " + ((e && e.message) || String(e));
        }
    },

    // ── Яндекс AI: перевод, текст со снимка, речь и модели AI Studio ───────────
    // Четыре сервиса в ОДНОМ инструменте, потому что задача у них одна —
    // превратить одно в другое: язык в язык, картинку в текст, текст в звук,
    // звук в текст. Чекбоксы разрешений не спрашиваем: это не ресурсы каталога,
    // а запросы к сервису; но каждый запрос облако ТАРИФИЦИРУЕТ, и ответ говорит
    // об этом прямо, а не удивляет счётом.
    // Формы принимают СПИСКИ: targets (несколько языков), files (несколько
    // снимков), voices (несколько голосов) — «сразу пачкой» здесь и есть смысл.
    // AI Studio — тот же токен и каталог: список моделей каталога (Models API),
    // ответ модели (TextGeneration), токены (бесплатно, до запроса) и векторы.
    "ycAi": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud» (SpeechKit, Vision и Translate работают по тому же токену).";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud — сервисы Яндекс AI привязаны к каталогу.";
        const action = String(args.action || "translate").trim().toLowerCase();
        const ALL = ["translate", "languages", "ocr", "speak", "listen", "voices", "models", "tokens", "complete", "embed"];
        if (ALL.indexOf(action) === -1) {
          return "Ошибка: неизвестное действие ycAi «" + action + "». Доступно: " + ALL.join(", ") + ".";
        }
        // Список из одного значения и список из многих — одна форма: и модель, и
        // человек называют и строкой, и массивом, а разбирать это в каждом
        // действии по-своему — верный способ разойтись в поведении.
        const asList = (v) =>
          Array.isArray(v)
            ? v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean)
            : String(v == null ? "" : v).trim()
              ? [String(v).trim()]
              : [];
        const mb = (n) => (Math.round((n / 1048576) * 10) / 10) + " МБ";
        try {
          if (action === "languages") {
            const langs = await ycAi.listLanguages(cfg.oauth, cfg.folderId);
            if (!langs.length) return "Облако не отдало список языков перевода (пустой ответ) — проверь каталог и токен.";
            const show = langs.slice(0, 60);
            return "Языки перевода Яндекс AI — всего " + langs.length + ":\n" + show.map((l) => "• " + l.code + " — " + l.name).join("\n") +
              (langs.length > show.length ? "\n…и ещё " + (langs.length - show.length) + " — код языка можно писать и вручную." : "") +
              "\n\nПеревести: ycAi { action: \"translate\", text: \"…\", targets: [\"en\", \"de\"] } — целевых языков можно указать несколько сразу.";
          }
          if (action === "translate") {
            const texts = asList(args.texts && args.texts.length ? args.texts : args.text);
            if (!texts.length) return "Ошибка: для перевода нужен text (одна строка) или texts (несколько строк).";
            const targets = asList(args.targets && args.targets.length ? args.targets : args.target);
            if (!targets.length) return "Ошибка: укажи target или targets — язык, на который переводить (ru, en, de, zh…). Список языков: ycAi { action: \"languages\" }.";
            const source = String(args.source || "").trim();
            const list = await ycAi.translate(cfg.oauth, { texts: texts, targets: targets, source: source, folderId: cfg.folderId });
            if (!list.length) return "Облако вернуло пустой перевод — проверь текст и коды языков.";
            const rows = list.map((o) => {
              const head = "→ " + o.language + (o.detected ? " (переведено с " + o.detected + ")" : "");
              const body = o.translations.map((t, i) => "   " + (texts.length > 1 ? i + 1 + ". " : "") + (t || "—"));
              return head + "\n" + body.join("\n");
            });
            return "Перевод Яндекс AI: строк " + texts.length + ", языков " + list.length + (source ? " (источник: " + source + ")" : "") + "\n" + rows.join("\n") +
              "\n\nКаждый целевой язык — ОТДЕЛЬНЫЙ запрос к Translate; запросы тарифицируются, поэтому переводи сразу пачкой, а не по языку за раз." +
              (texts.length > 1 ? " Строк несколько — они уехали одним запросом на язык." : "");
          }
          if (action === "voices") {
            const r = await ycAi.listVoices(cfg.oauth, cfg.folderId);
            if (!r.voices.length) return "Облако не отдало список голосов SpeechKit — попробуй позже.";
            return "Голоса SpeechKit" + (r.fromCloud ? " (список облака)" : " (проверенные; облако список не отдало)") + ":\n" +
              r.voices.map((v) => "• " + v.id + (v.lang ? " — " + v.lang : "") + (v.who && v.who !== v.id ? " · " + v.who : "")).join("\n") +
              "\n\nОзвучить: ycAi { action: \"speak\", text: \"…\", voices: [\"alena\", \"filipp\"] } — голосов можно указать несколько, каждый станет отдельным файлом." +
              "\nЭмоции (good / evil / neutral) понимают только русские голоса; формат по умолчанию mp3, для иного укажи format: oggopus, lpcm, wav.";
          }
          if (action === "models") {
            const r = await ycAi.listModels(cfg.oauth, cfg.folderId);
            if (!r.models.length) return "Облако не отдало список моделей AI Studio — попробуй позже.";
            return "Модели AI Studio" + (r.fromCloud ? " (список каталога «" + (cfg.folderName || cfg.folderId) + "»)" : " (проверенные; облако список не отдало)") + ":\n" +
              r.models.map((m) => "• " + m.id + (m.kind ? " — " + m.kind : "") + (m.who ? " · " + m.who : "")).join("\n") +
              "\n\nСпросить модель: ycAi { action: \"complete\", prompt: \"…\", model: \"yandexgpt-5-lite\" }. " + ycAi.aiPriceLine("yandexgpt-5-lite") +
              "\nПеред платным запросом посчитай токены — это БЕСПЛАТНО: ycAi { action: \"tokens\", text: \"…\", model: \"…\" }.";
          }
          if (action === "tokens") {
            const text = String(args.text || args.prompt || "").trim();
            if (!text) return "Ошибка: нужен text (или prompt) — текст, токены которого посчитать. Это бесплатно.";
            const model = String(args.model || "yandexgpt-5-lite").trim();
            const r = await ycAi.tokenize(cfg.oauth, { text: text, model: model, folderId: cfg.folderId });
            return "Токены текста: " + r.count + " (модель " + ycAi.modelNameOf(r.modelUri) + ", " + text.length + " символов)" +
              (r.first.length ? "\nПервые токены: " + r.first.join(" · ") : "") +
              "\n\nТокенизация бесплатна — считай ДО запроса. " + ycAi.aiPriceLine(r.modelUri) +
              "\nОтвет: ycAi { action: \"complete\", prompt: \"…\", model: \"" + model + "\" }.";
          }
          if (action === "complete") {
            const prompt = String(args.prompt || args.text || args.question || "").trim();
            if (!prompt) return "Ошибка: нужен prompt (или text) — запрос к модели AI Studio.";
            const model = String(args.model || "yandexgpt-5-lite").trim();
            const r = await ycAi.complete(cfg.oauth, { prompt: prompt, system: args.system, model: model, temperature: args.temperature, maxTokens: args.maxTokens, folderId: cfg.folderId });
            const t = r.text.length > 6000 ? r.text.slice(0, 6000) + "\n…(всего " + r.text.length + " символов)" : r.text;
            const cost = ycAi.aiCostText(r.modelUri, r.usage);
            return t + "\n\n— модель " + ycAi.modelNameOf(r.modelUri) + (r.modelVersion ? " (" + r.modelVersion + ")" : "") +
              (r.usage.total ? ", токенов: вход " + r.usage.input + ", ответ " + r.usage.output : "") +
              (cost ? ", " + cost : "") + "\n" + ycAi.aiPriceLine(r.modelUri) +
              "\nСписок моделей: ycAi { action: \"models\" }.";
          }
          if (action === "embed") {
            const text = String(args.text || "").trim();
            if (!text) return "Ошибка: нужен text — текст, который превратить в вектор; модель — имя (text-search-doc) или полный адрес.";
            const model = String(args.model || "text-search-doc").trim();
            const r = await ycAi.embed(cfg.oauth, { text: text, model: model, folderId: cfg.folderId });
            return "Вектор текста готов: " + r.dims + " чисел, модель " + ycAi.modelNameOf(r.modelUri) + ".\nПервые числа: " + r.vector.slice(0, 8).map((x) => String(Math.round(x * 1000) / 1000)).join(", ") + ", …" +
              "\n\nВекторизация платная: " + ycAi.aiPriceLine(r.modelUri) +
              "\nДокументы и запросы векторизуют РАЗНЫМИ моделями (text-search-doc и text-search-query) — близость между чужими пространствами смысла не имеет.";
          }
          if (action === "ocr") {
            const files = asList(args.files && args.files.length ? args.files : args.file);
            const inline = args.content != null ? String(args.content).trim() : "";
            if (!files.length && !inline) return "Ошибка: нужен file (путь к картинке или PDF), files (несколько сразу) или content (готовый base64).";
            const langs = asList(args.langs || args.languages || args.languageCodes);
            const model = String(args.model || "page").trim().toLowerCase();
            const parts = [];
            const jobs = files.length ? files : [null];
            for (const f of jobs) {
              let content = inline;
              let mimeType = String(args.mimeType || "").trim();
              let size = inline.length;
              if (f) {
                const p = resolvePath(f, loadSettings());
                if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return "Ошибка: файла «" + f + "» нет (путь от рабочей папки). Проверь: " + p;
                size = fs.statSync(p).size;
                // Vision принимает до 10 МБ на снимок (PDF — до 20 МБ, но разбивка
                // идёт страницами): честнее отказать до запроса, чем получить отказ сервиса.
                if (size > 10 * 1048576) return "Ошибка: файл «" + f + "» — " + mb(size) + ", а распознавание принимает до 10 МБ. Уменьши снимок или разбей документ.";
                if (!mimeType) mimeType = ycAi.mimeForExt(path.extname(p));
                if (!mimeType) return "Ошибка: не понял тип файла «" + f + "» («" + (path.extname(p) || "без расширения") + "»). Vision принимает jpg, jpeg, png, bmp, tiff, pdf — или задай mimeType явно.";
                content = fs.readFileSync(p).toString("base64");
              }
              if (!mimeType) mimeType = "image/jpeg";
              const r = await ycAi.recognizeText(cfg.oauth, { content: content, mimeType: mimeType, languageCodes: langs, model: model, folderId: cfg.folderId });
              parts.push({ file: f || "content (base64)", size: size, mimeType: mimeType, text: r.text });
            }
            const head = "Vision OCR · каталог «" + (cfg.folderName || cfg.folderId) + "» · модель " + model + " · языки " + (langs.length ? langs.join(", ") : "ru, en") +
              (parts.length > 1 ? " · файлов " + parts.length : "");
            const body = parts.map((p) => {
              const t = p.text ? (p.text.length > 4000 ? p.text.slice(0, 4000) + "\n…(всего " + p.text.length + " символов)" : p.text) : "(текста не нашлось)";
              return "\n── " + p.file + " · " + p.mimeType + " · " + (p.size >= 1048576 ? mb(p.size) : Math.max(1, Math.round(p.size / 1024)) + " КБ") + "\n" + t;
            });
            const anyText = parts.some((p) => p.text);
            return head + body.join("\n") +
              (anyText
                ? "\n\nРаспознавание тарифицируется по объёму картинки. Если текст вышел битым, помогут модель handwritten (рукописное), table (таблицы) и языки: ycAi { action: \"ocr\", file: \"…\", langs: [\"ru\", \"en\"], model: \"handwritten\" }."
                : "\n\nТекста на изображении не нашлось: проверь, что на снимке есть буквы, что выбраны нужные языки (langs) и что картинка не перевёрнута. Для мелкого и рукописного текста поможет model handwritten.");
          }
          if (action === "speak") {
            const text = String(args.text || "").trim();
            if (!text) return "Ошибка: для озвучки нужен text — то, что сказать.";
            const asked = asList(args.voices && args.voices.length ? args.voices : args.voice);
            const want = asked.length ? asked : ["alena"];
            const format = String(args.format || "mp3").trim().toLowerCase();
            const lang = String(args.lang || "ru-RU").trim();
            const ext = format === "oggopus" ? "ogg" : format;
            const made = [];
            for (const voice of want) {
              const r = await ycAi.synthesize(cfg.oauth, {
                text: text,
                voice: voice,
                lang: lang,
                format: format,
                speed: args.speed,
                emotion: args.emotion,
                sampleRateHertz: args.sampleRateHertz,
                folderId: cfg.folderId,
              });
              const p = args.out
                ? resolvePath(args.out, loadSettings())
                : path.join(agentWorkDir(loadSettings()), "ai-speech-" + String(voice).replace(/[^\w.-]/g, "") + "-" + Date.now() + "." + ext);
              fs.mkdirSync(path.dirname(p), { recursive: true });
              fs.writeFileSync(p, r.audio);
              made.push({ voice: voice, p: p, size: r.audio.length });
            }
            return "🔊 Речь готова: " + made.length + " файл(ов), " + text.length + " символов текста, голос(а) " + want.join(", ") + " (" + lang + ", " + format + ")\n" +
              made.map((m) => "• " + m.voice + " → " + m.p + " (" + (m.size >= 1048576 ? mb(m.size) : Math.max(1, Math.round(m.size / 1024)) + " КБ") + ")").join("\n") +
              "\n\nОткрыть и послушать: openPath. Файлы лежат в рабочей папке агента, пока ты их не заберёшь." +
              (made.length > 1 ? " Каждый голос — отдельный запрос к SpeechKit, и каждый тарифицируется по длине звука." : " SpeechKit тарифицируется по длине звука.");
          }
          if (action === "listen") {
            const file = String(args.file || args.audio || "").trim();
            if (!file) return "Ошибка: нужен file — путь к записи (ogg/opus, mp3, lpcm).";
            const p = resolvePath(file, loadSettings());
            if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return "Ошибка: файла «" + file + "» нет (путь от рабочей папки). Проверь: " + p;
            const size = fs.statSync(p).size;
            // Синхронное распознавание берёт короткое аудио: предел объёма знает
            // сервис, но отказ до отправки понятнее, чем «файл слишком большой».
            if (size > 1048576) return "Ошибка: файл «" + file + "» — " + mb(size) + ", а распознавание одним запросом принимает до 1 МБ (примерно минута сжатой речи). Разрежь запись на части или отдай сжатый ogg/opus.";
            const byExt = { ogg: "oggopus", opus: "oggopus", oga: "oggopus", mp3: "mp3", pcm: "lpcm", raw: "lpcm", lpcm: "lpcm" };
            const ext = path.extname(p).replace(".", "").toLowerCase();
            const format = String(args.format || byExt[ext] || "oggopus").trim().toLowerCase();
            const r = await ycAi.recognizeSpeech(cfg.oauth, {
              audio: fs.readFileSync(p),
              lang: args.lang,
              format: format,
              sampleRateHertz: args.sampleRateHertz,
              topic: args.topic,
              folderId: cfg.folderId,
            });
            if (!r.text) return "Речь распознана, но текста нет — возможно, в записи тишина или шум. Проверь формат («" + format + "») и язык.";
            return "🗣 Распознано из «" + file + "» (" + (size >= 1048576 ? mb(size) : Math.max(1, Math.round(size / 1024)) + " КБ") + ", " + format + ", " + (args.lang || "ru-RU") + "):\n\n" + r.text +
              "\n\nSpeechKit тарифицируется по длине звука. Долгую запись синхронный запрос не возьмёт (до 1 МБ) — разрежь её на части или используй формат oggopus.";
          }
          return "Ошибка: неизвестное действие ycAi «" + action + "». Доступно: " + ALL.join(", ") + ".";
        } catch (e) {
          return "Яндекс AI (ycAi, действие " + action + "): " + ((e && e.message) || String(e));
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
    // ── Сеть VPC: подсети, группы безопасности, статические адреса ──────────
    // Сеть создавать было чем (ycCreate service vpc), а всё, ради чего сеть
    // существует, — нечем: подсеть, группу безопасности и статический адрес
    // делали только в консоли облака. Без подсети не поднимется машина, без
    // группы безопасности она окажется открыта всему интернету, а без
    // статического адреса её публичный IP сменится после первой перезагрузки.
    // Тела запросов живут в src/yc-vpc.js — здесь выбор действия, права и
    // человеческий ответ.
    "ycVpc": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "list").trim().toLowerCase();
        const ACTIONS = ["list", "subnets", "addsubnet", "delsubnet", "groups", "addgroup", "delgroup", "addrule", "delrule", "addresses", "reserve", "release"];
        if (ACTIONS.indexOf(action) < 0) {
          return "Ошибка: неизвестное действие ycVpc «" + action + "». Доступно: " + ACTIONS.join(", ") + ".";
        }
        const needsCreate = ["addsubnet", "addgroup", "reserve"].indexOf(action) >= 0;
        const needsUpdate = ["addrule", "delrule"].indexOf(action) >= 0;
        const needsDelete = ["delsubnet", "delgroup", "release"].indexOf(action) >= 0;
        if (needsCreate && !cfg.allowCreate) {
          return "⛔ Создавать ресурсы сети агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть сеть и адреса можно и сейчас: ycVpc { action: \"list\" }.";
        }
        if (needsUpdate && !cfg.allowUpdate) {
          return "⛔ Менять правила групп безопасности агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры и правила сети». Посмотреть правила можно и сейчас: ycVpc { action: \"groups\" }.";
        }
        if (needsDelete && !cfg.allowDelete) {
          return "⛔ Удалять ресурсы сети агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть, что есть, можно и сейчас: ycVpc { action: \"list\" }.";
        }
        try {
          const where = "«" + (cfg.folderName || cfg.folderId) + "»";

          if (action === "list") {
            const nets = await ycVpc.networks(cfg.oauth, cfg.folderId);
            const subs = await ycVpc.subnets(cfg.oauth, cfg.folderId);
            const groups = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
            const addrs = await ycVpc.addresses(cfg.oauth, cfg.folderId);
            const rows = ["Сеть VPC в каталоге " + where];
            rows.push("- сети (" + nets.length + "): " + (nets.length ? nets.map((n) => n.name + " (" + n.id + ")").join(", ") : "нет — создать: ycCreate { service: \"vpc\", name: \"my-net\" }"));
            rows.push("- подсети (" + subs.length + "): " + (subs.length ? subs.map((s) => s.name + " · " + s.zoneId + " · " + (s.v4CidrBlocks || []).join(",")).join("; ") : "нет — без подсети виртуальная машина не поднимется"));
            rows.push("- группы безопасности (" + groups.length + "): " + (groups.length ? groups.map((g) => g.name + " (правил: вход " + g.ingress + ", выход " + g.egress + ")").join("; ") : "нет"));
            const busy = addrs.filter((a) => a.used).length;
            rows.push("- статические адреса (" + addrs.length + ", привязано " + busy + "): " + (addrs.length ? addrs.map((a) => a.address + (a.used ? " (занят)" : " (простаивает)")).join("; ") : "нет"));
            const idle = addrs.filter((a) => !a.used);
            if (idle.length) {
              rows.push("");
              rows.push("⚠ Простаивают " + idle.length + " статических адрес(а): " + idle.map((a) => a.name + " " + a.address).join(", ") + ". За простаивающий адрес облако берёт плату как за занятый — если он не нужен, освободи: ycVpc { action: \"release\", address: \"имя или id\" }.");
            }
            rows.push("");
            rows.push("Подробнее: ycVpc { action: \"subnets\" | \"groups\" | \"addresses\" }. Создать подсеть: ycVpc { action: \"addsubnet\", name, network, zone, cidr }.");
            return rows.join("\n");
          }

          if (action === "subnets") {
            const subs = await ycVpc.subnets(cfg.oauth, cfg.folderId);
            if (!subs.length) {
              return "Подсетей в каталоге " + where + " нет — создать: ycVpc { action: \"addsubnet\", name: \"app-subnet-a\", network: \"<имя сети>\", zone: \"ru-central1-a\", cidr: \"10.10.0.0/24\" }. Список сетей: ycVpc { action: \"list\" }.";
            }
            const nets = await ycVpc.networks(cfg.oauth, cfg.folderId);
            const nameById = {};
            for (const n of nets) nameById[n.id] = n.name;
            const rows = subs.map(
              (s) =>
                "• " + s.name + " (" + s.id + ") · зона " + (s.zoneId || "—") + " · " + ((s.v4CidrBlocks || []).join(", ") || "—") +
                (s.v6CidrBlocks && s.v6CidrBlocks.length ? ", " + s.v6CidrBlocks.join(", ") : "") +
                " · сеть " + (nameById[s.networkId] || s.networkId || "—")
            );
            return "Подсети в каталоге " + where + " (" + subs.length + "):\n" + rows.join("\n") +
              "\n\nСвободный диапазон рядом с занятыми: " + (ycVpc.suggestCidr(subs) || "подобрать не удалось — укажи cidr сам") + ".";
          }

          if (action === "addsubnet") {
            const subs = await ycVpc.subnets(cfg.oauth, cfg.folderId);
            const cidr = args.cidr || args.v4CidrBlocks || ycVpc.suggestCidr(subs);
            const made = await ycVpc.createSubnet(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              network: args.network || args.networkId,
              zoneId: args.zone || args.zoneId,
              cidr,
              description: args.description,
            });
            const range = (made.v4CidrBlocks || []).join(", ");
            return "✅ Подсеть создана: " + made.name + " (" + made.id + ")\nЗона: " + (made.zoneId || "—") + " · диапазон: " + (range || "—") +
              (args.cidr || args.v4CidrBlocks ? "" : "\nДиапазон " + range + " предложен как свободный — в каталоге он ни с чем не пересекается") +
              "\n\nДальше: группа безопасности — ycVpc { action: \"addgroup\", name: \"app-sg\", network: \"<имя сети>\" }, потом правило входа — ycVpc { action: \"addrule\", group: \"app-sg\", direction: \"ingress\", protocol: \"tcp\", port: 22, cidr: \"203.0.113.10/32\" }.";
          }

          if (action === "delsubnet") {
            const ref = args.subnet || args.name || args.id;
            const subs = await ycVpc.subnets(cfg.oauth, cfg.folderId);
            const s = ycVpc.matchByIdOrName(subs, ref) || (subs.length === 1 && !ref ? subs[0] : null);
            if (!s) {
              return "Не нашёл подсеть «" + (ref || "") + "»." + (ref ? "" : " Подсетей несколько — укажи subnet.") + "\nВ каталоге: " + (subs.map((x) => x.name + " (" + x.id + ")").join(", ") || "подсетей нет");
            }
            await ycVpc.deleteSubnet(cfg.oauth, s.id);
            const left = await ycVpc.subnets(cfg.oauth, cfg.folderId);
            return "🗑 Подсеть удалена: " + s.name + " (" + s.id + "), диапазон " + ((s.v4CidrBlocks || []).join(", ") || "—") +
              "\nОсталось подсетей: " + left.length + (left.length ? " — " + left.map((x) => x.name).join(", ") : "") +
              (left.length ? "" : "\n\n⚠ Напоминание: в каталоге больше нет подсетей — виртуальную машину в этой сети не поднять.");
          }

          if (action === "groups") {
            const groups = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
            if (!groups.length) {
              return "Групп безопасности в каталоге " + where + " нет. Создать: ycVpc { action: \"addgroup\", name: \"app-sg\", network: \"<имя сети>\" } — группа без правил НИЧЕГО не пускает, правила добавляются отдельно.";
            }
            const chunks = groups.map((g) => {
              const head = "• " + g.name + " (" + g.id + ") · " + (g.defaultForNetwork ? "группа по умолчанию" : "правил: вход " + g.ingress + ", выход " + g.egress);
              const rules = (g.rules || []).map((r) => "    – " + ycVpc.ruleHuman(r));
              return [head].concat(rules).join("\n");
            });
            return "Группы безопасности в каталоге " + where + " (" + groups.length + "):\n" + chunks.join("\n") +
              "\n\nДобавить правило: ycVpc { action: \"addrule\", group: \"имя\", direction: \"ingress\", protocol: \"tcp\", port: 22, cidr: \"203.0.113.10/32\" }. Убрать: ycVpc { action: \"delrule\", group: \"имя\", direction: \"ingress\", protocol: \"tcp\", port: 22, cidr: \"203.0.113.10/32\" }. ВАЖНО: порт 22 стоит открывать не всему интернету, а конкретному адресу (/32) — правило с cidr 0.0.0.0/0 пускает к машине кого угодно.";
          }

          if (action === "addgroup") {
            const made = await ycVpc.createSecurityGroup(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              network: args.network || args.networkId,
              description: args.description,
              rules: args.rules,
            });
            return "✅ Группа безопасности создана: " + made.name + " (" + made.id + ")\n" +
              "Правила: " + ((made.rules || []).length ? "\n" + made.rules.map((r) => "  – " + ycVpc.ruleHuman(r)).join("\n") : "нет — группа пока ничего не пускает и ничего не выпускает") +
              "\n\nДальше: ycVpc { action: \"addrule\", group: \"" + made.name + "\", direction: \"ingress\", protocol: \"tcp\", port: 22, cidr: \"<адрес пользователя>/32\" }.";
          }

          if (action === "delgroup") {
            const ref = args.group || args.name || args.id;
            const groups = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
            const g = ycVpc.matchByIdOrName(groups, ref) || (groups.length === 1 && !ref ? groups[0] : null);
            if (!g) {
              return "Не нашёл группу «" + (ref || "") + "»." + (ref ? "" : " Групп несколько — укажи group.") + "\nВ каталоге: " + (groups.map((x) => x.name + " (" + x.id + ")").join(", ") || "групп нет");
            }
            await ycVpc.deleteSecurityGroup(cfg.oauth, g.id);
            const left = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
            return "🗑 Группа безопасности удалена: " + g.name + " (" + g.id + ")" +
              "\nОсталось групп: " + left.length + (left.length ? " — " + left.map((x) => x.name).join(", ") : "") +
              "\n\nЧто удалилось вместе с ней: её правила. Ресурсы, которые были к ней привязаны (сетевые интерфейсы машин), остались — проверь их доступность в интернет.";
          }

          if (action === "addrule" || action === "delrule") {
            const ref = args.group || args.sg || args.sgId || args.id;
            const groups = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
            const g = ycVpc.matchByIdOrName(groups, ref) || (groups.length === 1 && !ref ? groups[0] : null);
            if (!g) {
              return "Не нашёл группу «" + (ref || "") + "»." + (ref ? "" : " Групп несколько — укажи group.") + "\nВ каталоге: " + (groups.map((x) => x.name + " (" + x.id + ")").join(", ") || "групп нет — создать: ycVpc { action: \"addgroup\", name: \"app-sg\", network: \"<имя сети>\" }");
            }
            const rule = {
              direction: args.direction,
              protocol: args.protocol,
              port: args.port != null ? args.port : args.ports,
              cidr: args.cidr || args.source,
              sg: args.sourceGroup || args.fromGroup,
              target: args.target,
              description: args.description,
            };
            const r = await ycVpc.updateSecurityGroupRules(
              cfg.oauth,
              action === "addrule" ? { sgId: g.id, add: rule } : { sgId: g.id, remove: rule }
            );
            const human = (action === "addrule" ? r.added : r.removed).map((x) => ycVpc.ruleHuman(x));
            const head = r.changed
              ? (action === "addrule" ? "✅ Правило добавлено: " : "🗑 Правило удалено: ")
              : "Такое правило уже есть — ничего не менял: ";
            const ruled = r.changed ? human.join(", ") : (r.skipped || []).map((x) => ycVpc.ruleHuman(x)).join(", ");
            const now = (r.rules || []).map((x) => "  – " + ycVpc.ruleHuman(x));
            return head + ruled + "\nГруппа «" + (r.group.name || g.name) + "» теперь:\n" + (now.length ? now.join("\n") : "  – правил нет") +
              (action === "addrule" && String(args.cidr || args.source || "") === "0.0.0.0/0"
                ? "\n\n⚠ Правило открыто ВСЕМУ интернету (0.0.0.0/0). Скажи пользователю прямо: доступ к этому порту получит любой. Для SSH правильнее адрес пользователя с маской /32."
                : "");
          }

          if (action === "addresses") {
            const addrs = await ycVpc.addresses(cfg.oauth, cfg.folderId);
            if (!addrs.length) {
              return "Статических адресов в каталоге " + where + " нет. Закрепить: ycVpc { action: \"reserve\", name: \"web-ip\", zone: \"ru-central1-a\" } — адрес платный, пока он не привязан к машине, облако берёт за него плату.";
            }
            const rows = addrs.map(
              (a) =>
                "• " + a.address + " · " + a.name + " (" + a.id + ") · зона " + (a.zoneId || "—") +
                (a.used ? " · привязан" : " · ПРОСТАИВАЕТ") + (a.deletionProtection ? " · защита от удаления" : "")
            );
            const idle = addrs.filter((a) => !a.used);
            return "Статические адреса в каталоге " + where + " (" + addrs.length + "):\n" + rows.join("\n") +
              (idle.length
                ? "\n\n⚠ Простаивают (" + idle.length + ") и всё равно тарифицируются: " + idle.map((a) => a.address + " " + a.name).join(", ") + ". Освободить ненужные: ycVpc { action: \"release\", address: \"имя или id\" } — освобождённый адрес вернётся в облако, и вернуть именно его уже не получится."
                : "\n\nВсе закреплённые адреса привязаны к ресурсам.");
          }

          if (action === "reserve") {
            const made = await ycVpc.reserveAddress(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              zoneId: args.zone || args.zoneId,
              address: args.address,
              description: args.description,
              deletionProtection: args.protection === true || args.deletionProtection === true,
            });
            let price = "";
            try {
              const est = ycCosts.estimate("vpcAddress", {});
              if (est) price = ycCosts.formatLines(est).join(" ");
            } catch (e) {
              price = "";
            }
            return "✅ Статический адрес закреплён: " + (made.address || "(адрес появится через несколько секунд)") + "\nИмя: " + made.name + " (" + made.id + ") · зона " + (made.zoneId || "—") +
              (price ? "\n\nСтоимость: " + price : "") +
              "\n\nПока адрес не привязан к работающей машине, облако тарифицирует его как простаивающий — не оставляй его «про запас». Привязать: при создании виртуальной машины укажи этот адрес; посмотреть состояние: ycVpc { action: \"addresses\" }.";
          }

          if (action === "release") {
            const ref = args.address || args.name || args.id;
            const addrs = await ycVpc.addresses(cfg.oauth, cfg.folderId);
            const a = ycVpc.matchByIdOrName(addrs, ref) || (addrs.length === 1 && !ref ? addrs[0] : null);
            if (!a) {
              return "Не нашёл адрес «" + (ref || "") + "»." + (ref ? "" : " Адресов несколько — укажи address.") + "\nВ каталоге: " + (addrs.map((x) => x.address + " " + x.name).join(", ") || "адресов нет");
            }
            if (a.used) {
              return "⛔ Адрес " + a.address + " привязан к работающему ресурсу. Сначала отвяжи его (удали или останови машину с этим адресом), иначе освобождение уберёт IP из-под живой машины. Если это точно нужно — сделай это в консоли облака, где видно, от чего отваливается адрес.";
            }
            await ycVpc.releaseAddress(cfg.oauth, a.id);
            const left = await ycVpc.addresses(cfg.oauth, cfg.folderId);
            return "🗑 Адрес освобождён: " + a.address + " (" + a.name + "). Плата за него больше не начисляется.\nОсталось адресов: " + left.length +
              "\n\nВАЖНО: этот IP ушёл в облако — вернуть именно его нельзя. Всё, что на него указывало (DNS, белые списки), станет нерабочим.";
          }

          return "Ошибка: действие " + action + " не обработано.";
        } catch (e) {
          return "Yandex Cloud (ycVpc, action=" + action + "): " + ((e && e.message) || String(e));
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

    // ── Виртуальные машины: жизнь машины целиком ────────────────────────────
    // Машина — это «компьютер в дата-центре», и до сих пор агент не мог ни
    // поднять, ни посмотреть, ни остановить её: облако было набором полок, а
    // сервер человек поднимал руками в чужой консоли. Здесь весь цикл: список и
    // карточка, создание с ценой и согласием, питание, удаление вместе с
    // дисками, снимки, serial-консоль (единственный «экран» машины) и метрики
    // (машина работает или просто числится).
    //
    // Тел запросов здесь нет — вся работа с API живёт в src/yc-compute.js.
    //
    // Ключа SSH тут НЕТ намеренно. Пара ключей стоит денег в виде доступа:
    // у кого личный ключ, у того и машина. Вернуть личный ключ в ответ
    // инструмента — значит положить его в историю переписки и в журнал прогона.
    // Поэтому ключ делает человек в панели (там он сразу ложится в секреты), а
    // агент только принимает готовую публичную строку при создании машины.
    "ycCompute": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const action = String(args.action || "list").trim().toLowerCase();
        const ACTIONS = [
          "list", "card", "presets", "create", "delete", "start", "stop", "restart",
          "serial", "metrics", "disks", "snapshot", "delsnapshot", "cleansnapshots", "restoredisk", "leftovers",
        ];
        if (ACTIONS.indexOf(action) < 0) {
          return "Ошибка: неизвестное действие ycCompute «" + action + "». Доступно: " + ACTIONS.join(", ") + ".";
        }
        const needsCreate = ["create", "snapshot", "restoredisk"].indexOf(action) >= 0;
        const needsUpdate = ["start", "stop", "restart"].indexOf(action) >= 0;
        const needsDelete = ["delete", "delsnapshot"].indexOf(action) >= 0 || (action === "cleansnapshots" && args.dryRun === false);
        if (needsCreate && !cfg.allowCreate) {
          return "⛔ Создавать машины агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть, что уже есть, можно и сейчас: ycCompute { action: \"list\" }.";
        }
        if (needsUpdate && !cfg.allowUpdate) {
          return "⛔ Запускать и останавливать машины агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры и правила сети». Посмотреть машины можно и сейчас: ycCompute { action: \"list\" }.";
        }
        if (needsDelete && !cfg.allowDelete) {
          return "⛔ Удалять машины и снимки агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть, что есть, можно и сейчас: ycCompute { action: \"list\" }.";
        }
        try {
          const where = "«" + (cfg.folderName || cfg.folderId) + "»";
          const ref = String(args.instance || args.name || args.id || args.instanceId || "").trim();

          if (action === "presets") {
            const rows = [];
            for (const key of ycCompute.PRESET_KEYS) {
              const p = ycCompute.PRESETS[key];
              const est = ycCosts.estimate("compute", { cores: p.cores, coreFraction: p.coreFraction, memoryGb: p.memoryGb, diskSizeGb: p.diskSizeGb, diskTypeId: p.diskTypeId });
              rows.push(
                "• " + key + " — " + p.title + ": " + p.cores + " × " + p.coreFraction + "%, " + p.memoryGb + " ГБ памяти, диск " +
                  p.diskSizeGb + " ГБ (" + p.diskTypeId + ") · круглосуточно ≈ " + ycCosts.money(est.approxMonth) + " в месяц. " + p.note
              );
            }
            return "Наборы конфигурации машины (" + where + "):\n" + rows.join("\n") +
              "\n\nСоздать: ycCompute { action: \"create\", name: \"web-1\", preset: \"small\", subnet: \"<имя подсети>\", publicIp: true, sshPublicKey: \"<публичный ключ>\", confirm: true }." +
              "\nВажно: у машины нет экрана и нет пароля. Если не передать sshPublicKey, войти в неё будет нельзя — ключ делает человек в панели.";
          }

          if (action === "list") {
            const instances = await ycCompute.instances(cfg.oauth, cfg.folderId);
            const disks = await ycCompute.disks(cfg.oauth, cfg.folderId);
            const snapshots = await ycCompute.snapshots(cfg.oauth, cfg.folderId);
            const subnets = ycVpc ? await ycVpc.subnets(cfg.oauth, cfg.folderId).catch(() => []) : [];
            const addresses = ycVpc ? await ycVpc.addresses(cfg.oauth, cfg.folderId).catch(() => []) : [];
            const leftovers = ycCompute.paidLeftovers({ instances, disks, snapshots, addresses });
            if (!instances.length) {
              const canVm = subnets.length ? " Создать: ycCompute { action: \"create\", name: \"web-1\", preset: \"small\", subnet: \"" + subnets[0].name + "\", publicIp: true, confirm: true }." : " Но сначала нужна подсеть — без неё машина не встанет: ycVpc { action: \"addsubnet\", name: \"app-subnet-a\", network: \"<имя сети>\", zone: \"ru-central1-a\", cidr: \"10.10.0.0/24\" }.";
              return "Машин в каталоге " + where + " нет." + canVm +
                (leftovers.total ? "\n\n⚠ Платные хвосты: " + leftovers.lines.join("; ") + "." : "");
            }
            const rows = instances.map((i) => {
              const st = i.running ? "▶ " : i.busy ? "… " : "⏸ ";
              return (
                st + i.name + " — " + i.statusHuman + " · " + i.zoneId + " · " + i.cores + " × " + (i.coreFraction || 100) + "% / " + i.memoryHuman +
                " · " + (i.externalIp || "без внешнего адреса") + (i.preemptible ? " · прерываемая" : "") + " · id " + i.id
              );
            });
            const lines = ["Машины в каталоге " + where + " (" + instances.length + "):", rows.join("\n")];
            const stopped = instances.filter((i) => !i.running && !i.busy);
            if (stopped.length) {
              lines.push("");
              lines.push("⏸ Остановлены (" + stopped.length + "): " + stopped.map((i) => i.name).join(", ") + " — сама машина за это не платит, но её диски платят. Запустить: ycCompute { action: \"start\", instance: \"имя\" }.");
            }
            const busy = instances.filter((i) => i.busy);
            if (busy.length) lines.push("… В работе прямо сейчас: " + busy.map((i) => i.name + " (" + i.statusHuman + ")").join(", ") + " — подожди.");
            if (leftovers.total) {
              lines.push("");
              lines.push("⚠ Платные хвосты: " + leftovers.lines.join("; ") + ". Это то, за что платят, хотя уже никому не нужно: диски без машины, снимки удалённых дисков, простаивающие адреса.");
            }
            lines.push("");
            lines.push("Подробнее: ycCompute { action: \"card\", instance: \"имя\" }. Цены конфигураций: ycCompute { action: \"presets\" }. Наборы: " + ycCompute.PRESET_KEYS.join(", ") + ".");
            return lines.join("\n");
          }

          if (action === "card") {
            if (!ref) return "Ошибка: укажи instance — имя или id машины (список: ycCompute { action: \"list\" }).";
            const inst = await ycCompute.findInstance(cfg.oauth, cfg.folderId, ref);
            if (!inst) return "Не нашёл машину «" + ref + "». Список: ycCompute { action: \"list\" }.";
            const disks = await ycCompute.disks(cfg.oauth, cfg.folderId);
            const snapshots = await ycCompute.snapshots(cfg.oauth, cfg.folderId);
            const subnets = ycVpc ? await ycVpc.subnets(cfg.oauth, cfg.folderId).catch(() => []) : [];
            const groups = ycVpc ? await ycVpc.securityGroups(cfg.oauth, cfg.folderId).catch(() => []) : [];
            const boot = disks.find((d) => d.id === inst.bootDisk.diskId) || null;
            const est = ycCosts.estimate("compute", {
              cores: inst.cores,
              coreFraction: inst.coreFraction,
              memoryGb: Math.round(inst.memory / (1024 * 1024 * 1024)),
              diskSizeGb: boot ? Math.round(boot.size / (1024 * 1024 * 1024)) : 20,
              diskTypeId: boot ? boot.typeId : "network-ssd",
              publicIp: inst.hasExternalIp,
            });
            return ycCompute.cardLines(inst, { disks, snapshots, subnets, securityGroups: groups }).join("\n") +
              "\n\n" + ycCosts.formatText(est) +
              "\n\nЧто можно сделать сейчас: " +
              (inst.running ? "ycCompute { action: \"stop\", instance: \"" + inst.name + "\" } — остановить (за выключенное время не платят)" : "ycCompute { action: \"start\", instance: \"" + inst.name + "\" } — запустить") +
              ", ycCompute { action: \"serial\", instance: \"" + inst.name + "\" } — посмотреть, что происходит внутри, ycCompute { action: \"metrics\", instance: \"" + inst.name + "\" } — нагрузка.";
          }

          if (action === "disks") {
            const disks = await ycCompute.disks(cfg.oauth, cfg.folderId);
            if (!disks.length) return "Дисков в каталоге " + where + " нет.";
            const rows = disks.map((d) => {
              // d.size — БАЙТЫ (так его отдаёт API), а тариф считается за ГИГАБАЙТ.
              const month = ycCosts.diskMonth(d.size / 1073741824, d.typeId);
              return (
                "• " + d.name + " — " + d.sizeHuman + " · " + d.typeId + " · " + d.zoneId + " · ≈ " + ycCosts.money(month) + " в месяц · " +
                (d.attached ? "занят машиной" : "⚠ НИ К ЧЕМУ НЕ ПРИВЯЗАН — платите, а пользы нет") +
                " · id " + d.id
              );
            });
            const orphan = disks.filter((d) => !d.attached);
            return "Диски в каталоге " + where + " (" + disks.length + "):\n" + rows.join("\n") +
              (orphan.length ? "\n\n⚠ Дисков без машины: " + orphan.length + " (" + orphan.map((d) => d.name + " " + d.sizeHuman).join(", ") + "). Сделай снимок, если данные нужны, и удали — иначе платишь каждый час." : "") +
              "\n\nСнимок диска: ycCompute { action: \"snapshot\", disk: \"имя\", confirm: true }.";
          }

          if (action === "leftovers") {
            const instances = await ycCompute.instances(cfg.oauth, cfg.folderId);
            const disks = await ycCompute.disks(cfg.oauth, cfg.folderId);
            const snapshots = await ycCompute.snapshots(cfg.oauth, cfg.folderId);
            const addresses = ycVpc ? await ycVpc.addresses(cfg.oauth, cfg.folderId).catch(() => []) : [];
            const l = ycCompute.paidLeftovers({ instances, disks, snapshots, addresses });
            if (!l.total) {
              return "Платных хвостов в каталоге " + where + " нет: каждый диск привязан к машине, снимков удалённых дисков нет, простаивающих статических адресов нет.";
            }
            const rows = [];
            for (const d of l.disks) rows.push("• диск без машины: " + d.name + " " + d.sizeHuman + " (" + d.typeId + ") — ≈ " + ycCosts.money(ycCosts.diskMonth(d.size / 1073741824, d.typeId)) + " в месяц");
            for (const s of l.snapshots) rows.push("• снимок удалённого диска: " + s.name + " " + s.storageHuman + " (возраст " + (s.ageDays != null ? s.ageDays + " дн." : "неизвестен") + ")");
            for (const a of l.addresses) rows.push("• простаивающий статический адрес: " + (a.address || a.name) + " — облако берёт за него плату как за занятый");
            return "Платные хвосты в каталоге " + where + " (" + l.total + "):\n" + rows.join("\n") +
              "\n\nЭто деньги за то, что уже не используется. Прежде чем удалять — предложи пользователю снимок (" +
              "ycCompute { action: \"snapshot\", disk: \"имя\", confirm: true }), потому что удаление диска необратимо. " +
              "Освободить адрес: ycVpc { action: \"release\", address: \"имя\" }. Старые снимки: ycCompute { action: \"cleansnapshots\", keep: 2 } (сначала покажет, что удалит).";
          }

          if (action === "create") {
            const est = ycCosts.estimate("compute", {
              cores: args.cores,
              coreFraction: args.coreFraction,
              memoryGb: args.memoryGb,
              diskSizeGb: args.diskSizeGb,
              diskTypeId: args.diskType || args.diskTypeId,
              publicIp: args.publicIp === true || !!args.staticAddress,
            });
            if (args.confirm !== true) {
              return "Машина платная — она тарифицируется за каждый час работы.\n\n" + ycCosts.formatText(est) +
                "\n\nНазови пользователю ориентир цены и получи согласие (askUser), затем повтори вызов с confirm: true." +
                "\nЕсли он не сказал конфигурацию — предложи готовый набор: ycCompute { action: \"presets\" }.";
            }
            const r = await ycCompute.createInstance(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              preset: args.preset,
              zone: args.zone || args.zoneId,
              platform: args.platform,
              cores: args.cores,
              memoryGb: args.memoryGb,
              coreFraction: args.coreFraction,
              imageFamily: args.imageFamily || args.image,
              imageId: args.imageId,
              diskType: args.diskType || args.diskTypeId,
              diskSizeGb: args.diskSizeGb,
              subnet: args.subnet,
              subnetId: args.subnetId,
              securityGroupIds: args.securityGroupIds || args.securityGroups,
              sshPublicKey: args.sshPublicKey,
              sshUser: args.sshUser,
              publicIp: args.publicIp === true || !!args.staticAddress,
              staticAddress: args.staticAddress,
              preemptible: args.preemptible,
              dataDiskSizeGb: args.dataDiskSizeGb,
              description: args.description,
            });
            const real = ycCosts.estimate("compute", {
              cores: r.cores,
              coreFraction: r.coreFraction,
              memoryGb: Math.round(r.memoryBytes / (1024 * 1024 * 1024)),
              diskSizeGb: Math.round(r.diskSizeBytes / (1024 * 1024 * 1024)),
              diskTypeId: r.diskTypeId,
              publicIp: r.publicIp,
            });
            const i = r.instance;
            const lines = [
              "✅ Машина создана: " + i.name + " (" + i.id + ")",
              "  " + r.cores + " × " + r.coreFraction + "% vCPU · " + Math.round(r.memoryBytes / (1024 * 1024 * 1024)) + " ГБ памяти · диск " +
                Math.round(r.diskSizeBytes / (1024 * 1024 * 1024)) + " ГБ (" + r.diskTypeId + ") · зона " + i.zoneId,
              "  подсеть: " + r.subnet.name + " (" + r.subnet.zoneId + ")",
              "  адреса: " + (i.externalIp ? i.externalIp + " снаружи, " : "") + (i.internalIp || "внутренний появится через несколько секунд"),
              "  состояние: " + i.statusHuman + " — машине нужно время на загрузку, это нормально",
              "",
              ycCosts.formatText(real),
            ];
            if (r.warnings.length) {
              lines.push("");
              for (const w of r.warnings) lines.push("⚠ " + w);
            }
            lines.push("");
            lines.push("Дальше: загрузка занимает минуту-другую. Что происходит внутри, видно в serial-консоли: ycCompute { action: \"serial\", instance: \"" + i.name + "\" }. Нагрузка: ycCompute { action: \"metrics\", instance: \"" + i.name + "\" }.");
            return lines.join("\n");
          }

          if (action === "start" || action === "stop" || action === "restart") {
            if (!ref) return "Ошибка: укажи instance — имя или id машины (список: ycCompute { action: \"list\" }).";
            const inst = await ycCompute.findInstance(cfg.oauth, cfg.folderId, ref);
            if (!inst) return "Не нашёл машину «" + ref + "». Список: ycCompute { action: \"list\" }.";
            const r = await ycCompute.power(cfg.oauth, action, inst, { folderId: cfg.folderId });
            const lines = [r.message];
            if (r.warnings && r.warnings.length) {
              lines.push("");
              for (const w of r.warnings) lines.push("⚠ " + w);
            }
            if (action === "start" && inst.externalIp) {
              lines.push("");
              lines.push("Появился адрес: " + (r.instance.externalIp || inst.externalIp) + " — если он изменился, обнови DNS и белые списки.");
            }
            return lines.join("\n");
          }

          if (action === "serial") {
            if (!ref) return "Ошибка: укажи instance — имя или id машины.";
            const r = await ycCompute.serialOutput(cfg.oauth, { folderId: cfg.folderId, instance: ref, lines: args.lines });
            if (r.empty) return r.message;
            return "Serial-консоль машины «" + r.instance.name + "» (порт " + r.port + "), последние " + r.lines.length + " строк:\n```\n" + r.lines.join("\n") + "\n```\n" +
              "\nЭто то, что машина «говорит» при загрузке и работе: здесь видно, поднялась ли служба, что мешает запуску и какие ошибки пишет ядро. Если консоль пуста — машина создана без serial-port-enable в метаданных.";
          }

          if (action === "metrics") {
            if (!ref) return "Ошибка: укажи instance — имя или id машины.";
            const r = await ycCompute.metrics(cfg.oauth, { folderId: cfg.folderId, instance: ref, minutes: args.minutes });
            const rows = [];
            for (const m of r.metrics) {
              const s = m.summary;
              rows.push("• " + m.title + ": " + (s.count ? "в среднем " + m.format(s.avg) + ", максимум " + m.format(s.max) : "данных нет"));
            }
            return "Нагрузка машины «" + r.instance.name + "» за " + r.minutes + " мин:\n" + rows.join("\n") +
              (r.errors.length ? "\n(не удалось получить: " + r.errors.map((e) => e.name).join(", ") + ")" : "") +
              "\n\n" + r.lines.join("\n");
          }

          if (action === "snapshot") {
            if (args.confirm !== true) {
              const gb = Number(args.sizeGb) > 0 ? Number(args.sizeGb) : 20;
              const est = ycCosts.estimate("computeSnapshot", { gb });
              return "Снимок диска хранится и тарифицируется, пока его не удалят.\n\n" + ycCosts.formatText(est) +
                "\n\nПолучи согласие пользователя и повтори с confirm: true. Снимок — единственная защита от «удалил и потерял»: предложи его ДО удаления машины.";
            }
            const r = await ycCompute.createSnapshot(cfg.oauth, {
              folderId: cfg.folderId,
              disk: args.disk,
              diskId: args.diskId,
              instance: args.instance,
              name: args.snapshotName || args.snapshot,
              description: args.description,
            });
            return "✅ Снимок «" + r.snapshot.name + "» создан (" + r.snapshot.storageHuman + ", диск " + r.disk.name + ").\nid: " + r.snapshot.id +
              "\n\nВосстановить из него диск: ycCompute { action: \"restoredisk\", snapshot: \"" + r.snapshot.name + "\", zone: \"" + r.disk.zoneId + "\", confirm: true }." +
              (r.warnings.length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          if (action === "delsnapshot") {
            const snapRef = String(args.snapshot || args.snapshotId || args.name || "").trim();
            if (!snapRef) return "Ошибка: укажи snapshot — имя или id снимка. Список снимков видно в ycCompute { action: \"cleansnapshots\" } (он покажет и то, что уже можно удалить).";
            const r = await ycCompute.deleteSnapshot(cfg.oauth, { folderId: cfg.folderId, snapshot: snapRef });
            return "🗑 " + r.message + "\nЭто необратимо: из удалённого снимка диск уже не восстановить.";
          }

          if (action === "cleansnapshots") {
            const r = await ycCompute.cleanSnapshots(cfg.oauth, {
              folderId: cfg.folderId,
              disk: args.disk,
              keep: args.keep,
              olderThanDays: args.olderThanDays,
              dryRun: args.dryRun !== false,
            });
            const lines = [r.message];
            if (r.kept.length) lines.push("\nОстаются:\n" + r.kept.map((s) => "• " + s.name + " (" + (s.ageDays != null ? s.ageDays + " дн." : "возраст неизвестен") + ")").join("\n"));
            if (r.doomed.length) lines.push("\n" + (r.dryRun ? "К удалению" : "Удалены") + ":\n" + r.doomed.map((s) => "• " + s.name + " — " + s.storageHuman + " (" + (s.ageDays != null ? s.ageDays + " дн." : "возраст неизвестен") + ")").join("\n"));
            if (r.failed.length) lines.push("\nНе удалось: " + r.failed.map((f) => f.snapshot.name + " — " + f.error).join("; "));
            if (r.dryRun && r.doomed.length) {
              lines.push("\nНичего не удалено: сначала показываем. Назови пользователю объём и получи согласие, затем повтори с dryRun: false.");
            }
            return lines.join("\n");
          }

          if (action === "restoredisk") {
            const snapRef = String(args.snapshot || args.snapshotId || "").trim();
            if (!snapRef) return "Ошибка: укажи snapshot — имя или id снимка.";
            if (args.confirm !== true) {
              return "Восстановление создаёт НОВЫЙ диск — он тарифицируется отдельно, а машины у него нет.\nПолучи согласие пользователя и повтори с confirm: true.";
            }
            const r = await ycCompute.restoreDisk(cfg.oauth, {
              folderId: cfg.folderId,
              snapshot: snapRef,
              name: args.diskName || args.name,
              zone: args.zone || args.zoneId,
              diskType: args.diskType,
              sizeGb: args.sizeGb,
            });
            return "✅ " + r.message + "\nid диска: " + r.disk.id +
              "\n\nПоднять машину с этих данных: ycCompute { action: \"create\", name: \"…\", bootDiskId: \"" + r.disk.id + "\", confirm: true }." +
              (r.warnings.length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          return "Ошибка: действие " + action + " не обработано.";
        } catch (e) {
          return "Yandex Cloud (ycCompute, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },

    // IAM: сервисные аккаунты, роли и ключи. Раньше приложение умело только
    // «завести аккаунт под выкатку» внутри деплоя — посмотреть, какие аккаунты
    // есть, что им выдано и чем они входят, было нечем. Тела запросов живут в
    // src/yc-iam.js: здесь выбор действия, права и человеческий ответ.
    "ycIam": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!ycIam) return "Ошибка: модуль IAM (src/yc-iam.js) не подключён в этой сборке.";
        const action = String(args.action || "list").trim().toLowerCase();
        const ACTIONS = ["list", "card", "keys", "rolemap", "suggest", "roles", "create", "update", "delete", "grant", "revoke", "newkey", "delkey"];
        if (ACTIONS.indexOf(action) < 0) {
          return "Ошибка: неизвестное действие ycIam «" + action + "». Доступно: " + ACTIONS.join(", ") + ".";
        }
        // «Какие роли бывают» и «чего хватит для задачи» — это знание приложения,
        // а не облака: отвечаем ДО проверок подключения, иначе агент не подскажет
        // роль раньше, чем пользователь вставит токен.
        if (action === "rolemap") {
          const rows = ycIam.ROLE_CATALOG.map((r) => "• " + r.id + " — " + r.title + (r.note ? " (" + r.note + ")" : ""));
          return "Роли Yandex Cloud, которые чаще всего нужны:\n" + rows.join("\n") +
            "\n\nШирокие роли (действуют на ВЕСЬ каталог): " + ycIam.PRIMITIVE_ROLES.join(", ") + ". Не выдавай их «на всякий случай» — узкая роль делает ровно то, что нужно." +
            "\nКаких ролей хватает для задачи: ycIam { action: \"suggest\" }. Полный живой список ролей облака: ycIam { action: \"roles\", filter: \"storage\" }.";
        }
        if (action === "suggest") {
          const task = String(args.task || "").trim();
          if (!task) {
            return "Для какой задачи подобрать роли? Доступные: " + ycIam.TASK_KEYS.join(", ") + ".\nПример: ycIam { action: \"suggest\", task: \"site\" }.";
          }
          const m = ycIam.minimalRoles(task);
          if (!m) return "Не знаю такой задачи «" + task + "». Доступные: " + ycIam.TASK_KEYS.join(", ") + ".";
          return "Для задачи «" + m.title + "» хватает ролей: " + m.roles.join(", ") + "." + (m.note ? "\n" + m.note : "") +
            "\nВыдать: ycIam { action: \"grant\", account: \"<имя сервисного аккаунта>\", role: \"" + m.roles[0] + "\" }." +
            "\nЕсли аккаунта ещё нет: ycIam { action: \"create\", name: \"sa-site\", description: \"зачем он нужен\" }.";
        }
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const account = String(args.account || args.serviceAccount || args.name || args.id || "").trim();
        const needsCreate = ["create", "newkey"].indexOf(action) >= 0;
        const needsUpdate = ["update", "grant", "revoke"].indexOf(action) >= 0;
        const needsDelete = ["delete", "delkey"].indexOf(action) >= 0;
        if (needsCreate && !cfg.allowCreate) {
          return "⛔ Заводить сервисные аккаунты и ключи агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть, что уже есть, можно и сейчас: ycIam { action: \"list\" }.";
        }
        if (needsUpdate && !cfg.allowUpdate) {
          return "⛔ Менять роли и настройки аккаунтов агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры и правила сети» — он же разрешает правку прав. Посмотреть роли можно и сейчас: ycIam { action: \"list\" }.";
        }
        if (needsDelete && !cfg.allowDelete) {
          return "⛔ Удалять сервисные аккаунты и ключи агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть, что есть, можно и сейчас: ycIam { action: \"list\" }.";
        }
        try {
          const where = "«" + (cfg.folderName || cfg.folderId) + "»";

          if (action === "list") {
            const ov = await ycIam.overview(cfg.oauth, cfg.folderId);
            const lines = ["Сервисные аккаунты в каталоге " + where + " (" + ov.accounts.length + ")"];
            lines.push(...ov.lines);
            lines.push("");
            lines.push("Подробнее про один аккаунт: ycIam { action: \"card\", account: \"имя\" }. Его ключи: ycIam { action: \"keys\", account: \"имя\" }.");
            lines.push("Завести новый: ycIam { action: \"create\", name: \"sa-site\", description: \"зачем нужен\" }, потом УЗКУЮ роль: ycIam { action: \"grant\", account: \"sa-site\", role: \"storage.editor\" }.");
            lines.push("Ключ нужен только тому, кто работает ВНЕ облака (скрипт, выкатка, машина): ycIam { action: \"newkey\", account: \"sa-site\", kind: \"access\", confirm: true }.");
            return lines.join("\n");
          }

          if (action === "card") {
            if (!account) return "Ошибка: укажи account — имя или id сервисного аккаунта. Список: ycIam { action: \"list\" }.";
            const acc = await ycIam.findServiceAccount(cfg.oauth, cfg.folderId, account);
            if (!acc) return "Не нашёл сервисный аккаунт «" + account + "» в каталоге " + where + ". Список: ycIam { action: \"list\" }.";
            const keys = await ycIam.allKeys(cfg.oauth, acc.id).catch(() => null);
            const roles = await ycIam.bindingsFor(cfg.oauth, cfg.folderId, acc.id).catch(() => []);
            return ycIam.cardLines(acc, { keys, roles, keysError: keys ? "" : "список ключей прочитать не удалось (проверь права на iam.serviceAccounts.get)" }).join("\n");
          }

          if (action === "keys") {
            if (!account) return "Ошибка: укажи account — имя или id сервисного аккаунта (список: ycIam { action: \"list\" }).";
            const acc = await ycIam.resolveAccount(cfg.oauth, cfg.folderId, account);
            const k = await ycIam.allKeys(cfg.oauth, acc.id);
            if (!k.total) {
              return "У аккаунта «" + acc.name + "» ключей нет: снаружи облака под ним войти нельзя, а всё, что ходит под ним, обязано работать внутри облака." +
                "\nНужен ключ? ycIam { action: \"newkey\", account: \"" + acc.name + "\", kind: \"access\", confirm: true } — ключ доступа (объектное хранилище, скрипты, бэкапы), kind: \"api\" — API-ключ (вызов API сервисов), kind: \"authorized\" — ключ подписи (SSH к машине).";
            }
            const rows = k.keys.map((x) => {
              const kind = x.kind === "access" ? "доступ" : x.kind === "api" ? "API" : "подпись";
              return "• " + kind + ": " + (x.description || x.keyId || x.id) + " · " + x.usedHuman + " · id " + x.id + (x.expiresAt ? " · истекает " + x.expiresAt : "");
            });
            return "Ключи аккаунта «" + acc.name + "» (" + k.total + "):\n" + rows.join("\n") +
              (k.troubles.length ? "\n\n⚠ " + k.troubles.join("\n⚠ ") : "") +
              (k.errors.length ? "\n\nЧасть ключей не прочиталась: " + k.errors.join("; ") : "") +
              "\n\nСекрета здесь нет и не будет: облако показывает его ТОЛЬКО в момент создания. Лишний ключ удаляется: ycIam { action: \"delkey\", kind: \"access|api|authorized\", keyId: \"id из списка\", account: \"" + acc.name + "\" }.";
          }

          if (action === "roles") {
            const filter = String(args.filter || "").trim();
            const list = await ycIam.roles(cfg.oauth, filter);
            const known = list.filter((r) => r.known);
            const rows = list.slice(0, 60).map((r) => "• " + r.id + (r.known && r.kind ? " [" + r.kind + "]" : "") + (r.description ? " — " + r.description : ""));
            return "Роли облака" + (filter ? " по фильтру «" + filter + "»" : "") + " (" + list.length + "):\n" + rows.join("\n") +
              (list.length > 60 ? "\n…и ещё " + (list.length - 60) + " — уточни filter." : "") +
              "\n\nЧеловеческие пояснения к частым ролям: ycIam { action: \"rolemap\" }. Известных приложению ролей в этом списке: " + known.length + ".";
          }

          if (action === "create") {
            const r = await ycIam.createServiceAccount(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              description: args.description,
              labels: args.labels,
              expiresAt: args.expiresAt,
            });
            return "✅ " + r.message + "\n\n⚠ " + (r.warnings || []).join("\n⚠ ") +
              "\n\nДальше: ycIam { action: \"grant\", account: \"" + r.account.name + "\", role: \"<узкая роль>\" } — какие роли нужны для задачи, подскажет ycIam { action: \"suggest\", task: \"site\" }.";
          }

          if (action === "update") {
            const r = await ycIam.updateServiceAccount(cfg.oauth, {
              folderId: cfg.folderId,
              account,
              newName: args.newName,
              description: args.description,
            });
            return (r.changed ? "✅ " : "") + r.message;
          }

          if (action === "delete") {
            if (!account) return "Ошибка: укажи account — имя или id сервисного аккаунта, который надо удалить (список: ycIam { action: \"list\" }).";
            const r = await ycIam.deleteServiceAccount(cfg.oauth, { folderId: cfg.folderId, account });
            return "🗑 " + r.message + ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "") +
              "\n\nЭто необратимо: вернуть аккаунт нельзя, можно только завести новый и выдать ему роль заново.";
          }

          if (action === "grant") {
            const r = await ycIam.grantRole(cfg.oauth, { folderId: cfg.folderId, account, role: args.role });
            return (r.changed ? "✅ " : "") + r.message +
              "\nРоли аккаунта «" + r.account.name + "»: " + (r.roles.join(", ") || "нет") +
              ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          if (action === "revoke") {
            const r = await ycIam.revokeRole(cfg.oauth, { folderId: cfg.folderId, account, role: args.role });
            return (r.changed ? "✅ " : "") + r.message +
              "\nОстались роли: " + (r.roles.join(", ") || "НЕТ — аккаунт больше ничего не может") +
              ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          if (action === "newkey") {
            if (!account) return "Ошибка: укажи account — имя или id сервисного аккаунта, для которого создаётся ключ.";
            const kind = String(args.kind || args.type || "access").trim().toLowerCase();
            const kindHuman = kind === "api" ? "API-ключ (вызов API сервисов: API Gateway, функции)" : kind === "authorized" || kind === "key" ? "ключ подписи (вход по SSH к машине)" : "ключ доступа (объектное хранилище, скрипты, бэкапы)";
            if (args.confirm !== true) {
              return "Ключ — это ДОСТУП: облако отдаст секрет РОВНО ОДИН раз, обратно его не покажут ни в списке, ни здесь.\nЧто будет создано: " + kindHuman + " для аккаунта «" + account + "»." +
                "\nПолучи согласие пользователя и повтори с confirm: true. Место секрета — хранилище секретов (ycSecret / Lockbox), а не переписка.";
            }
            const opts = {
              folderId: cfg.folderId,
              account,
              description: args.description,
              expiresAt: args.expiresAt,
              scopes: args.scopes,
              algorithm: args.algorithm,
            };
            const r = kind === "api" ? await ycIam.createApiKey(cfg.oauth, opts) : kind === "authorized" || kind === "key" ? await ycIam.createAuthorizedKey(cfg.oauth, opts) : await ycIam.createAccessKey(cfg.oauth, opts);
            const secret = String(r.secret || r.privateKey || "");
            return "✅ " + r.message +
              "\n\nСЕКРЕТ — показывается один раз:\n" + secret +
              "\n\n⚠ " + (r.warnings || []).join("\n⚠ ") +
              "\n\nСохрани его в хранилище секретов (ycSecret) или попроси пользователя записать — в переписке и журнале прогона секрету не место. Если ключ создан «на посмотреть» — удали: ycIam { action: \"delkey\", kind: \"" + (kind === "api" ? "api" : kind === "authorized" || kind === "key" ? "authorized" : "access") + "\", keyId: \"" + (r.key.id || r.key.keyId) + "\", account: \"" + r.account.name + "\" }.";
          }

          if (action === "delkey") {
            let keyId = String(args.keyId || args.id || "").trim();
            const kind = String(args.kind || args.type || "").trim();
            if (!keyId) return "Ошибка: укажи keyId — id ключа из списка (ycIam { action: \"keys\", account: \"имя\" }).";
            // В списке рядом с id видно и keyId (тот, что похож на AWS-ключ), и
            // человек скопирует то, что видит. Если назван аккаунт — приводим
            // ссылку к id, который принимает API.
            if (account) {
              const acc = await ycIam.resolveAccount(cfg.oauth, cfg.folderId, account);
              const k = await ycIam.allKeys(cfg.oauth, acc.id);
              const found = k.keys.find((x) => x.id === keyId || x.keyId === keyId) || null;
              if (found) keyId = found.id;
            }
            const r = await ycIam.deleteKeyByKind(cfg.oauth, kind, keyId);
            return "🗑 " + r.message + "\nВсё, что ходило этим ключом, больше не войдёт в облако — если это был рабочий скрипт или выкатка, они сломаются.";
          }

          return "Ошибка: действие " + action + " не обработано.";
        } catch (e) {
          return "Yandex Cloud (ycIam, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },

    // Cloud Functions: функции, версии, теги, вызов и публичный доступ. Раньше
    // их не было видно даже в списке ресурсов, и «сделать что-то, что отвечает в
    // интернете и стоит копейки» агент не мог предложить. Тела запросов живут в
    // src/yc-functions.js: здесь выбор действия, права и человеческий ответ.
    "ycFunctions": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!ycFunctions) return "Ошибка: модуль Cloud Functions (src/yc-functions.js) не подключён в этой сборке.";
        const action = String(args.action || "list").trim().toLowerCase();
        const ACTIONS = ["list", "card", "versions", "runtimes", "create", "update", "delete", "deploy", "invoke", "tag", "untag", "delversion", "public", "private", "access"];
        if (ACTIONS.indexOf(action) < 0) {
          return "Ошибка: неизвестное действие ycFunctions «" + action + "». Доступно: " + ACTIONS.join(", ") + ".";
        }
        // Список языков — знание облака, но и без подключённого облака агент
        // должен подсказать, на чём писать функцию.
        if (action === "runtimes" && !cfg.oauth) {
          return "Частые языки выполнения Cloud Functions: " + ycFunctions.RUNTIMES_HINT.join(", ") + ".\nТочный список облака появится после подключения (Настройки → «☁️ Yandex Cloud») — тогда сработает ycFunctions { action: \"runtimes\" }.";
        }
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const ref = String(args.function || args.name || args.id || "").trim();
        const needsCreate = ["create", "deploy"].indexOf(action) >= 0;
        const needsUpdate = ["update", "tag", "untag", "public", "private"].indexOf(action) >= 0;
        const needsDelete = ["delete", "delversion"].indexOf(action) >= 0;
        if (needsCreate && !cfg.allowCreate) {
          return "⛔ Создавать функции агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть, что уже есть, можно и сейчас: ycFunctions { action: \"list\" }.";
        }
        if (needsUpdate && !cfg.allowUpdate) {
          return "⛔ Менять функции агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры и правила сети» — он же разрешает теги, публичность и переменные версий. Посмотреть можно и сейчас: ycFunctions { action: \"list\" }.";
        }
        if (needsDelete && !cfg.allowDelete) {
          return "⛔ Удалять функции и их версии агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть, что есть, можно и сейчас: ycFunctions { action: \"list\" }.";
        }
        try {
          const where = "«" + (cfg.folderName || cfg.folderId) + "»";

          if (action === "list") {
            const ov = await ycFunctions.overview(cfg.oauth, cfg.folderId);
            const lines = ["Функции Cloud Functions в каталоге " + where + " (" + ov.functions.length + ")"];
            lines.push(...ov.lines);
            lines.push("");
            lines.push("Подробнее: ycFunctions { action: \"card\", function: \"имя\" }. Версии: action: \"versions\". Вызвать: action: \"invoke\".");
            lines.push("Создать и выкатить первую версию: ycFunctions { action: \"create\", name: \"hello-func\" } → ycFunctions { action: \"deploy\", function: \"hello-func\", zipFile: \"index.zip\", runtime: \"nodejs22\", entrypoint: \"index.handler\" }.");
            lines.push("Важно: функции бесплатны, пока их не зовут (первые 1 млн вызовов и 10 ГБ×час в месяц не тарифицируются), поэтому для «редкого» и «по расписанию» это дешевле машины.");
            return lines.join("\n");
          }

          if (action === "runtimes") {
            const list = await ycFunctions.runtimes(cfg.oauth).catch(() => []);
            return "Языки выполнения Cloud Functions (" + list.length + "):\n" + list.join(", ") +
              "\n\nЧастые: " + ycFunctions.RUNTIMES_HINT.slice(0, 8).join(", ") + ". Версия языка — часть идентификатора (nodejs22, а не node22).";
          }

          if (action === "card") {
            if (!ref) return "Ошибка: укажи function — имя или id (список: ycFunctions { action: \"list\" }).";
            const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
            if (!fn) return "Не нашёл функцию «" + ref + "» в каталоге " + where + ". Список: ycFunctions { action: \"list\" }.";
            const vers = await ycFunctions.versions(cfg.oauth, fn.id).catch(() => []);
            const binds = await ycFunctions.accessBindings(cfg.oauth, fn.id).catch(() => []);
            const isPublic = ycFunctions.isPublic(binds);
            const url = await ycFunctions.invokeUrlOf(cfg.oauth, fn);
            return ycFunctions.cardLines(fn, { versions: vers, public: isPublic, url }).join("\n");
          }

          if (action === "versions") {
            if (!ref) return "Ошибка: укажи function — имя или id функции.";
            const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
            if (!fn) return "Не нашёл функцию «" + ref + "» в каталоге " + where + ".";
            const vers = await ycFunctions.versions(cfg.oauth, fn.id);
            if (!vers.length) {
              return "У функции «" + fn.name + "» нет ни одной версии: она не отвечает и вызвать её нельзя. Выкатить код: ycFunctions { action: \"deploy\", function: \"" + fn.name + "\", zipFile: \"index.zip\", runtime: \"nodejs22\", entrypoint: \"index.handler\" }.";
            }
            const active = ycFunctions.activeVersion(vers);
            const rows = vers.map((v) => {
              const t = v.tags.length ? " · теги: " + v.tags.join(", ") : "";
              return "• " + v.id.slice(0, 8) + (active && v.id === active.id ? " (отвечает по умолчанию)" : "") + " · " + v.runtime + " · " + v.memoryHuman + " · " + v.statusHuman + " · " + v.ageHuman + t + (v.envCount ? " · переменных: " + v.envCount : "");
            });
            const warns = [];
            for (const v of vers) warns.push(...ycFunctions.versionTrouble(v, vers));
            const tags = ycFunctions.stableTags(vers);
            return "Версии функции «" + fn.name + "» (" + vers.length + "):\n" + rows.join("\n") +
              "\n\nПостоянные адреса: " + (tags.length ? tags.map((x) => x.tag + " → ?tag=" + x.tag).join("; ") : "НЕТ — адрес без тега всегда ведёт на самую новую версию, значит следующая выкатка меняет то, что отвечает. Поставь тег: ycFunctions { action: \"tag\", function: \"" + fn.name + "\", tag: \"v1\" }") +
              (warns.length ? "\n\n⚠ " + warns.join("\n⚠ ") : "");
          }

          if (action === "create") {
            const r = await ycFunctions.createFunction(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name,
              description: args.description,
              labels: args.labels,
            });
            return "✅ " + r.message + "\n\n⚠ " + (r.warnings || []).join("\n⚠ ");
          }

          if (action === "update") {
            const r = await ycFunctions.updateFunction(cfg.oauth, {
              folderId: cfg.folderId,
              function: ref,
              newName: args.newName,
              description: args.description,
              labels: args.labels,
            });
            return (r.changed ? "✅ " : "") + r.message;
          }

          if (action === "deploy") {
            if (!ref) return "Ошибка: укажи function — имя функции (или создай её: ycFunctions { action: \"create\", name: \"hello-func\" }).";
            const r = await ycFunctions.createVersion(cfg.oauth, {
              folderId: cfg.folderId,
              function: ref,
              runtime: args.runtime,
              entrypoint: args.entrypoint || args.handler,
              memoryMb: args.memoryMb != null ? args.memoryMb : args.memory,
              timeoutSec: args.timeoutSec != null ? args.timeoutSec : args.timeout,
              environment: args.environment || args.env,
              tag: args.tag,
              description: args.description,
              serviceAccountId: args.serviceAccountId,
              zipFile: args.zipFile || args.file,
              contentBase64: args.contentBase64,
              sourceVersionId: args.sourceVersionId,
              package: args.package,
              networkId: args.networkId,
              concurrency: args.concurrency,
              secrets: args.secrets,
            });
            return "✅ " + r.message + "\n\n⚠ " + (r.warnings || []).join("\n⚠ ") +
              "\n\nПроверь, что отвечает: ycFunctions { action: \"invoke\", function: \"" + r.function.name + "\" }. Что внутри: ycLogs { service: \"cloudFunctions\", id: \"" + r.function.id + "\" }.";
          }

          if (action === "invoke") {
            if (!ref) return "Ошибка: укажи function — имя функции.";
            const r = await ycFunctions.invoke(cfg.oauth, {
              folderId: cfg.folderId,
              function: ref,
              tag: args.tag,
              payload: args.payload,
              timeoutMs: args.timeoutMs,
            });
            const head = (r.ok ? "✅ " : "⚠ ") + r.message + "\nАдрес: " + r.url;
            const body = r.text ? "\nОтвет" + (r.json ? " (JSON)" : "") + ":\n" + r.text + (r.truncated ? "\n…(ответ обрезан)" : "") : "\nФункция вернула пустой ответ.";
            return head + body + (r.hint ? "\n\n" + r.hint : "");
          }

          if (action === "tag" || action === "untag") {
            if (!ref) return "Ошибка: укажи function — имя функции.";
            const r = await ycFunctions.setTag(cfg.oauth, {
              folderId: cfg.folderId,
              function: ref,
              version: args.version || args.versionId,
              tag: args.tag,
              remove: action === "untag",
            });
            return (r.changed ? "✅ " : "") + r.message + (r.url && action === "tag" ? "\nАдрес: " + r.url : "") +
              ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          if (action === "delversion") {
            if (!ref) return "Ошибка: укажи function — имя функции.";
            const r = await ycFunctions.deleteVersion(cfg.oauth, { folderId: cfg.folderId, function: ref, version: args.version || args.versionId });
            return "🗑 " + r.message + ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          if (action === "delete") {
            if (!ref) return "Ошибка: укажи function — имя функции, которую надо удалить (список: ycFunctions { action: \"list\" }).";
            if (args.confirm !== true) {
              const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
              if (!fn) return "Не нашёл функцию «" + ref + "» в каталоге " + where + ".";
              const vers = await ycFunctions.versions(cfg.oauth, fn.id).catch(() => []);
              const binds = await ycFunctions.accessBindings(cfg.oauth, fn.id).catch(() => []);
              const isPublic = ycFunctions.isPublic(binds);
              return "Удаление функции «" + fn.name + "» необратимо: уйдут ВСЕ её версии (" + vers.length + ") и их теги" +
                (isPublic ? ", а публичный адрес перестанет работать у всех, кто им пользовался" : "") + ".\n" +
                "Если функция кому-то отвечает, сначала предложи пользователю перенести вызов на новую версию или на другую функцию." +
                "\nПолучи согласие и повтори с confirm: true.";
            }
            const r = await ycFunctions.deleteFunction(cfg.oauth, { folderId: cfg.folderId, function: ref });
            return "🗑 " + r.message + ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          if (action === "public" || action === "private") {
            if (!ref) return "Ошибка: укажи function — имя функции.";
            const r = await ycFunctions.setPublic(cfg.oauth, {
              folderId: cfg.folderId,
              function: ref,
              tag: args.tag,
              on: action === "public",
            });
            return (r.changed ? "✅ " : "") + r.message + ((r.warnings || []).length ? "\n\n⚠ " + r.warnings.join("\n⚠ ") : "");
          }

          if (action === "access") {
            if (!ref) return "Ошибка: укажи function — имя функции.";
            const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
            if (!fn) return "Не нашёл функцию «" + ref + "» в каталоге " + where + ".";
            const binds = await ycFunctions.accessBindings(cfg.oauth, fn.id);
            const isPublic = ycFunctions.isPublic(binds);
            const rows = binds.length
              ? binds.map((b) => "• " + b.roleId + " → " + (b.isPublic ? "все (allUsers)" : b.subjectId + " (" + b.subjectType + ")")).join("\n")
              : "прямых привязок нет: вызывать может только владелец каталога и роли из IAM";
            return "Кому разрешено вызывать функцию «" + fn.name + "»:\n" + rows +
              "\n\n" + (isPublic
                ? "Функция ПУБЛИЧНАЯ: её может вызвать кто угодно из интернета. Закрыть: ycFunctions { action: \"private\", function: \"" + fn.name + "\" }."
                : "Функция закрытая: чтобы её вызвали снаружи, нужна роль " + ycFunctions.INVOKER_ROLE + " у вызывающего либо публичность (ycFunctions { action: \"public\" }) — но тогда её позовёт кто угодно.");
          }

          return "Ошибка: действие " + action + " не обработано.";
        } catch (e) {
          return "Yandex Cloud (ycFunctions, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },

    // Биллинг: платёжный аккаунт, пороги и «за что мы платим». Только чтение —
    // и это не упущение: менять деньги по API облако не даёт вообще. Поэтому ни
    // один чекбокс разрешений к инструменту не относится: посмотреть, сколько
    // уходит и на что, агент обязан мочь всегда, а не когда разрешили тратить.
    "ycBilling": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!ycBilling) return "Ошибка: модуль биллинга (src/yc-billing.js) не подключён в этой сборке.";
        const action = String(args.action || "overview").trim().toLowerCase();
        const ACTIONS = ["overview", "accounts", "account", "budgets", "price", "services", "leaks"];
        if (ACTIONS.indexOf(action) < 0) {
          return "Ошибка: неизвестное действие ycBilling «" + action + "». Доступно: " + ACTIONS.join(", ") + ".\nБиллинг только ЧИТАЕТ: он ничего не создаёт, не меняет и не удаляет.";
        }
        if (!cfg.oauth) {
          return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud». Ориентиры по цене работают и без подключения: ycCosts(service).";
        }
        if ((action === "overview" || action === "leaks") && !cfg.folderId) {
          return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud — без него не видно, за что платят. Баланс и пороги каталога не требуют: ycBilling { action: \"accounts\" }.";
        }
        try {
          const where = "«" + (cfg.folderName || cfg.folderId) + "»";

          if (action === "accounts") {
            const list = await ycBilling.accounts(cfg.oauth);
            if (!list.length) return "Платёжных аккаунтов нет: облако не привязано к счёту — платные ресурсы создавать некуда.";
            return "Платёжные аккаунты (" + list.length + "):\n" + [].concat.apply([], list.map(ycBilling.accountLines)).join("\n") +
              "\n\nБаланс — это НЕ расход: отрицательный баланс означает, что облако скоро остановит ресурсы. Пороги: ycBilling { action: \"budgets\", account: \"id\" }. Сумма счёта — только в консоли (Биллинг → Расходы).";
          }

          if (action === "account") {
            const acc = await ycBilling.findAccount(cfg.oauth, args.account);
            return ycBilling.accountLines(acc).join("\n") +
              "\n\nПороги этого аккаунта: ycBilling { action: \"budgets\", account: \"" + acc.id + "\" }.";
          }

          if (action === "services") {
            const list = await ycBilling.services(cfg.oauth);
            return "Услуги, которые облако тарифицирует (" + list.length + "):\n" +
              list.map((x) => "• " + x.name + " — " + x.id).join("\n") +
              "\n\nЦену ищи по названию: ycBilling { action: \"price\", query: \"быстрый диск\" }. Сузить до услуги: ycBilling { action: \"price\", query: \"диск\", serviceId: \"" + ((list[0] || {}).id || "") + "\" }.";
          }

          if (action === "price") {
            const query = String(args.query || args.what || "").trim();
            if (!query) return "Ошибка: скажи, чью цену искать — ycBilling { action: \"price\", query: \"быстрый диск\" }. Слова: диск, ядро, память, функция, бакет, запрос.";
            const r = await ycBilling.priceSearch(cfg.oauth, {
              query: query,
              currency: args.currency,
              serviceId: args.serviceId,
              billingAccountId: args.account,
              limit: args.limit,
            });
            return "Цены из живого каталога облака по запросу «" + query + "»:\n" + r.lines.join("\n") +
              (r.total ? "\n\nСвой ориентир по ресурсу: ycCosts(service). Если облако говорит другое число — верь облаку и скажи пользователю, что наш ориентир устарел." : "");
          }

          if (action === "budgets") {
            const acc = await ycBilling.findAccount(cfg.oauth, args.account);
            const list = await ycBilling.budgets(cfg.oauth, acc.id);
            if (!list.length) {
              return "Порогов-бюджетов у аккаунта «" + (acc.name || acc.id) + "» нет. Это значит, что о перерасходе человек узнает по факту, а не заранее.\n" +
                "Порог задаётся в консоли (Биллинг → Бюджеты): по API для создания нужен id пользователя для уведомлений, которого агент не знает и угадывать не должен.";
            }
            return "Пороги аккаунта «" + (acc.name || acc.id) + "» (" + list.length + "):\n" + [].concat.apply([], list.map(ycBilling.budgetLines)).join("\n") +
              "\n\nПорог — это предупреждение, а не расход: сумму счёта облако по API не отдаёт (она в консоли, Биллинг → Расходы).";
          }

          if (action === "leaks") {
            const l = await ycBilling.leaks(cfg.oauth, cfg.folderId);
            return "Деньги, которые уходят в каталоге " + where + ":\n" + l.lines.join("\n") +
              (l.count ? "\n\nПорядок действий: сначала предложи пользователю снимок (ycCompute { action: \"snapshot\", disk: \"имя\", confirm: true }), потом удаление — и только с его согласия. Сам ничего не удаляй." : "");
          }

          if (action === "overview") {
            const ov = await ycBilling.overview(cfg.oauth, cfg.folderId, { account: args.account, currency: args.currency });
            const lines = ["Деньги в Yandex Cloud" + (cfg.folderId ? " (каталог " + where + ")" : "")];
            lines.push.apply(lines, ov.lines);
            lines.push("");
            lines.push("Что дальше: цены — ycBilling { action: \"price\", query: \"...\" }; хвосты — ycBilling { action: \"leaks\" }; баланс и пороги — ycBilling { action: \"accounts\" } и { action: \"budgets\" }. Оценка ДО создания ресурса — ycCosts.");
            return lines.join("\n");
          }

          return "Ошибка: действие " + action + " не обработано.";
        } catch (e) {
          return "Yandex Cloud (ycBilling, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },
    // HTTPS-сайт на своём домене: сертификат Certificate Manager (бесплатный,
    // Let's Encrypt) и ресурс Cloud CDN, который раздаёт файлы из бакета по
    // https. Без этого «свой сайт» оставался либо http, либо чужим хостингом:
    // сертификат и CDN делались только в консоли облака. Тела запросов живут в
    // src/yc-cdn.js: здесь выбор действия, права и человеческий ответ.
    "ycCdn": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!ycCdn) return "Ошибка: модуль сертификатов и CDN (src/yc-cdn.js) не подключён в этой сборке.";
        const action = String(args.action || "overview").trim().toLowerCase();
        const ACTIONS = ["overview", "certs", "cert", "certnew", "certimport", "certupdate", "certdel", "cdn", "cdninfo", "cdncreate", "cdnupdate", "cdnpurge", "cdndel", "origins", "origincreate", "originupdate", "origindel"];
        if (ACTIONS.indexOf(action) < 0) {
          return "Ошибка: неизвестное действие ycCdn «" + action + "». Доступно: " + ACTIONS.join(", ") + ".\nЭто про HTTPS-сайт: сертификат (Certificate Manager) и CDN-ресурс (Cloud CDN).";
        }
        if (!cfg.oauth) {
          return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud». Ориентир по цене CDN работает и без подключения: ycCosts(\"cdn\").";
        }
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud — сертификат и CDN-ресурс живут в каталоге.";
        const ref = String(args.certificate || args.cert || args.resource || args.cdn || args.group || args.id || args.name || args.cname || args.domain || "").trim();
        // Права: создание — сертификат и CDN-ресурс, правка — привязка
        // сертификата, включение/выключение и очистка кэша, удаление — снос.
        const needsCreate = ["certnew", "certimport", "cdncreate", "origincreate"].indexOf(action) >= 0;
        const needsUpdate = ["certupdate", "cdnupdate", "cdnpurge", "originupdate"].indexOf(action) >= 0;
        const needsDelete = ["certdel", "cdndel", "origindel"].indexOf(action) >= 0;
        if (needsCreate && !cfg.allowCreate) {
          return "⛔ Создавать сертификаты и CDN-ресурсы агентом ЗАПРЕЧЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Посмотреть, что уже есть, можно и сейчас: ycCdn { action: \"overview\" }.";
        }
        if (needsUpdate && !cfg.allowUpdate) {
          return "⛔ Менять сертификаты и CDN агентом ЗАПРЕЧЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры и правила сети» — он же разрешает привязку сертификата, включение ресурса и очистку кэша. Посмотреть можно и сейчас: ycCdn { action: \"overview\" }.";
        }
        if (needsDelete && !cfg.allowDelete) {
          return "⛔ Удалять сертификаты и CDN-ресурсы агентом ЗАПРЕЧЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы». Посмотреть, что есть, можно и сейчас: ycCdn { action: \"overview\" }.";
        }
        try {
          const where = "«" + (cfg.folderName || cfg.folderId) + "»";

          if (action === "overview") {
            const certs = await ycCdn.certOverview(cfg.oauth, cfg.folderId);
            const cdn = await ycCdn.cdnOverview(cfg.oauth, cfg.folderId);
            const lines = ["HTTPS-сайт в каталоге " + where + ": сертификаты и CDN"];
            lines.push("");
            lines.push("Сертификаты (" + certs.certificates.length + ")");
            lines.push(...certs.lines);
            lines.push("");
            lines.push("CDN-ресурсы (" + cdn.resources.length + ")");
            lines.push(...cdn.lines);
            lines.push("");
            lines.push("Что дальше. Выпустить бесплатный сертификат: ycCdn { action: \"certnew\", name: \"site-cert\", domains: [\"cdn.example.com\"] } — и добавить запись подтверждения в DNS (её показывает action \"cert\").");
            lines.push("Сделать сайт по https из бакета: ycCdn { action: \"cdncreate\", cname: \"cdn.example.com\", bucket: \"имя-бакета\", certificate: \"имя-сертификата\", confirm: true } — это ПЛАТНО (150 ₽/мес за ресурс), спрашивай согласие.");
            lines.push("Порядок важен: сначала сертификат ВЫПУЩЕН (статус Issued), потом ресурс, потом CNAME домена на адрес провайдера. HTTPS заработает не сразу: проверка домена может занять часы, изменения в CDN — до 15 минут.");
            return lines.join("\n");
          }

          if (action === "certs") {
            const ov = await ycCdn.certOverview(cfg.oauth, cfg.folderId);
            return "Сертификаты в каталоге " + where + " (" + ov.certificates.length + "):\n" + ov.lines.join("\n") +
              "\n\nПодробнее: ycCdn { action: \"cert\", certificate: \"имя\" }. Выпустить: action \"certnew\" (бесплатно, Let's Encrypt).";
          }

          if (action === "cert") {
            if (!ref) return "Ошибка: укажи certificate — имя, id или домен (список: ycCdn { action: \"certs\" }).";
            const c = await ycCdn.requireCertificate(cfg.oauth, cfg.folderId, ref);
            const out = ycCdn.certLines(c);
            const plan = ycCdn.challengePlan(c);
            if (plan.length) {
              out.push("");
              out.push("Проверка прав на домен:");
              out.push(...ycCdn.planLines(plan));
              out.push("Запись добавляется в DNS-зону домена. Если домен ведёт Cloud DNS — это ycDns { action: \"add\", ... }; если домен у другого регистратора — запись добавляет человек.");
              if (c.challengeType === "DNS") out.push("CNAME-запись подтверждается один раз и дальше продления проходят сами; TXT придётся обновлять каждые 60 дней — поэтому бери CNAME.");
            }
            return out.join("\n");
          }

          if (action === "certnew") {
            if (!args.domains && !args.domain) return "Ошибка: укажи domains — для каких доменов сертификат (например [\"cdn.example.com\"] или [\"example.com\", \"*.example.com\"]).";
            const r = await ycCdn.requestCertificate(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name || "site-cert",
              domains: args.domains || args.domain,
              challengeType: args.challengeType,
              description: args.description,
              deletionProtection: args.deletionProtection,
            });
            const out = ["✅ " + r.message];
            if (r.certificate) out.push(...ycCdn.certLines(r.certificate));
            if (r.lines && r.lines.length) {
              out.push("");
              out.push("Что добавить, чтобы домен подтвердился:");
              out.push(...r.lines);
            }
            out.push("");
            for (const w of r.warnings || []) out.push("⚠ " + w);
            return out.join("\n");
          }

          if (action === "certimport") {
            const pem = args.certificateText || args.pem;
            if (!pem || !(args.privateKey || args.key)) return "Ошибка: нужны и сертификат, и приватный ключ (полные PEM-файлы). Обычно проще взять бесплатный сертификат у облака: ycCdn { action: \"certnew\", domains: [...] }.";
            const r = await ycCdn.importCertificate(cfg.oauth, {
              folderId: cfg.folderId,
              name: args.name || "site-cert",
              certificate: pem,
              chain: args.chain,
              privateKey: args.privateKey || args.key,
              description: args.description,
            });
            return "✅ " + r.message + "\n" + (r.warnings || []).map((w) => "⚠ " + w).join("\n");
          }

          if (action === "certupdate") {
            if (!ref) return "Ошибка: укажи certificate — имя или id сертификата.";
            const r = await ycCdn.updateCertificate(cfg.oauth, {
              folderId: cfg.folderId,
              certificate: ref,
              certificateText: args.certificateText || args.pem,
              privateKey: args.privateKey || args.key,
              chain: args.chain,
              newName: args.newName,
              description: args.description,
              labels: args.labels,
              deletionProtection: args.deletionProtection,
            });
            return (r.changed ? "✅ " : "") + r.message;
          }

          if (action === "certdel") {
            if (!ref) return "Ошибка: укажи certificate — имя или id сертификата.";
            const r = await ycCdn.deleteCertificate(cfg.oauth, { folderId: cfg.folderId, certificate: ref, confirm: args.confirm === true });
            if (!r.deleted) {
              const out = ["⛔ Пока ничего не удаляю. " + r.message];
              for (const w of r.warnings || []) out.push("  • " + w);
              out.push("");
              out.push("Получи согласие пользователя и повтори с confirm: true.");
              return out.join("\n");
            }
            return "✅ " + r.message + "\n" + (r.warnings || []).map((w) => "⚠ " + w).join("\n");
          }

          if (action === "cdn" || action === "cdnlist") {
            const ov = await ycCdn.cdnOverview(cfg.oauth, cfg.folderId);
            return "CDN-ресурсы в каталоге " + where + " (" + ov.resources.length + "):\n" + ov.lines.join("\n") +
              "\n\nПодробнее: ycCdn { action: \"cdninfo\", resource: \"домен\" }. Создать сайт из бакета: action \"cdncreate\" (платно, нужно согласие).";
          }

          if (action === "cdninfo") {
            if (!ref) return "Ошибка: укажи resource — домен или id ресурса (список: ycCdn { action: \"cdn\" }).";
            const r = await ycCdn.requireResource(cfg.oauth, cfg.folderId, ref);
            const out = ycCdn.cdnLines(r);
            if (r.providerCname) {
              out.push("");
              out.push("Домен должен указывать на CDN, а не на бакет: " + r.cname + " CNAME " + r.providerCname + ".");
            }
            return out.join("\n");
          }

          if (action === "cdncreate") {
            if (!(args.cname || args.domain)) return "Ошибка: укажи cname — основной домен сайта (например cdn.example.com). Он задаётся один раз и потом не меняется.";
            if (!(args.bucket || args.bucketName || args.originGroupId)) {
              return "Ошибка: укажи источник — bucket: \"имя-бакета\" (проще всего) или originGroupId. Без источника CDN неоткуда брать файлы.";
            }
            const est = ycCosts && ycCosts.estimate ? ycCosts.estimate("cdn", {}) : null;
            const r = await ycCdn.createResource(cfg.oauth, {
              folderId: cfg.folderId,
              cname: args.cname || args.domain,
              bucket: args.bucket || args.bucketName,
              originGroupId: args.originGroupId,
              certificate: args.certificate || args.certificateId || args.sslCertificateId,
              secondaryHostnames: args.secondaryHostnames || args.altDomains,
              website: args.website,
              originProtocol: args.originProtocol,
              active: args.active,
              options: args.options,
              labels: args.labels,
              confirm: args.confirm === true,
            });
            if (!r.created) {
              const out = ["⛔ Пока ничего не создаю. " + r.message];
              if (est) out.push(...ycCosts.formatLines(est).map((l) => "  " + l));
              for (const w of r.warnings || []) out.push("  • " + w);
              out.push("");
              out.push("Назови пользователю цену и что получится, получи согласие и повтори с confirm: true.");
              return out.join("\n");
            }
            const out = ["✅ " + r.message];
            out.push(...(r.lines || []));
            out.push("");
            for (const w of r.warnings || []) out.push("⚠ " + w);
            return out.join("\n");
          }

          if (action === "cdnupdate") {
            if (!ref) return "Ошибка: укажи resource — домен или id CDN-ресурса.";
            const r = await ycCdn.updateResource(cfg.oauth, {
              folderId: cfg.folderId,
              resource: ref,
              certificate: args.certificate || args.certificateId || args.sslCertificateId,
              disableSsl: args.disableSsl === true,
              originGroupId: args.originGroupId,
              secondaryHostnames: args.secondaryHostnames || args.altDomains,
              active: args.active,
              originProtocol: args.originProtocol,
              options: args.options,
              labels: args.labels,
              cname: args.cname,
            });
            return (r.changed ? "✅ " : "") + r.message + "\n" + (r.warnings || []).map((w) => "⚠ " + w).join("\n");
          }

          if (action === "cdnpurge") {
            if (!ref) return "Ошибка: укажи resource — домен или id CDN-ресурса.";
            const r = await ycCdn.purgeCache(cfg.oauth, {
              folderId: cfg.folderId,
              resource: ref,
              paths: args.paths || args.path,
              all: args.all === true || args.full === true,
            });
            return "✅ " + r.message + "\n" + (r.warnings || []).map((w) => "⚠ " + w).join("\n");
          }

          if (action === "cdndel") {
            if (!ref) return "Ошибка: укажи resource — домен или id CDN-ресурса.";
            const r = await ycCdn.deleteResource(cfg.oauth, { folderId: cfg.folderId, resource: ref, confirm: args.confirm === true });
            if (!r.deleted) {
              const out = ["⛔ Пока ничего не удаляю. " + r.message];
              for (const w of r.warnings || []) out.push("  • " + w);
              out.push("");
              out.push("Получи согласие пользователя и повтори с confirm: true.");
              return out.join("\n");
            }
            return "✅ " + r.message + "\n" + (r.warnings || []).map((w) => "⚠ " + w).join("\n");
          }

          if (action === "origins") {
            const groups = await ycCdn.originGroups(cfg.oauth, cfg.folderId);
            if (!groups.length) return "Групп источников в каталоге " + where + " нет. Обычно их и не нужно создавать руками: cdncreate с bucket: \"имя-бакета\" делает группу сам.";
            return "Группы источников в каталоге " + where + " (" + groups.length + "):\n" +
              groups.map((g) => "• " + g.name + " — источников: " + g.origins.length + (g.origins.length ? " (" + g.origins.map((o) => o.human).join("; ") + ")" : "") + " · id " + g.id).join("\n");
          }

          if (action === "origincreate") {
            const src = args.origins || args.source || args.bucket;
            if (!src) return "Ошибка: укажи origin — domains: [{ bucket: \"имя-бакета\" }] или [{ source: \"files.example.com\" }].";
            const r = await ycCdn.createOriginGroup(cfg.oauth, { folderId: cfg.folderId, name: args.name, origins: src, useNext: args.useNext });
            return "✅ " + r.message + "\n" + (r.warnings || []).map((w) => "⚠ " + w).join("\n");
          }

          if (action === "originupdate") {
            if (!ref) return "Ошибка: укажи group — имя или id группы источников.";
            const r = await ycCdn.updateOriginGroup(cfg.oauth, {
              folderId: cfg.folderId,
              group: ref,
              newName: args.newName,
              origins: args.origins,
              useNext: args.useNext,
            });
            return (r.changed ? "✅ " : "") + r.message + "\n" + (r.warnings || []).map((w) => "⚠ " + w).join("\n");
          }

          if (action === "origindel") {
            if (!ref) return "Ошибка: укажи group — имя или id группы источников.";
            const r = await ycCdn.deleteOriginGroup(cfg.oauth, { folderId: cfg.folderId, group: ref, confirm: args.confirm === true, force: args.force === true });
            if (!r.deleted) {
              const out = ["⛔ Пока ничего не удаляю. " + r.message];
              for (const w of r.warnings || []) out.push("  • " + w);
              out.push("");
              out.push("Получи согласие пользователя и повтори с confirm: true.");
              return out.join("\n");
            }
            return "✅ " + r.message;
          }

          return "Ошибка: действие " + action + " не обработано.";
        } catch (e) {
          return "Yandex Cloud (ycCdn, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },

  };
}

module.exports = { createCloudTools };

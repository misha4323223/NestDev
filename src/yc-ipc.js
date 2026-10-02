"use strict";

/* ─── Каналы «yc:*»: мост между интерфейсом и Yandex Cloud ────────────────────
   Раньше 17 обработчиков были рассыпаны по main.js между почтой, памятью и
   деплоем: найти нужный можно было только поиском. Здесь они собраны в одном
   месте и получают зависимости снаружи — как остальные вынесенные подсистемы.

   Каждый обработчик возвращает { ok, ... } и НИКОГДА не бросает наружу: ошибка
   облака превращается в текст для интерфейса. Платные ресурсы создаются только
   с явным согласием (opts.confirmed) — цена показывается до создания.

   17 каналов: авторизация и каталог, права агента, дашборд, обзор консоли,
   список и откат ревизий, ресурсы, стоимость, создание/удаление, логи, yc CLI
   и сеть VPC (подсети, группы безопасности, статические адреса).

   Плюс один канал на раздел, а не на каждое действие (yc:vpc — сеть,
   yc:compute — машины, yc:cdn — сертификаты и CDN): у машины действий больше
   двадцати, и канал на каждое вернул бы ровно тот рост, из-за которого 17
   каналов когда-то расползлись по оболочке. Тела запросов живут в модулях, здесь — выбор действия и отказ. */

function registerYcIpc(deps) {
  const { ipcMain, yandexCloud, ycConsole, ycCosts, ycVpc, ycCompute, ycIam, ycFunctions, ycBilling, ycCdn, ycMonitoring, ycAi, ycMdb, ycIg, ycAlb, ycDb, ycLogs, ycApiGw, ycLockbox, ycRegistry, ycPostbox, ycSa, loadSettings, saveSettings, svc, fs, path: nodePath, resolvePath, agentWorkDir } = deps;
  const {
    YANDEX_OAUTH_URL,
    ycConfig,
    ycRequireAuth,
    readYcLogsText,
    ycCliStatus,
    ycCliInstall,
    // Контейнер и его ревизии — те же помощники, что у агента и облачной
    // консоли (src/yc-service.js): искать по имени/id, читать активную ревизию и
    // показывать её словами. Одни и те же — значит окно и агент видят одно.
    ycFindContainerByRef,
    ycActiveRevision,
    ycJsonArg,
    ycRevisionLine,
    ycRevisionDetails,
  } = svc;

  // IAM-токен СЕРВИСНОГО аккаунта для Cloud Postbox. Обычный OAuth-токен этот
  // SES-совместимый API не принимает (он берёт каталог из самого сервисного
  // аккаунта), поэтому ключ из настроек меняется на токен в src/yc-sa.js.
  // Возвращаем и причину отказа: канал обязан сказать, чего именно не хватает,
  // а полке достаточно знать, что токена нет (она покажет честный 403).
  async function postboxToken(cfg) {
    if (!ycSa) return { token: "", error: "Модуль сервисного аккаунта не подключён к приложению (src/yc-sa.js)." };
    const key = ycSa.parseServiceAccount(cfg && cfg.saKey);
    if (!key) {
      return {
        token: "",
        error:
          "Postbox работает только с СЕРВИСНЫМ аккаунтом: вставь JSON-ключ сервисного аккаунта (роль postbox.viewer) в Настройки → «☁️ Yandex Cloud» → «Ключ сервисного аккаунта для Postbox». " +
          "Пользовательский OAuth-токен этот API не принимает.",
      };
    }
    try {
      return { token: await ycSa.getIamToken(key), error: "" };
    } catch (e) {
      return { token: "", error: (e && e.message) || String(e) };
    }
  }

ipcMain.handle("yc:status", async () => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  const out = {
    ok: true,
    loggedIn: !!cfg.oauth,
    cloudId: cfg.cloudId,
    folderId: cfg.folderId,
    folderName: cfg.folderName,
    allowCreate: cfg.allowCreate,
    allowDelete: cfg.allowDelete,
    allowUpdate: cfg.allowUpdate,
    allowPublic: cfg.allowPublic,
    oauthUrl: YANDEX_OAUTH_URL,
    clouds: [],
    folders: [],
    iamOk: false,
    error: "",
  };
  if (!cfg.oauth) return out;
  try {
    // Обмен токена — один раз, затем облака и каталоги идут ПАРАЛЛЕЛЬНО, когда
    // каталог уже известен: последовательный путь складывал таймауты (20 с + 20 с)
    // и автовыбор каталога занимал десятки секунд.
    await yandexCloud.getIamToken(cfg.oauth);
    const cloudsP = yandexCloud.listClouds(cfg.oauth);
    const foldersP = cfg.cloudId ? yandexCloud.listFolders(cfg.oauth, cfg.cloudId) : null;
    const clouds = await cloudsP;
    out.clouds = clouds;
    out.iamOk = true;
    const cloudId = cfg.cloudId || (clouds[0] && clouds[0].id) || "";
    const folders = foldersP ? await foldersP : await yandexCloud.listFolders(cfg.oauth, cloudId);
    out.folders = folders;
    if (!cfg.folderId && folders[0]) {
      // Первый запуск: автоматически выбираем первый каталог первого облака.
      const merged = { ...s, ycCloudId: cloudId, ycFolderId: folders[0].id, ycFolderName: folders[0].name };
      saveSettings(merged);
      out.cloudId = cloudId;
      out.folderId = folders[0].id;
      out.folderName = folders[0].name;
    }
  } catch (e) {
    out.iamOk = false;
    out.error = (e && e.message) || String(e);
  }
  return out;
});

ipcMain.handle("yc:setToken", async (_e, token) => {
  const t = String(token || "").trim();
  if (!t) return { ok: false, error: "Вставь OAuth-токен со страницы авторизации Yandex." };
  try {
    yandexCloud.resetIamCache();
    const clouds = await yandexCloud.listClouds(t);
    const cloudId = (clouds[0] && clouds[0].id) || "";
    const folders = await yandexCloud.listFolders(t, cloudId);
    const folder = folders[0] || null;
    const merged = {
      ...loadSettings(),
      yandexOauthToken: t,
      ycCloudId: cloudId,
      ycFolderId: folder ? folder.id : "",
      ycFolderName: folder ? folder.name : "",
    };
    saveSettings(merged);
    return {
      ok: true,
      account: clouds[0] ? clouds[0].name : "аккаунт Yandex",
      cloudId,
      folderId: folder ? folder.id : "",
      folderName: folder ? folder.name : "",
      clouds,
      folders,
    };
  } catch (e) {
    yandexCloud.resetIamCache();
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:folders", async () => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    const clouds = await yandexCloud.listClouds(cfg.oauth);
    const cloudId = cfg.cloudId || (clouds[0] && clouds[0].id) || "";
    const folders = await yandexCloud.listFolders(cfg.oauth, cloudId);
    return { ok: true, clouds, folders, cloudId };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:setFolder", (_e, folderId, folderName, cloudId) => {
  const merged = {
    ...loadSettings(),
    ycFolderId: String(folderId || "").trim(),
    ycFolderName: String(folderName || "").trim(),
    ycCloudId: String(cloudId || "").trim(),
  };
  saveSettings(merged);
  return { ok: true };
});

ipcMain.handle("yc:setPermissions", (_e, allowCreate, allowDelete, allowUpdate, allowPublic) => {
  const merged = {
    ...loadSettings(),
    ycAllowAgentCreate: !!allowCreate,
    ycAllowAgentDelete: !!allowDelete,
    ycAllowAgentUpdate: !!allowUpdate,
    ycAllowAgentPublic: !!allowPublic,
  };
  saveSettings(merged);
  return { ok: true };
});

ipcMain.handle("yc:logout", () => {
  const s = loadSettings();
  delete s.yandexOauthToken;
  s.ycCloudId = "";
  s.ycFolderId = "";
  s.ycFolderName = "";
  saveSettings(s);
  yandexCloud.resetIamCache();
  return { ok: true };
});

// Дашборд: счётчики ресурсов по всем сервисам выбранного каталога.
// ── Консоль Yandex Cloud: заглянуть внутрь ресурса ─────────────────────────
// Обзор одного ресурса: все его поля (плюс уточнение из GET по id) и счётчики
// связанных объектов. Списки связанного грузятся отдельно — по клику, чтобы
// карточка открывалась сразу, а не ждала все запросы.
ipcMain.handle("yc:console:overview", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  const a = args || {};
  try {
    return await ycConsole.overview(cfg.oauth, {
      serviceKey: a.serviceKey,
      id: a.id,
      item: a.item,
      folderId: a.folderId || cfg.folderId,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:console:list", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  const a = args || {};
  try {
    return await ycConsole.relationList(cfg.oauth, {
      serviceKey: a.serviceKey,
      relationKey: a.relationKey,
      id: a.id,
      name: a.name,
      folderId: a.folderId || cfg.folderId,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Откат контейнера на ревизию прямо из карточки (в консоли это «сделать активной»).
// Право на изменение проверяем здесь: у карточки нет своих прав, а у настроек есть.
ipcMain.handle("yc:console:rollback", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  if (!cfg.allowUpdate) {
    return {
      ok: false,
      error: "Откат выключен: включи «Разрешить агенту менять контейнеры» в Настройках → Yandex Cloud.",
    };
  }
  const a = args || {};
  try {
    return await ycConsole.rollbackRevision(cfg.oauth, { containerId: a.containerId, revisionId: a.revisionId });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Новая версия секрета Lockbox из карточки в панели. Разрешение агента здесь не
// спрашиваем намеренно: галочки в настройках называются «Разрешить АГЕНТУ…» и
// ограничивают модель, а не человека, который сам открыл свой секрет и нажал
// «Сохранить версию». Те же правила у соседних yc:create / yc:delete.
// Значения не возвращаются и не логируются — наружу уходят id версии и ключи.
ipcMain.handle("yc:console:secretVersion", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  const a = args || {};
  try {
    return await ycConsole.putSecretVersion(cfg.oauth, {
      secretId: a.secretId || a.id,
      entries: a.entries,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Записи DNS-зоны из карточки в панели: op «upsert» — поставить значения для
// пары «имя+тип» (есть — заменить, нет — добавить), op «delete» — удалить набор.
// Разрешение агента здесь не спрашиваем по той же причине, что у версии секрета:
// галочки ограничивают модель, а здесь действует человек в своём окне.
ipcMain.handle("yc:console:dnsRecord", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  const a = args || {};
  const op = String(a.op || "upsert").trim().toLowerCase();
  try {
    if (op === "delete") return await ycConsole.deleteRecord(cfg.oauth, { zoneId: a.zoneId || a.id, name: a.name, type: a.type });
    if (op !== "upsert") return { ok: false, error: "Неизвестная операция с записью: " + op + ". Доступно: upsert, delete." };
    return await ycConsole.upsertRecord(cfg.oauth, {
      zoneId: a.zoneId || a.id,
      name: a.name,
      type: a.type,
      ttl: a.ttl,
      values: a.values || a.value,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Чистка Container Registry: удалить образ (вместе с его тегами) из карточки
// реестра. Образ ищем по id или тегу — id возвращает список образов, а человек
// и модель называют тег. Разрешение агента не спрашиваем по той же причине, что
// у записи DNS и версии секрета: галочки ограничивают модель, а здесь действует
// человек в своём окне, к тому же с подтверждением в интерфейсе.
ipcMain.handle("yc:console:registryImage", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  const a = args || {};
  const op = String(a.op || "delete").trim().toLowerCase();
  if (op !== "delete") return { ok: false, error: "Неизвестная операция с образом: " + op + ". Доступно: delete." };
  try {
    return await ycConsole.deleteRegistryImage(cfg.oauth, {
      registryId: a.registryId || a.registry || a.id,
      imageId: a.imageId,
      tag: a.tag,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Файлы в бакете из карточки бакета: удаление объекта. Разрешение агента здесь не
// спрашиваем по той же причине, что у образов реестра, записи DNS и версии
// секрета: галочки ограничивают модель, а здесь действует человек в своём окне —
// к тому же с подтверждением в интерфейсе.
ipcMain.handle("yc:console:storageObject", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  const a = args || {};
  const op = String(a.op || "delete").trim().toLowerCase();
  if (op !== "delete") return { ok: false, error: "Неизвестная операция с объектом: " + op + ". Доступно: delete." };
  try {
    return await ycConsole.deleteBucketObject(cfg.oauth, {
      bucket: a.bucket || a.bucketName,
      key: a.key,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Публичный доступ к бакету из карточки бакета. Разрешение агента здесь НЕ
// спрашиваем — по той же причине, что у удаления объекта: галочки в настройках
// называются «Разрешить АГЕНТУ…» и ограничивают модель, а здесь действует человек
// в своём окне, к тому же с подтверждением в интерфейсе.
ipcMain.handle("yc:console:bucketAccess", async (_e, args) => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  const a = args || {};
  const op = String(a.op || "get").trim().toLowerCase();
  try {
    if (op === "get") {
      return await ycConsole.getBucketAccessFlags(cfg.oauth, a.bucket || a.bucketName || a.name);
    }
    if (op === "set") {
      if (a.public == null) return { ok: false, error: "Не указано, делать бакет публичным (public: true) или закрытым (public: false)." };
      return await ycConsole.setBucketPublicAccess(cfg.oauth, { bucket: a.bucket || a.bucketName || a.name, publicOn: !!a.public });
    }
    return { ok: false, error: "Неизвестная операция с бакетом: " + op + ". Доступно: get, set." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:resources", async () => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    if (!cfg.folderId) {
      return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
    }
    // Плитку Postbox спрашиваем токеном сервисного аккаунта, если ключ есть:
    // без него облако отвечает 403, и плитка покажет это с объяснением, а не
    // соврёт «0 адресов».
    const pb = await postboxToken(cfg);
    const services = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId, pb.token ? { subjectToken: pb.token } : {});
    const total = services.reduce((acc, s) => acc + (s.ok ? s.count : 0), 0);
    const activeServices = services.filter((s) => s.ok && s.count > 0).length;
    return { ok: true, folderId: cfg.folderId, folderName: cfg.folderName, services, total, activeServices };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Оценка стоимости ресурса ДО создания: ничего не создаёт и ничего не меняет.
ipcMain.handle("yc:costs", (_e, serviceKey, params) => {
  try {
    const key = String(serviceKey || "");
    const est = ycCosts.estimate(key, params || {});
    if (!est) return { ok: false, error: "Нет данных о стоимости: " + key };
    return { ok: true, estimate: est, lines: ycCosts.formatLines(est), hint: ycCosts.hint(key) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:create", async (_e, serviceKey, name, opts) => {
  const o = opts || {};
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder)." };
    const key = String(serviceKey || "");
    const est = ycCosts.estimate(key, {});
    // Платное — только с согласием. Согласие интерфейса: нажатие «Создать» в диалоге,
    // где цена показана (opts.confirmed). Из агента это делает инструкция + confirm.
    if (est && est.needsConfirm && !o.confirmed) {
      const line = ycCosts.formatLines(est)[0];
      return { ok: false, needsConfirm: true, estimate: est, lines: ycCosts.formatLines(est), error: "Создание платного ресурса без согласия: " + line };
    }
    const r = await yandexCloud.createResource(cfg.oauth, cfg.folderId, key, String(name || ""));
    return { ok: true, message: r.message, resourceId: r.resourceId, name: r.name, cost: est ? ycCosts.money(est.approxMonth || 0) : "" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:delete", async (_e, serviceKey, resourceId) => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    const r = await yandexCloud.deleteResource(cfg.oauth, String(serviceKey || ""), String(resourceId || ""));
    return { ok: true, message: r.message };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Логи ресурса — внутренним API Cloud Logging (REST для лог-групп + gRPC для записей).
ipcMain.handle("yc:logs", async (_e, serviceKey, resourceId) => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder)." };
  const id = String(resourceId || "").trim();
  if (!id) return { ok: false, error: "Не указан id ресурса." };
  try {
    const text = await readYcLogsText(cfg, String(serviceKey || "").trim(), id, { limit: 100, sinceHours: 3 });
    return { ok: true, logs: text.split("\n").slice(1), raw: text };
  } catch (e) {
    return { ok: false, error: "Логи: " + ((e && e.message) || String(e)) };
  }
});

// ── Группы логов Cloud Logging: посмотреть, создать, поправить, удалить ──────
// Лог-группа — это «куда собирать логи». Без неё ни ревизия контейнера, ни
// разбор запросов балансировщика некуда направить, а создать её из окна было
// нечем: сервис «Логи» на полке показывал только список. Записи читаются по
// gRPC (канал yc:logs), а сами группы — обычный REST того же хоста, и изменяющие
// методы возвращают OPERATION, поэтому их результат ждёт waitOperation.
// Права агента здесь НЕ спрашиваем: галочки «Разрешить АГЕНТУ…» ограничивают
// модель, а здесь действует человек в своём окне — как у записей DNS и объектов
// бакета.
ipcMain.handle("yc:logGroups", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "group", "create", "update", "delete"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycLogs) return { ok: false, error: "Модуль логов не подключён к приложению (src/yc-logs.js)." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие групп логов: " + op + ". Доступно: " + ALL.join(", ") + "." };
  try {
    const base = (await yandexCloud.endpoint("logging")) || "https://logging.api.cloud.yandex.net";
    const iam = await yandexCloud.getIamToken(cfg.oauth);
    const groups = await ycLogs.listLogGroups(iam, base, cfg.folderId);
    if (op === "list") {
      return {
        ok: true,
        folder: { id: cfg.folderId, name: cfg.folderName },
        groups: groups,
        lines: groups.length ? groups.map((g) => ycLogs.logGroupLine(g)) : ["Лог-групп в каталоге нет. Создать — действием «＋ Создать лог-группу»."],
        message: "Лог-групп: " + groups.length + ".",
      };
    }
    const ref = String(a.group || a.logGroupId || a.name || "").trim();
    const found = ref ? groups.find((g) => g.id === ref) || groups.find((g) => g.name === ref) : groups.length === 1 ? groups[0] : null;
    if (op === "group") {
      if (!found) return { ok: false, error: "Не нашёл лог-группу «" + ref + "»" + (ref ? "." : " — групп несколько, выбери поле «Группа».") + " В каталоге: " + groups.map((g) => g.name).join(", ") + "." };
      const g = await ycLogs.getLogGroup(iam, base, found.id);
      return {
        ok: true,
        group: g,
        lines: [ycLogs.logGroupLine(g), "Описание: " + (g.description || "—"),
          "Метки: " + (Object.keys(g.labels || {}).length ? JSON.stringify(g.labels) : "нет"),
          "Хранение: " + (g.retentionPeriod || "без срока") + (g.dataStream ? " · поток данных: " + g.dataStream : ""),
          "Создана: " + (g.createdAt || "—")],
        message: "Лог-группа.",
      };
    }
    if (op === "create") {
      const name = String(a.name || "").trim();
      if (!name) return { ok: false, error: "Укажи имя лог-группы (name): строчная латиница, цифры и дефис, 2–63 символа." };
      const o = await ycLogs.createLogGroup(iam, base, {
        folderId: cfg.folderId,
        name: name,
        description: a.description,
        labels: ycJsonArg(a.labels),
        retentionPeriod: a.retention != null ? a.retention : a.retentionPeriod,
        dataStream: a.dataStream,
      });
      const done = await yandexCloud.waitOperation(cfg.oauth, o && o.id, 120000);
      const made = (done && done.response) || {};
      return {
        ok: true,
        changed: true,
        id: made.id || "",
        name: made.name || name,
        group: made,
        lines: ["✅ Лог-группа создана: " + (made.name || name) + (made.id ? " (" + made.id + ")" : ""),
          "Хранение: " + (made.retentionPeriod || "без срока") + (made.dataStream ? " · поток " + made.dataStream : ""),
          "Дальше: направь в неё журнал балансировщика (действие «Правка балансировщика» → «Группа логов») или логи ревизии контейнера."],
        message: "Лог-группа создана.",
      };
    }
    if (op === "update") {
      if (!found) return { ok: false, error: "Не нашёл лог-группу «" + ref + "» — назови поле «Группа»." };
      const o = await ycLogs.updateLogGroup(iam, base, found.id, {
        name: a.newName,
        description: a.description,
        retentionPeriod: a.retention != null ? a.retention : a.retentionPeriod,
        dataStream: a.dataStream,
        labels: a.labels != null ? ycJsonArg(a.labels) : undefined,
      });
      await yandexCloud.waitOperation(cfg.oauth, o && o.id, 120000);
      const g = await ycLogs.getLogGroup(iam, base, found.id);
      return { ok: true, changed: true, group: g, lines: ["✅ Лог-группа изменена.", ycLogs.logGroupLine(g)], message: "Лог-группа изменена." };
    }
    // delete — единственное оставшееся действие; необратимо, поэтому требует согласия.
    if (a.confirmed !== true) {
      return { ok: false, needsConfirm: true, error: "Удаление лог-группы необратимо: её настройки пропадут, а направленные в неё журналы больше не сохраняются. Подтверди удаление.", lines: found ? [ycLogs.logGroupLine(found)] : [] };
    }
    if (!found) return { ok: false, error: "Не нашёл лог-группу «" + ref + "» — назови поле «Группа»." };
    const o = await ycLogs.deleteLogGroup(iam, base, found.id);
    await yandexCloud.waitOperation(cfg.oauth, o && o.id, 120000);
    return { ok: true, changed: true, deleted: true, id: found.id, lines: ["🗑 Лог-группа удалена: " + (found.name || found.id), "Логи, что в неё собирались, дальше не сохраняются."], message: "Лог-группа удалена." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Встроенный yc CLI: статус (стоит ли и где) и установка внутрь приложения.
ipcMain.handle("yc:cliStatus", () => ycCliStatus());
ipcMain.handle("yc:installCli", async () => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const st = ycCliStatus();
  if (st.installed) return { ok: true, already: true, installed: true, path: st.path, dir: st.dir, version: "" };
  const r = await ycCliInstall();
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "не удалось установить yc CLI" };
  return { ok: true, installed: true, path: r.path, dir: r.dir, version: r.version, sizeMb: r.sizeMb };
});
// ── Сеть VPC: подсети, группы безопасности, статические адреса ─────────────
// Один канал на раздел, а не канал на каждое действие: у сети действий
// двенадцать, и десяток новых обработчиков вернул бы ровно тот рост, из-за
// которого 17 каналов когда-то расползлись по оболочке. Тела запросов живут в
// src/yc-vpc.js — здесь только выбор действия и понятный отказ.
// Права агента здесь НЕ спрашиваем: галочки в настройках называются «Разрешить
// АГЕНТУ…» и ограничивают модель, а здесь действует человек в своём окне — так
// же, как у записей DNS, версий секрета и объектов бакета в панели.
ipcMain.handle("yc:vpc", async (_e, args) => {
  const cfg = ycConfig();
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycVpc) return { ok: false, error: "Модуль сети VPC не подключён к приложению (src/yc-vpc.js)." };
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ref = a.subnet || a.group || a.address || a.id || a.name || "";
  try {
    if (op === "list") {
      const networks = await ycVpc.networks(cfg.oauth, cfg.folderId);
      const subnets = await ycVpc.subnets(cfg.oauth, cfg.folderId);
      const securityGroups = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
      const addresses = await ycVpc.addresses(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        folder: { id: cfg.folderId, name: cfg.folderName },
        networks,
        subnets,
        securityGroups,
        addresses,
        // Подсказка мастеру создания: свободный диапазон рядом с занятыми.
        suggestedCidr: ycVpc.suggestCidr(subnets),
        // Простаивающие статические адреса — деньги, о которых панель обязана сказать.
        idleAddresses: addresses.filter((x) => !x.used),
      };
    }

    if (op === "subnets") return { ok: true, subnets: await ycVpc.subnets(cfg.oauth, cfg.folderId) };
    if (op === "groups") return { ok: true, securityGroups: await ycVpc.securityGroups(cfg.oauth, cfg.folderId) };
    if (op === "addresses") return { ok: true, addresses: await ycVpc.addresses(cfg.oauth, cfg.folderId) };

    if (op === "addsubnet") {
      const subnet = await ycVpc.createSubnet(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        network: a.network || a.networkId,
        zoneId: a.zone || a.zoneId,
        cidr: a.cidr || a.v4CidrBlocks,
        description: a.description,
      });
      return { ok: true, subnet, message: "Подсеть «" + subnet.name + "» создана в зоне " + (subnet.zoneId || "—") + ", диапазон " + ((subnet.v4CidrBlocks || []).join(", ") || "—") + "." };
    }

    if (op === "delsubnet") {
      const list = await ycVpc.subnets(cfg.oauth, cfg.folderId);
      const s = ycVpc.matchByIdOrName(list, ref);
      if (!s) return { ok: false, error: "Не нашёл подсеть «" + ref + "»." };
      await ycVpc.deleteSubnet(cfg.oauth, s.id);
      return { ok: true, message: "Подсеть «" + s.name + "» удалена." };
    }

    if (op === "addgroup") {
      const group = await ycVpc.createSecurityGroup(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        network: a.network || a.networkId,
        description: a.description,
        rules: a.rules,
      });
      return { ok: true, group, message: "Группа безопасности «" + group.name + "» создана. Правил: вход " + group.ingress + ", выход " + group.egress + "." };
    }

    if (op === "delgroup") {
      const list = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
      const g = ycVpc.matchByIdOrName(list, ref);
      if (!g) return { ok: false, error: "Не нашёл группу безопасности «" + ref + "»." };
      await ycVpc.deleteSecurityGroup(cfg.oauth, g.id);
      return { ok: true, message: "Группа безопасности «" + g.name + "» удалена вместе со своими правилами." };
    }

    if (op === "addrule" || op === "delrule") {
      const groups = await ycVpc.securityGroups(cfg.oauth, cfg.folderId);
      const g = ycVpc.matchByIdOrName(groups, a.group || a.sg || a.sgId || "");
      if (!g) return { ok: false, error: "Не нашёл группу безопасности «" + (a.group || a.sg || "") + "»." };
      const rule = {
        direction: a.direction,
        protocol: a.protocol,
        port: a.port != null ? a.port : a.ports,
        cidr: a.cidr || a.source,
        sg: a.sourceGroup || a.fromGroup,
        target: a.target,
        description: a.description,
      };
      const r = await ycVpc.updateSecurityGroupRules(cfg.oauth, { sgId: g.id, add: op === "addrule" ? rule : null, remove: op === "delrule" ? rule : null });
      const who = (op === "addrule" ? r.added : r.removed).map((x) => ycVpc.ruleHuman(x)).join(", ");
      return {
        ok: true,
        changed: r.changed,
        group: r.group,
        message: !r.changed
          ? "Такое правило уже есть — ничего не менял."
          : (op === "addrule" ? "Правило добавлено: " : "Правило удалено: ") + who + ". Правил в группе теперь: " + (r.rules || []).length + ".",
      };
    }

    if (op === "reserve") {
      const address = await ycVpc.reserveAddress(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        zoneId: a.zone || a.zoneId,
        address: a.address,
        description: a.description,
        deletionProtection: a.protection === true || a.deletionProtection === true,
      });
      const est = ycCosts.estimate("vpcAddress", {});
      return {
        ok: true,
        address,
        estimate: est || null,
        lines: est ? ycCosts.formatLines(est) : [],
        message: "Статический адрес закреплён: " + (address.address || "(появится через несколько секунд)") + ". Пока он не привязан к машине, облако тарифицирует его как простаивающий.",
      };
    }

    if (op === "release") {
      const list = await ycVpc.addresses(cfg.oauth, cfg.folderId);
      const ad = ycVpc.matchByIdOrName(list, ref);
      if (!ad) return { ok: false, error: "Не нашёл статический адрес «" + ref + "»." };
      if (ad.used) {
        return { ok: false, error: "Адрес " + ad.address + " привязан к ресурсу: сначала отвяжи его (останови или удали машину), иначе IP уйдёт из-под живой машины." };
      }
      await ycVpc.releaseAddress(cfg.oauth, ad.id);
      return { ok: true, message: "Адрес " + ad.address + " освобождён. Вернуть именно его уже нельзя — всё, что на него указывало (DNS, белые списки), станет нерабочим." };
    }

    return { ok: false, error: "Неизвестное действие сети: " + op + ". Доступно: list, subnets, groups, addresses, addsubnet, delsubnet, addgroup, delgroup, addrule, delrule, reserve, release." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Виртуальные машины Compute Cloud ────────────────────────────────────────
// Почему одним каналом. У машины больше двадцати действий: чтение, питание,
// создание, удаление, снимки, serial-консоль и метрики. Тела запросов и вся
// проверка ввода живут в src/yc-compute.js — здесь только выбор действия и
// понятный отказ. Права агента не спрашиваем: галочки «Разрешить АГЕНТУ…»
// ограничивают модель, а здесь действует человек в своём окне — так же, как у
// правил сети, записей DNS и версий секрета в панели.
//
// Логика цен и предупреждений одна на всех: ответ всегда содержит estimate
// (сколько стоит) и warnings (что человек должен знать до нажатия).
ipcMain.handle("yc:compute", async (_e, args) => {
  const cfg = ycConfig();
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycCompute) return { ok: false, error: "Модуль машин Compute не подключён к приложению (src/yc-compute.js)." };
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ref = a.instance || a.name || a.id || a.instanceId || "";
  try {
    if (op === "list") {
      // Один запрос дашборда машин: машины, диски, снимки, зоны и подсети сразу.
      // Иначе окно показывало бы половину карточки, а вторую половину дочитывало
      // отдельными запросами при каждом открытии.
      const [instances, disks, snapshots] = await Promise.all([
        ycCompute.instances(cfg.oauth, cfg.folderId),
        ycCompute.disks(cfg.oauth, cfg.folderId),
        ycCompute.snapshots(cfg.oauth, cfg.folderId),
      ]);
      // Сеть читает свой модуль (yc-vpc.js): дублировать разбор подсетей и групп
      // безопасности во второй раз — верный способ разойтись с ним в полях.
      const subnets = ycVpc ? await ycVpc.subnets(cfg.oauth, cfg.folderId).catch(() => []) : [];
      const securityGroups = ycVpc ? await ycVpc.securityGroups(cfg.oauth, cfg.folderId).catch(() => []) : [];
      const addresses = ycVpc ? await ycVpc.addresses(cfg.oauth, cfg.folderId).catch(() => []) : [];
      return {
        ok: true,
        folder: { id: cfg.folderId, name: cfg.folderName },
        instances,
        disks,
        snapshots,
        subnets,
        securityGroups,
        addresses,
        zones: ["ru-central1-a", "ru-central1-b", "ru-central1-d"],
        presets: ycCompute.PRESETS,
        presetKeys: ycCompute.PRESET_KEYS,
        // Платные хвосты считает модуль: одно место правды на панель и агента.
        leftovers: ycCompute.paidLeftovers({ instances, disks, snapshots, addresses }),
      };
    }

    if (op === "card") {
      const inst = ref ? await ycCompute.findInstance(cfg.oauth, cfg.folderId, ref) : null;
      if (!inst) return { ok: false, error: "Не нашёл машину «" + ref + "»." };
      const disks = await ycCompute.disks(cfg.oauth, cfg.folderId);
      const snapshots = await ycCompute.snapshots(cfg.oauth, cfg.folderId);
      const subnets = ycVpc ? await ycVpc.subnets(cfg.oauth, cfg.folderId).catch(() => []) : [];
      const securityGroups = ycVpc ? await ycVpc.securityGroups(cfg.oauth, cfg.folderId).catch(() => []) : [];
      return {
        ok: true,
        instance: inst,
        disks: disks.filter((d) => d.id === inst.bootDisk.diskId || inst.secondaryDisks.some((s) => s.diskId === d.id)),
        snapshots: snapshots.filter((s) => s.sourceDiskId === inst.bootDisk.diskId),
        lines: ycCompute.cardLines(inst, { disks, snapshots, subnets, securityGroups }),
      };
    }

    if (op === "serial") {
      const r = await ycCompute.serialOutput(cfg.oauth, { folderId: cfg.folderId, instance: ref, lines: a.lines });
      return { ok: true, instance: r.instance, port: r.port, lines: r.lines, empty: r.empty, message: r.message };
    }

    if (op === "metrics") {
      const r = await ycCompute.metrics(cfg.oauth, { folderId: cfg.folderId, instance: ref, minutes: a.minutes });
      return { ok: true, metrics: r.metrics, errors: r.errors, lines: r.lines, idle: r.idle, message: r.message };
    }

    if (op === "start" || op === "stop" || op === "restart") {
      const inst = await ycCompute.findInstance(cfg.oauth, cfg.folderId, ref);
      if (!inst) return { ok: false, error: "Не нашёл машину «" + ref + "»." };
      const r = await ycCompute.power(cfg.oauth, op, inst, { folderId: cfg.folderId });
      return { ok: true, changed: r.changed, instance: r.instance, message: r.message, warnings: r.warnings || [] };
    }

    if (op === "create") {
      // Платное — только с подтверждением, как у остальных ресурсов облака.
      if (a.confirmed !== true) {
        const est = ycCosts.estimate("compute", {
          cores: a.cores,
          coreFraction: a.coreFraction,
          memoryGb: a.memoryGb,
          diskSizeGb: a.diskSizeGb,
          publicIp: a.publicIp === true || !!a.staticAddress,
          hours: a.hours,
        });
        return {
          ok: false,
          needsConfirm: true,
          estimate: est,
          lines: est ? ycCosts.formatLines(est) : [],
          error: "Машина создаётся платно: " + (est ? ycCosts.money(est.approxMonth) + " в месяц" : "цена зависит от конфигурации") + ". Подтверди создание.",
        };
      }
      const r = await ycCompute.createInstance(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        preset: a.preset,
        zone: a.zone || a.zoneId,
        platform: a.platform || a.platformId,
        cores: a.cores,
        memoryGb: a.memoryGb,
        coreFraction: a.coreFraction != null ? a.coreFraction : a.cpuGuarantee,
        imageFamily: a.imageFamily || a.image,
        imageId: a.imageId,
        diskType: a.diskType || a.diskTypeId,
        diskSizeGb: a.diskSizeGb,
        subnet: a.subnet,
        subnetId: a.subnetId,
        securityGroupIds: a.securityGroupIds || a.securityGroups,
        sshPublicKey: a.sshPublicKey,
        sshUser: a.sshUser,
        publicIp: a.publicIp === true || !!a.staticAddress,
        staticAddress: a.staticAddress,
        preemptible: a.preemptible,
        dataDiskSizeGb: a.dataDiskSizeGb,
        description: a.description,
        serialPort: a.serialPort !== false,
      });
      const est = ycCosts.estimate("compute", {
        cores: r.cores,
        coreFraction: r.coreFraction,
        memoryGb: Math.round(r.memoryBytes / (1024 * 1024 * 1024)),
        diskSizeGb: Math.round(r.diskSizeBytes / (1024 * 1024 * 1024)),
        publicIp: r.publicIp,
        hours: a.hours,
      });
      return {
        ok: true,
        instance: r.instance,
        subnet: r.subnet,
        securityGroupIds: r.securityGroupIds,
        sshUser: r.sshUser,
        estimate: est,
        lines: est ? ycCosts.formatLines(est) : [],
        message:
          "Машина «" + r.instance.name + "» создана: " + r.cores + " ядра × " + r.coreFraction + "%, " +
          Math.round(r.memoryBytes / (1024 * 1024 * 1024)) + " ГБ памяти, диск " + Math.round(r.diskSizeBytes / (1024 * 1024 * 1024)) + " ГБ, зона " + r.instance.zoneId +
          (r.instance.externalIp ? ", внешний адрес " + r.instance.externalIp : ", без внешнего адреса") + ".",
        warnings: r.warnings,
      };
    }

    if (op === "sshkey") {
      // Пара ключей создаётся ЗДЕСЬ, чтобы человек не искал ключ по файлам. Личный
      // ключ отдаётся один раз: вызывающий обязан сохранить его в хранилище.
      const pair = ycCompute.generateSshKeyPair({ comment: a.comment || (a.name ? "nestdev-" + a.name : "nestdev") });
      return {
        ok: true,
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
        fingerprint: pair.fingerprint,
        message: "Готова пара ключей SSH (отпечаток " + pair.fingerprint + "). Публичную строку вставь в машину, личный ключ сохрани в секреты и больше не показывай.",
      };
    }

    if (op === "delete") {
      const inst = await ycCompute.findInstance(cfg.oauth, cfg.folderId, ref);
      if (!inst) return { ok: false, error: "Не нашёл машину «" + ref + "»." };
      // Удаление необратимо — спрашиваем согласие и называем цифры.
      if (a.confirmed !== true) {
        const attached = [inst.bootDisk].concat(inst.secondaryDisks).filter((d) => d && d.diskId);
        const leftoverNote = attached.filter((d) => d.keepsAfterDelete).length;
        return {
          ok: false,
          needsConfirm: true,
          instance: inst,
          error:
            "Удаление машины «" + inst.name + "» необратимо: данные на дисках будут потеряны, если нет снимка. " +
            (leftoverNote ? "Дисков, которые останутся после удаления: " + leftoverNote + ". " : "") +
            "Подтверди удаление.",
        };
      }
      const r = await ycCompute.deleteInstance(cfg.oauth, {
        folderId: cfg.folderId,
        instance: inst,
        deleteDisks: a.deleteDisks !== false,
        releaseAddress: a.releaseAddress === true,
      });
      return { ok: true, deleted: r.deleted, instance: r.instance, deletedDisks: r.deletedDisks, keptDisks: r.keptDisks, message: r.message, warnings: r.warnings };
    }

    if (op === "snapshot") {
      if (a.confirmed !== true) {
        return { ok: false, needsConfirm: true, error: "Снимок диска хранится и тарифицируется, пока его не удалят. Подтверди создание." };
      }
      const r = await ycCompute.createSnapshot(cfg.oauth, {
        folderId: cfg.folderId,
        disk: a.disk,
        diskId: a.diskId,
        instance: a.instance,
        name: a.snapshotName || a.snapshot,
        description: a.description,
      });
      return { ok: true, snapshot: r.snapshot, message: "Снимок «" + r.snapshot.name + "» создан.", warnings: r.warnings };
    }

    if (op === "delsnapshot") {
      const r = await ycCompute.deleteSnapshot(cfg.oauth, { folderId: cfg.folderId, snapshot: a.snapshot, snapshotId: a.snapshotId });
      return { ok: true, deleted: true, message: r.message };
    }

    if (op === "cleansnapshots") {
      const r = await ycCompute.cleanSnapshots(cfg.oauth, {
        folderId: cfg.folderId,
        disk: a.disk,
        keep: a.keep,
        olderThanDays: a.olderThanDays,
        dryRun: a.dryRun !== false,
      });
      return { ok: true, dryRun: r.dryRun, doomed: r.doomed, kept: r.kept, removed: r.removed, failed: r.failed, message: r.message, warnings: r.warnings };
    }

    if (op === "restoredisk") {
      if (a.confirmed !== true) {
        return { ok: false, needsConfirm: true, error: "Восстановленный диск создаётся заново и тарифицируется. Подтверди восстановление." };
      }
      const r = await ycCompute.restoreDisk(cfg.oauth, {
        folderId: cfg.folderId,
        snapshot: a.snapshot,
        snapshotId: a.snapshotId,
        name: a.diskName,
        zone: a.zone || a.zoneId,
        diskType: a.diskType,
        sizeGb: a.sizeGb,
        description: a.description,
      });
      return { ok: true, disk: r.disk, message: r.message, warnings: r.warnings };
    }

    return {
      ok: false,
      error:
        "Неизвестное действие машин: " + op + ". Доступно: list, card, create, delete, start, stop, restart, serial, metrics, snapshot, delsnapshot, cleansnapshots, restoredisk, sshkey.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle("yc:iam", async (_e, args) => {
  const cfg = ycConfig();
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycIam) return { ok: false, error: "Модуль IAM не подключён к приложению (src/yc-iam.js)." };
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const account = String(a.account || a.serviceAccount || a.name || "").trim();
  try {
    if (op === "list") {
      // Один запрос вместо трёх: аккаунты, их роли и их ключи. Раньше это были
      // бы три экрана, а человеку нужен ответ «чем занят этот робот».
      const ov = await ycIam.overview(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        accounts: ov.accounts,
        rows: ov.rows,
        bindings: ov.bindings,
        useless: ov.useless.map((r) => r.account.name),
        keyless: ov.keyless.map((r) => r.account.name),
        stale: ov.stale.map((r) => r.account.name),
        neverUsed: ov.neverUsed.map((r) => r.account.name),
        lines: ov.lines,
        message: ov.message,
      };
    }

    if (op === "card") {
      const acc = await ycIam.findServiceAccount(cfg.oauth, cfg.folderId, account);
      if (!acc) return { ok: false, error: "Не нашёл сервисный аккаунт «" + account + "» в каталоге." };
      const keys = await ycIam.allKeys(cfg.oauth, acc.id).catch(() => null);
      const roles = await ycIam.bindingsFor(cfg.oauth, cfg.folderId, acc.id).catch(() => []);
      return { ok: true, account: acc, keys: keys, roles: roles, lines: ycIam.cardLines(acc, { keys, roles }) };
    }

    if (op === "keys") {
      const acc = await ycIam.resolveAccount(cfg.oauth, cfg.folderId, account);
      const keys = await ycIam.allKeys(cfg.oauth, acc.id);
      return { ok: true, account: acc, keys: keys.keys, accessKeys: keys.accessKeys, apiKeys: keys.apiKeys, authorizedKeys: keys.authorizedKeys, troubles: keys.troubles, errors: keys.errors, total: keys.total };
    }

    if (op === "roles") {
      const list = await ycIam.roles(cfg.oauth, a.filter);
      return { ok: true, roles: list, catalog: ycIam.ROLE_CATALOG, tasks: ycIam.TASKS };
    }

    if (op === "create") {
      const r = await ycIam.createServiceAccount(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.account || a.name,
        description: a.description,
        labels: a.labels,
        expiresAt: a.expiresAt,
      });
      return { ok: true, account: r.account, message: r.message, warnings: r.warnings };
    }

    if (op === "update") {
      const r = await ycIam.updateServiceAccount(cfg.oauth, {
        folderId: cfg.folderId,
        account,
        newName: a.newName,
        description: a.description,
      });
      return { ok: true, changed: r.changed, account: r.account, message: r.message };
    }

    if (op === "delete") {
      // Удаление забирает и ключи, и роли: панель обязана показать, что именно
      // перестанет работать, ДО подтверждения — поэтому модуль называет это в
      // предупреждениях, а не молча удаляет.
      const r = await ycIam.deleteServiceAccount(cfg.oauth, { folderId: cfg.folderId, account });
      return { ok: true, deleted: r.deleted, account: r.account, keys: r.keys, roles: r.roles, message: r.message, warnings: r.warnings };
    }

    if (op === "grant" || op === "revoke") {
      const fn = op === "grant" ? ycIam.grantRole : ycIam.revokeRole;
      const r = await fn(cfg.oauth, { folderId: cfg.folderId, account, role: a.role });
      return { ok: true, changed: r.changed, account: r.account, role: r.role, roles: r.roles, message: r.message, warnings: r.warnings };
    }

    if (op === "newkey") {
      const kind = String(a.kind || a.type || "access").trim().toLowerCase();
      const opts = {
        folderId: cfg.folderId,
        account,
        description: a.description,
        expiresAt: a.expiresAt,
        scopes: a.scopes,
        algorithm: a.algorithm,
      };
      const r = kind === "api" ? await ycIam.createApiKey(cfg.oauth, opts) : kind === "authorized" || kind === "key" ? await ycIam.createAuthorizedKey(cfg.oauth, opts) : await ycIam.createAccessKey(cfg.oauth, opts);
      // Секрет отдаётся наружу РОВНО здесь и никогда больше: панель обязана
      // показать его человеку сразу и сохранить, второго раза не будет.
      return { ok: true, kind, account: r.account, key: r.key, secret: r.secret || r.privateKey || "", message: r.message, warnings: r.warnings };
    }

    if (op === "delkey") {
      let keyId = String(a.keyId || a.id || "").trim();
      if (!keyId) return { ok: false, error: "Не указан id ключа (keyId)." };
      // В списке ключей рядом с id видно и keyId: если назван аккаунт, приводим
      // ссылку к тому id, который принимает API.
      if (account) {
        const acc = await ycIam.resolveAccount(cfg.oauth, cfg.folderId, account);
        const keys = await ycIam.allKeys(cfg.oauth, acc.id);
        const found = keys.keys.find((x) => x.id === keyId || x.keyId === keyId) || null;
        if (found) keyId = found.id;
      }
      const r = await ycIam.deleteKeyByKind(cfg.oauth, a.kind || a.type, keyId);
      return { ok: true, deleted: true, keyId, message: r.message };
    }

    return {
      ok: false,
      error: "Неизвестное действие IAM: " + op + ". Доступно: list, card, keys, roles, create, update, delete, grant, revoke, newkey, delkey.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:functions", async (_e, args) => {
  const cfg = ycConfig();
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycFunctions) return { ok: false, error: "Модуль Cloud Functions не подключён к приложению (src/yc-functions.js)." };
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ref = a.function || a.name || a.id || "";
  try {
    if (op === "list") {
      // Один запрос вместо трёх: функции, их версии и их публичность. Человеку
      // нужен ответ «что тут есть и что с этим не так», а не три экрана.
      const ov = await ycFunctions.overview(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        functions: ov.functions,
        rows: ov.rows,
        broken: ov.broken.map((r) => r.function.name),
        untagged: ov.untagged.map((r) => r.function.name),
        public: ov.public.map((r) => r.function.name),
        lines: ov.lines,
        message: ov.message,
      };
    }

    if (op === "runtimes") {
      return { ok: true, runtimes: await ycFunctions.runtimes(cfg.oauth), hint: ycFunctions.RUNTIMES_HINT };
    }

    if (op === "card") {
      const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
      if (!fn) return { ok: false, error: "Не нашёл функцию «" + ref + "» в каталоге." };
      const vers = await ycFunctions.versions(cfg.oauth, fn.id).catch(() => []);
      const binds = await ycFunctions.accessBindings(cfg.oauth, fn.id).catch(() => []);
      const isPublic = ycFunctions.isPublic(binds);
      return {
        ok: true,
        function: fn,
        versions: vers,
        active: ycFunctions.activeVersion(vers),
        public: isPublic,
        url: await ycFunctions.invokeUrlOf(cfg.oauth, fn),
        lines: ycFunctions.cardLines(fn, { versions: vers, public: isPublic }),
      };
    }

    if (op === "versions") {
      const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
      if (!fn) return { ok: false, error: "Не нашёл функцию «" + ref + "» в каталоге." };
      const vers = await ycFunctions.versions(cfg.oauth, fn.id);
      return { ok: true, function: fn, versions: vers, active: ycFunctions.activeVersion(vers) };
    }

    if (op === "create") {
      const r = await ycFunctions.createFunction(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        description: a.description,
        labels: a.labels,
      });
      return { ok: true, function: r.function, message: r.message, warnings: r.warnings };
    }

    if (op === "update") {
      const r = await ycFunctions.updateFunction(cfg.oauth, {
        folderId: cfg.folderId,
        function: ref,
        newName: a.newName,
        description: a.description,
        labels: a.labels,
      });
      return { ok: true, changed: r.changed, function: r.function, message: r.message };
    }

    if (op === "deploy") {
      // Выкатка версии — единственный способ поменять код: версия неизменяема.
      const r = await ycFunctions.createVersion(cfg.oauth, {
        folderId: cfg.folderId,
        function: ref,
        runtime: a.runtime,
        entrypoint: a.entrypoint || a.handler,
        memoryMb: a.memoryMb != null ? a.memoryMb : a.memory,
        timeoutSec: a.timeoutSec != null ? a.timeoutSec : a.timeout,
        environment: a.environment || a.env,
        tag: a.tag,
        description: a.description,
        serviceAccountId: a.serviceAccountId,
        zipFile: a.zipFile,
        contentBase64: a.contentBase64,
        sourceVersionId: a.sourceVersionId,
        package: a.package,
        networkId: a.networkId,
        concurrency: a.concurrency,
        secrets: a.secrets,
      });
      return {
        ok: true,
        function: r.function,
        version: r.version,
        source: r.source,
        memoryMb: r.memoryMb,
        timeoutSec: r.timeoutSec,
        runtime: r.runtime,
        message: r.message,
        warnings: r.warnings,
      };
    }

    if (op === "invoke") {
      const r = await ycFunctions.invoke(cfg.oauth, {
        folderId: cfg.folderId,
        function: ref,
        tag: a.tag,
        payload: a.payload,
        timeoutMs: a.timeoutMs,
      });
      return {
        ok: r.ok,
        function: r.function,
        tag: r.tag,
        url: r.url,
        status: r.status,
        ms: r.ms,
        text: r.text,
        truncated: r.truncated,
        json: r.json,
        hint: r.hint,
        message: r.message,
      };
    }

    if (op === "tag" || op === "untag") {
      const r = await ycFunctions.setTag(cfg.oauth, {
        folderId: cfg.folderId,
        function: ref,
        version: a.version || a.versionId,
        tag: a.tag,
        remove: op === "untag",
      });
      return { ok: true, changed: r.changed, function: r.function, version: r.version, tag: r.tag, url: r.url, message: r.message, warnings: r.warnings };
    }

    if (op === "delversion") {
      const r = await ycFunctions.deleteVersion(cfg.oauth, { folderId: cfg.folderId, function: ref, version: a.version || a.versionId });
      return { ok: true, deleted: true, function: r.function, version: r.version, message: r.message, warnings: r.warnings };
    }

    if (op === "delete") {
      const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
      if (!fn) return { ok: false, error: "Не нашёл функцию «" + ref + "» в каталоге." };
      // Удаление необратимо и забирает ВСЕ версии: сначала показываем, что уйдёт.
      if (a.confirmed !== true) {
        const vers = await ycFunctions.versions(cfg.oauth, fn.id).catch(() => []);
        const binds = await ycFunctions.accessBindings(cfg.oauth, fn.id).catch(() => []);
        return {
          ok: false,
          needsConfirm: true,
          function: fn,
          versions: vers,
          public: ycFunctions.isPublic(binds),
          error:
            "Удаление функции «" + fn.name + "» необратимо: вместе с ней уйдут её версии" + (vers.length ? " (" + vers.length + ")" : "") +
            (ycFunctions.isPublic(binds) ? ", а публичный адрес перестанет работать у всех, кто им пользовался" : "") + ". Подтверди удаление.",
        };
      }
      const r = await ycFunctions.deleteFunction(cfg.oauth, { folderId: cfg.folderId, function: fn });
      return { ok: true, deleted: true, function: r.function, versions: r.versions, wasPublic: r.wasPublic, message: r.message, warnings: r.warnings };
    }

    if (op === "public" || op === "private") {
      const r = await ycFunctions.setPublic(cfg.oauth, { folderId: cfg.folderId, function: ref, tag: a.tag, on: op === "public" });
      return { ok: true, changed: r.changed, function: r.function, public: r.public, url: r.url, bindings: r.bindings, message: r.message, warnings: r.warnings };
    }

    if (op === "access") {
      const fn = await ycFunctions.findFunction(cfg.oauth, cfg.folderId, ref);
      if (!fn) return { ok: false, error: "Не нашёл функцию «" + ref + "» в каталоге." };
      const binds = await ycFunctions.accessBindings(cfg.oauth, fn.id);
      return { ok: true, function: fn, bindings: binds, public: ycFunctions.isPublic(binds) };
    }

    return {
      ok: false,
      error:
        "Неизвестное действие функций: " + op + ". Доступно: list, card, versions, runtimes, create, update, deploy, invoke, tag, untag, delversion, delete, public, private, access.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Биллинг: платёжные аккаунты, пороги-бюджеты, живой каталог цен и «платные
// хвосты». Канал только ЧИТАЕТ — и это не упущение: в Billing API изменяющих
// методов про деньги нет вовсе (аккаунты, бюджеты, услуги, SKU).
ipcMain.handle("yc:billing", async (_e, args) => {
  const cfg = ycConfig();
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках." };
  if (!ycBilling) return { ok: false, error: "Модуль биллинга не подключён к приложению (src/yc-billing.js)." };
  const a = args || {};
  const op = String(a.op || a.action || "overview").trim().toLowerCase();
  try {
    if (op === "accounts") {
      const list = await ycBilling.accounts(cfg.oauth);
      return {
        ok: true,
        accounts: list,
        lines: list.length ? [].concat.apply([], list.map(ycBilling.accountLines)) : ["Платёжных аккаунтов нет: облако не привязано к счёту."],
      };
    }

    if (op === "account") {
      return { ok: true, account: await ycBilling.findAccount(cfg.oauth, a.account) };
    }

    if (op === "services") {
      return { ok: true, services: await ycBilling.services(cfg.oauth) };
    }

    if (op === "price") {
      const r = await ycBilling.priceSearch(cfg.oauth, {
        query: a.query || a.what,
        currency: a.currency,
        serviceId: a.serviceId,
        billingAccountId: a.account,
      });
      return { ok: true, query: r.query, currency: r.currency, skus: r.skus, lines: r.lines, message: r.message };
    }

    if (op === "budgets") {
      const acc = await ycBilling.findAccount(cfg.oauth, a.account);
      const list = await ycBilling.budgets(cfg.oauth, acc.id);
      return { ok: true, account: acc, budgets: list, lines: list.length ? [].concat.apply([], list.map(ycBilling.budgetLines)) : ["Порогов-бюджетов нет."] };
    }

    if (op === "leaks") {
      if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder) — без него не видно, за что платят." };
      const l = await ycBilling.leaks(cfg.oauth, cfg.folderId);
      return { ok: true, folderId: l.folderId, tails: l.tails, running: l.running, total: l.total, live: l.live, count: l.count, lines: l.lines, message: l.message };
    }

    if (op === "overview") {
      const ov = await ycBilling.overview(cfg.oauth, cfg.folderId, { account: a.account, currency: a.currency });
      return {
        ok: true,
        accounts: ov.accounts,
        account: ov.account,
        budgets: ov.budgets,
        troubles: ov.troubles,
        billingError: ov.billingError,
        leaks: ov.leaks ? { count: ov.leaks.count, total: ov.leaks.total, live: ov.leaks.live, tails: ov.leaks.tails, running: ov.leaks.running } : null,
        lines: ov.lines,
        message: ov.message,
      };
    }

    return {
      ok: false,
      error: "Неизвестное действие биллинга: " + op + ". Доступно: overview, accounts, account, budgets, price, services, leaks.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
// HTTPS-сайт: сертификаты Certificate Manager и ресурсы Cloud CDN. Канал на
// РАЗДЕЛ, а не на каждое действие (как yc:vpc и yc:compute): у сертификата и
// ресурса вместе больше двадцати действий, и канал на каждое вернул бы ровно
// тот рост, из-за которого каналы когда-то расползлись по оболочке. Тела
// запросов живут в модуле src/yc-cdn.js, здесь — выбор действия и отказ.
ipcMain.handle("yc:cdn", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "overview").trim().toLowerCase();
  if (!ycCdn) return { ok: false, error: "Модуль сертификатов и CDN не подключён к приложению (src/yc-cdn.js)." };
  if (!cfg.oauth) {
    return {
      ok: false,
      error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»).",
      // Порядок шагов знает сам модуль: подсказку можно показать и без облака.
      hint: "HTTPS-сайт из бакета: бакет с сайтом (index.html) → бесплатный сертификат → CDN-ресурс на этот бакет → CNAME домена на адрес провайдера.",
    };
  }
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  try {
    const ref = a.certificate || a.cert || a.resource || a.cdn || a.group || a.id || a.name || a.cname || a.domain || "";

    if (op === "overview") {
      const certs = await ycCdn.certOverview(cfg.oauth, cfg.folderId);
      const cdn = await ycCdn.cdnOverview(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        folder: { id: cfg.folderId, name: cfg.folderName },
        certificates: certs.certificates,
        resources: cdn.resources,
        awaiting: certs.awaiting,
        withoutSsl: cdn.withoutSsl,
        notReady: cdn.notReady,
        monthly: cdn.monthly,
        lines: ["Сертификаты (" + certs.certificates.length + ")"].concat(certs.lines, [""], ["CDN-ресурсы (" + cdn.resources.length + ")"], cdn.lines),
        message: "Сертификатов: " + certs.certificates.length + ", CDN-ресурсов: " + cdn.resources.length + ".",
      };
    }

    if (op === "certs") {
      const ov = await ycCdn.certOverview(cfg.oauth, cfg.folderId);
      return { ok: true, certificates: ov.certificates, awaiting: ov.awaiting, broken: ov.broken, lines: ov.lines, message: ov.message };
    }

    if (op === "cert") {
      const c = await ycCdn.requireCertificate(cfg.oauth, cfg.folderId, ref);
      return { ok: true, certificate: c, trouble: ycCdn.certTrouble(c), plan: ycCdn.challengePlan(c), lines: ycCdn.certLines(c) };
    }

    if (op === "certnew") {
      const r = await ycCdn.requestCertificate(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        domains: a.domains || a.domain,
        challengeType: a.challengeType,
        description: a.description,
        labels: a.labels,
        deletionProtection: a.deletionProtection,
      });
      return { ok: true, certificate: r.certificate, challengeType: r.challengeType, plan: r.plan, warnings: r.warnings, lines: r.lines, message: r.message };
    }

    if (op === "certimport") {
      const r = await ycCdn.importCertificate(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        certificate: a.certificateText || a.pem,
        chain: a.chain,
        privateKey: a.privateKey || a.key,
        description: a.description,
      });
      return { ok: true, certificate: r.certificate, warnings: r.warnings, lines: r.lines, message: r.message };
    }

    if (op === "certupdate") {
      const r = await ycCdn.updateCertificate(cfg.oauth, {
        folderId: cfg.folderId,
        certificate: ref,
        newName: a.newName,
        description: a.description,
        labels: a.labels,
        deletionProtection: a.deletionProtection,
      });
      return { ok: true, changed: r.changed, certificate: r.certificate, message: r.message };
    }

    if (op === "certdel") {
      const r = await ycCdn.deleteCertificate(cfg.oauth, { folderId: cfg.folderId, certificate: ref, confirm: a.confirm === true });
      return { ok: true, deleted: r.deleted, needsConfirm: r.needsConfirm === true, certificate: r.certificate, usedBy: r.usedBy || [], warnings: r.warnings || [], message: r.message };
    }

    if (op === "cdn" || op === "cdnlist") {
      const ov = await ycCdn.cdnOverview(cfg.oauth, cfg.folderId);
      return { ok: true, resources: ov.resources, withoutSsl: ov.withoutSsl, notReady: ov.notReady, off: ov.off, monthly: ov.monthly, lines: ov.lines, message: ov.message };
    }

    if (op === "cdninfo") {
      const r = await ycCdn.requireResource(cfg.oauth, cfg.folderId, ref);
      return { ok: true, resource: r, trouble: ycCdn.cdnTrouble(r), lines: ycCdn.cdnLines(r) };
    }

    if (op === "cdncreate") {
      const r = await ycCdn.createResource(cfg.oauth, {
        folderId: cfg.folderId,
        cname: a.cname || a.domain,
        bucket: a.bucket || a.bucketName,
        originGroupId: a.originGroupId,
        certificate: a.certificate || a.certificateId || a.sslCertificateId,
        secondaryHostnames: a.secondaryHostnames || a.altDomains,
        website: a.website,
        originProtocol: a.originProtocol,
        active: a.active,
        options: a.options,
        labels: a.labels,
        confirm: a.confirm === true,
      });
      return { ok: true, created: r.created, needsConfirm: r.needsConfirm === true, price: r.price, resource: r.resource, warnings: r.warnings || [], lines: r.lines || [], message: r.message };
    }

    if (op === "cdnupdate") {
      const r = await ycCdn.updateResource(cfg.oauth, {
        folderId: cfg.folderId,
        resource: ref,
        certificate: a.certificate || a.certificateId || a.sslCertificateId,
        disableSsl: a.disableSsl === true,
        originGroupId: a.originGroupId,
        secondaryHostnames: a.secondaryHostnames || a.altDomains,
        active: a.active,
        originProtocol: a.originProtocol,
        options: a.options,
        labels: a.labels,
        cname: a.cname,
      });
      return { ok: true, changed: r.changed, resource: r.resource, warnings: r.warnings || [], lines: r.lines || [], message: r.message };
    }

    if (op === "cdnpurge") {
      const r = await ycCdn.purgeCache(cfg.oauth, {
        folderId: cfg.folderId,
        resource: ref,
        paths: a.paths || a.path,
        all: a.all === true || a.full === true,
      });
      return { ok: true, purged: r.purged, resource: r.resource, paths: r.paths, full: r.full, warnings: r.warnings, message: r.message };
    }

    if (op === "cdndel") {
      const r = await ycCdn.deleteResource(cfg.oauth, { folderId: cfg.folderId, resource: ref, confirm: a.confirm === true });
      return { ok: true, deleted: r.deleted, needsConfirm: r.needsConfirm === true, resource: r.resource, warnings: r.warnings || [], message: r.message };
    }

    if (op === "origins") {
      const groups = await ycCdn.originGroups(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        groups,
        lines: groups.length
          ? groups.map((g) => g.name + " — источников: " + g.origins.length + " (" + g.origins.map((o) => o.human).join("; ") + ") · id " + g.id)
          : ["Групп источников в каталоге нет. Проще всего создать ресурс сразу с bucket — группу облако сделает само."],
      };
    }

    if (op === "origincreate") {
      const r = await ycCdn.createOriginGroup(cfg.oauth, { folderId: cfg.folderId, name: a.name, origins: a.origins || a.source || a.bucket, useNext: a.useNext });
      return { ok: true, group: r.group, warnings: r.warnings, message: r.message };
    }

    if (op === "originupdate") {
      const r = await ycCdn.updateOriginGroup(cfg.oauth, {
        folderId: cfg.folderId,
        group: ref,
        newName: a.newName,
        origins: a.origins,
        useNext: a.useNext,
      });
      return { ok: true, changed: r.changed, group: r.group, warnings: r.warnings || [], message: r.message };
    }

    if (op === "origindel") {
      const r = await ycCdn.deleteOriginGroup(cfg.oauth, { folderId: cfg.folderId, group: ref, confirm: a.confirm === true, force: a.force === true });
      return { ok: true, deleted: r.deleted, needsConfirm: r.needsConfirm === true, group: r.group, usedBy: r.usedBy || [], warnings: r.warnings || [], message: r.message };
    }

    return {
      ok: false,
      error:
        "Неизвестное действие: " + op + ". Доступно: overview, certs, cert, certnew, certimport, certupdate, certdel, cdn, cdnlist, cdninfo, cdncreate, cdnupdate, cdnpurge, cdndel, origins, origincreate, originupdate, origindel.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Monitoring: метрики каталога ────────────────────────────────────────────
// Публичный справочник API у Monitoring знает ДВА ресурса — данные метрик
// (MetricsData) и их метаданные (MetricsMeta). Алертов в нём нет: следить за
// порогом из приложения пока нечем, и кнопки «создать алерт» здесь поэтому тоже
// нет — обещать то, за чем ничего нет, хуже, чем не обещать.
ipcMain.handle("yc:monitoring", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "overview").trim().toLowerCase();
  if (!ycMonitoring) return { ok: false, error: "Модуль метрик не подключён к приложению (src/yc-monitoring.js)." };
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  try {
    const resource = a.resource || a.resourceId || a.id || "";
    if (op === "overview" || op === "names") {
      const selectors = op === "names" ? ycMonitoring.selectorFor({ service: a.service, resource_id: resource }) : String(a.selectors || "");
      const r = await ycMonitoring.listMetrics(cfg.oauth, { folderId: cfg.folderId, selectors: selectors, limit: a.limit });
      const lines = ycMonitoring.linesNames(r);
      return {
        ok: true,
        names: r.names,
        total: r.total,
        namesTotal: r.namesTotal,
        selectors: r.selectors,
        lines: lines.length
          ? lines
          : ["Метрик не нашлось." + (selectors ? " По селектору " + selectors + "." : " В каталоге нет ни одной метрики — облако наполняет их, только когда ресурсы что-то делают.")],
        message: "Метрик-имён: " + r.namesTotal + ", рядов (имя + набор меток): " + r.total + ".",
      };
    }
    if (op === "metrics") {
      const query = String(a.query || "").trim() || ycMonitoring.queryFor(a.metric, { service: a.service, resource_id: resource });
      const rows = await ycMonitoring.readMetrics(cfg.oauth, {
        folderId: cfg.folderId,
        query: query,
        minutes: a.minutes,
        maxPoints: a.maxPoints,
        aggregation: a.aggregation,
        gapFilling: a.gapFilling,
      });
      const minutes = Number(a.minutes) > 0 ? Number(a.minutes) : 60;
      return {
        ok: true,
        metrics: rows,
        query: query,
        minutes: minutes,
        lines: ycMonitoring.linesMetrics(rows, { minutes: minutes }),
        message: "Метрик прочитано: " + rows.filter((r) => !r.error && r.summary && r.summary.count).length + " из " + rows.length + ".",
      };
    }
    return {
      ok: false,
      error: "Неизвестное действие метрик: " + op + ". Доступно: overview, names, metrics.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Яндекс AI из интерфейса: перевод, снимок и речь ─────────────────────────
// Тела запросов живут в src/yc-ai.js — ТОМ ЖЕ модуле, что у агента: сервис один,
// а окно и модель лишь два его вызывающих. Здесь выбор действия, разбор списков
// (несколько языков, снимков, голосов), чтение и запись файлов и отказы. Звук
// возвращается ЕЩЁ И СОДЕРЖИМЫМ (base64): синтез отдаёт речь телом ответа, и без
// этого послушать её из окна было бы нечем — а «озвучить» без «послушать» это
// половина действия. Токен и каталог те же, что у всего облака: отдельного ключа
// API человеку заводить не нужно (он бы стал вторым секретом ради тех же служб).
ipcMain.handle("yc:ai", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "languages").trim().toLowerCase();
  const ALL = ["translate", "languages", "detect", "ocr", "voices", "speak", "listen", "models", "tokens", "complete", "embed"];
  if (!ycAi) return { ok: false, error: "Модуль Яндекс AI не подключён к приложению (src/yc-ai.js)." };
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  // Списки в форме пишут строкой: «en, de», по одному в строке или через «;» —
  // разбираем все три способа, чтобы человеку не пришлось угадывать формат.
  const asList = (v) => String(v == null ? "" : v).split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
  const kb = (n) => (n >= 1048576 ? Math.round((n / 1048576) * 10) / 10 + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ");
  // Русская форма счётного слова: «2 языка», а не «2 языков» — сообщение об
  // ошибке читают люди, и кривой счёт в нём выглядит как поломка.
  const plural = (n, one, few, many) => {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  };
  // Файлы читаются только там, где есть доступ к диску (окно на ПК): мост
  // телефона канал не открывает, а проверка стоит ДО попытки чтения.
  const withFiles = !!(fs && nodePath && typeof resolvePath === "function" && typeof agentWorkDir === "function");
  try {
    // ── Справочники (не тарифицируются) ──
    if (op === "languages") {
      const langs = await ycAi.listLanguages(cfg.oauth, cfg.folderId);
      if (!langs.length) {
        return { ok: true, languages: [], lines: ["Облако не отдало список языков перевода (пустой ответ) — проверь каталог и токен."], message: "Языков: 0." };
      }
      const show = langs.slice(0, 80);
      return {
        ok: true,
        languages: langs,
        lines: show.map((l) => l.code + " — " + l.name).concat(langs.length > show.length ? ["…и ещё " + (langs.length - show.length) + ": код языка можно вписать и вручную."] : []),
        message: "Языков перевода: " + langs.length + ".",
        warnings: ["Перевод платный: каждый целевой язык — отдельный запрос к облаку."],
      };
    }
    if (op === "voices") {
      const r = await ycAi.listVoices(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        voices: r.voices,
        lines: r.voices.map((v) => v.id + (v.lang ? " — " + v.lang : "") + (v.who && v.who !== v.id ? " · " + v.who : "")),
        message: "Голоса " + (r.fromCloud ? "из облака" : "проверенные: облако список не отдало") + ": " + r.voices.length + ".",
        warnings: ["Синтез речи платный: тарифицируется по длине звука, каждый голос — отдельный запрос."],
      };
    }
    // ── AI Studio: модели каталога и ответ модели ──
    // Модели — списком из облака (Models API), ответ — синхронным порождением
    // текста; токены считаются БЕСПЛАТНО и до запроса, а вектор — для поиска
    // по смыслу. Тариф называет модуль: у каждой модели своя цена за токены.
    if (op === "models") {
      const r = await ycAi.listModels(cfg.oauth, cfg.folderId);
      const lines = r.models.map((m) => m.id + (m.kind ? " — " + m.kind : "") + (m.who ? " · " + m.who : ""));
      if (!lines.length) lines.push("Облако не отдало список моделей — попробуй позже.");
      return {
        ok: true,
        models: r.models,
        lines: lines,
        message: "Моделей: " + r.models.length + (r.fromCloud ? " (список облака)." : " (проверенные; облако список не отдало)."),
        warnings: ["Ответ модели тарифицируется по токенам — тариф называет действие «Спросить модель» до отправки; токенизация бесплатна."],
      };
    }
    if (op === "tokens") {
      const text = String(a.text || a.prompt || "").trim();
      if (!text) return { ok: false, error: "Впиши текст — посчитаем токены. Это бесплатно и помогает понять цену ответа до запроса." };
      const model = String(a.model || "").trim() || "yandexgpt-5-lite";
      const r = await ycAi.tokenize(cfg.oauth, { text: text, model: model, folderId: cfg.folderId });
      return {
        ok: true,
        tokens: r.count,
        lines: [
          "Токенов: " + r.count + " (модель " + ycAi.modelNameOf(r.modelUri) + ")",
          "Первые токены: " + (r.first.length ? r.first.join(" · ") : "—"),
        ],
        message: "Токенов: " + r.count + ".",
        warnings: ["Токенизация бесплатна. Ориентир цены ответа: " + ycAi.aiPriceLine(r.modelUri)],
      };
    }
    if (op === "complete") {
      const prompt = String(a.prompt || a.text || "").trim();
      if (!prompt) return { ok: false, error: "Впиши запрос (prompt) — текст, на который отвечает модель." };
      const model = String(a.model || "").trim() || "yandexgpt-5-lite";
      const r = await ycAi.complete(cfg.oauth, { prompt: prompt, system: a.system, model: model, temperature: a.temperature, maxTokens: a.maxTokens, folderId: cfg.folderId });
      const tail = r.usage.total ? "Токенов: вход " + r.usage.input + ", ответ " + r.usage.output + (r.modelVersion ? " · версия модели " + r.modelVersion : "") : "Облако не назвало число токенов.";
      const cost = ycAi.aiCostText(r.modelUri, r.usage);
      const lines = [r.text, "—", tail + (cost ? " · " + cost : "")];
      return {
        ok: true,
        answer: r.text,
        usage: r.usage,
        modelUri: r.modelUri,
        lines: lines,
        message: "Ответ модели " + ycAi.modelNameOf(r.modelUri) + " готов.",
        warnings: ["Ответ тарифицируется по токенам: " + ycAi.aiPriceLine(r.modelUri)],
      };
    }
    if (op === "embed") {
      const text = String(a.text || "").trim();
      if (!text) return { ok: false, error: "Впиши текст — получим его вектор (для поиска и сравнения по смыслу)." };
      const model = String(a.model || "").trim() || "text-search-doc";
      const r = await ycAi.embed(cfg.oauth, { text: text, model: model, folderId: cfg.folderId });
      const head = r.vector.slice(0, 8).map((x) => String(Math.round(x * 1000) / 1000)).join(", ");
      return {
        ok: true,
        dims: r.dims,
        lines: [
          "Вектор: " + r.dims + " чисел (модель " + ycAi.modelNameOf(r.modelUri) + ")",
          "Первые числа: " + head + ", …",
        ],
        message: "Вектор готов: " + r.dims + " чисел.",
        warnings: ["Векторизация платная: " + ycAi.aiPriceLine(r.modelUri)],
      };
    }
    // ── Язык текста ──
    if (op === "detect") {
      const text = String(a.text || "").trim();
      if (!text) return { ok: false, error: "Впиши текст — облако определит его язык." };
      const lang = await ycAi.detectLanguage(cfg.oauth, { texts: [text], folderId: cfg.folderId });
      return {
        ok: true,
        language: lang,
        lines: [lang ? "Язык текста: " + lang + " (" + text.length + " символов)" : "Облако не назвало язык — попробуй более длинный отрывок текста."],
        message: lang ? "Язык определён: " + lang + "." : "Язык не определён.",
      };
    }
    // ── Перевод ──
    if (op === "translate") {
      const text = String(a.text || "").trim();
      if (!text) return { ok: false, error: "Впиши текст для перевода." };
      const targets = asList(a.targets || a.target).map((t) => t.toUpperCase());
      if (!targets.length) return { ok: false, error: "Укажи языки перевода: en, de, zh — можно несколько сразу (через запятую)." };
      const source = String(a.source || "").trim();
      const list = await ycAi.translate(cfg.oauth, { texts: [text], targets: targets, source: source, folderId: cfg.folderId });
      const lines = [];
      for (const o of list) {
        lines.push("→ " + o.language + (o.detected ? " (переведено с " + o.detected + ")" : ""));
        for (const t of o.translations) lines.push("   " + (t || "—"));
      }
      return {
        ok: true,
        translations: list.map((o) => ({ language: o.language, text: o.translations[0] || "" })),
        lines: lines,
        message: "Переведено на " + list.length + " " + plural(list.length, "язык", "языка", "языков") + (list.length > 1 ? " — это " + list.length + " запроса" : "") + ".",
        warnings: ["Перевод платный: каждый целевой язык облако считает отдельным запросом."],
      };
    }
    // ── Текст со снимка (Vision OCR) ──
    if (op === "ocr") {
      const files = asList(a.files || a.file);
      if (!files.length) return { ok: false, error: "Впиши путь к снимку или PDF (несколько — по одному в строке)." };
      if (!withFiles) return { ok: false, error: "Чтение файлов работает в приложении на ПК." };
      const langs = asList(a.langs || a.languageCodes);
      const model = String(a.model || "page").trim().toLowerCase();
      const parts = [];
      for (const f of files) {
        const p = resolvePath(f, loadSettings());
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, error: "Файла «" + f + "» нет. Проверь путь: " + p };
        const size = fs.statSync(p).size;
        // Vision принимает до 10 МБ на снимок: отказ ДО запроса понятнее, чем
        // ответ сервиса «файл слишком большой» после отправки.
        if (size > 10 * 1048576) return { ok: false, error: "Файл «" + f + "» — " + kb(size) + ", а распознавание принимает до 10 МБ." };
        const mimeType = ycAi.mimeForExt(nodePath.extname(p));
        if (!mimeType) return { ok: false, error: "Не понял тип файла «" + f + "» («" + (nodePath.extname(p) || "без расширения") + "»). Vision принимает jpg, jpeg, png, bmp, tiff, pdf." };
        const r = await ycAi.recognizeText(cfg.oauth, { content: fs.readFileSync(p).toString("base64"), mimeType: mimeType, languageCodes: langs, model: model, folderId: cfg.folderId });
        parts.push({ file: f, mimeType: mimeType, size: size, text: r.text || "" });
      }
      const lines = [];
      for (const part of parts) {
        lines.push("── " + part.file + " · " + part.mimeType + " · " + kb(part.size));
        if (part.text) lines.push(part.text.length > 4000 ? part.text.slice(0, 4000) + "… (всего " + part.text.length + " символов)" : part.text);
        else lines.push("(текста не нашлось — проверь языки; для рукописного подойдёт модель handwritten)");
      }
      return {
        ok: true,
        texts: parts,
        lines: lines,
        message: "Распознано файлов: " + parts.length + " · модель " + model + (langs.length ? " · языки " + langs.join(", ") : ""),
        warnings: ["Vision платный: тарифицируется по объёму картинки."],
      };
    }
    // ── Речь из текста (SpeechKit) ──
    if (op === "speak") {
      const text = String(a.text || "").trim();
      if (!text) return { ok: false, error: "Впиши текст, который озвучить." };
      if (!withFiles) return { ok: false, error: "Запись файлов работает в приложении на ПК." };
      const want = asList(a.voices || a.voice);
      if (!want.length) want.push("alena");
      const format = String(a.format || "mp3").trim().toLowerCase();
      const lang = String(a.lang || "ru-RU").trim();
      const ext = format === "oggopus" ? "ogg" : format;
      const outDir = agentWorkDir(loadSettings());
      fs.mkdirSync(outDir, { recursive: true });
      const made = [];
      let inlined = 0; // сколько звука уже отдано окну содержимым
      for (const voice of want) {
        const r = await ycAi.synthesize(cfg.oauth, { text: text, voice: voice, lang: lang, format: format, speed: a.speed, emotion: a.emotion, sampleRateHertz: a.sampleRateHertz, folderId: cfg.folderId });
        const p = nodePath.join(outDir, "ai-speech-" + String(voice).replace(/[^\w.-]/g, "") + "-" + Date.now() + "." + ext);
        fs.writeFileSync(p, r.audio);
        // Проигрывание прямо в окне: содержимое отдаём, пока звука немного
        // (6 МБ) — длинную речь слушают файлом, и об этом честно сказано строкой.
        const inline = r.audio.length + inlined <= 6 * 1048576;
        if (inline) inlined += r.audio.length;
        made.push({
          voice: voice,
          path: p,
          size: r.audio.length,
          mime: r.contentType || (format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : format === "oggopus" ? "audio/ogg" : "audio/l16"),
          base64: inline ? r.audio.toString("base64") : "",
        });
      }
      return {
        ok: true,
        audios: made.filter((m) => m.base64),
        files: made,
        lines: made.map((m) => "🔊 " + m.voice + " → " + m.path + " (" + kb(m.size) + ")" + (m.base64 ? "" : " — слушай файлом")),
        message: "Речь готова: " + made.length + " " + plural(made.length, "файл", "файла", "файлов") + ", " + text.length + " символов текста (" + lang + ", " + format + ").",
        warnings: ["SpeechKit платный: тарифицируется по длине звука, каждый голос — отдельный запрос."],
      };
    }
    // ── Текст из записи ──
    if (op === "listen") {
      const file = String(a.file || "").trim();
      if (!file) return { ok: false, error: "Впиши путь к записи (ogg/opus, mp3 или lpcm)." };
      if (!withFiles) return { ok: false, error: "Чтение файлов работает в приложении на ПК." };
      const p = resolvePath(file, loadSettings());
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, error: "Файла «" + file + "» нет. Проверь путь: " + p };
      const size = fs.statSync(p).size;
      // Синхронное распознавание берёт короткое аудио (до ~1 МБ): отказ до
      // отправки честнее ответа «файл слишком большой» после подъёма всего звука.
      if (size > 1048576) return { ok: false, error: "Запись «" + file + "» — " + kb(size) + ", а распознавание одним запросом принимает до 1 МБ (примерно минута сжатой речи)." };
      const byExt = { ogg: "oggopus", opus: "oggopus", oga: "oggopus", mp3: "mp3", pcm: "lpcm", raw: "lpcm", lpcm: "lpcm" };
      const format = String(a.format || byExt[nodePath.extname(p).replace(".", "").toLowerCase()] || "oggopus").trim().toLowerCase();
      const r = await ycAi.recognizeSpeech(cfg.oauth, { audio: fs.readFileSync(p), lang: a.lang, format: format, sampleRateHertz: a.sampleRateHertz, topic: a.topic, folderId: cfg.folderId });
      return {
        ok: true,
        text: r.text,
        lines: [r.text || "Речь распознана, а текста нет — возможно, в записи тишина или шум. Проверь формат и язык.", "── " + file + " · " + kb(size) + " · " + format + " · " + (a.lang || "ru-RU")],
        message: r.text ? "Распознано символов: " + r.text.length + "." : "Текста в записи не нашлось.",
        warnings: ["SpeechKit платный: тарифицируется по длине звука."],
      };
    }
    return { ok: false, error: "Неизвестное действие Яндекс AI: " + op + ". Доступно: " + ALL.join(", ") + "." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Managed-базы из интерфейса: PostgreSQL, MySQL и ClickHouse ──────────────
// Три базы — ОДИН канал, потому что у них один API (mdb.api.cloud.yandex.net):
// в запросе меняется только сегмент пути, и три почти одинаковых канала
// повторяли бы одно и то же трижды. Тела запросов живут в src/yc-mdb.js — ТОМ ЖЕ
// модуле, что у агента: база одна, а окно и модель лишь два её вызывающих.
//
// Пароль пользователя облако отдаёт РОВНО ОДИН РАЗ — в ответ на создание
// кластера. Поэтому create возвращает его полем secret (окно показывает его
// отдельной рамкой «сохрани сейчас»), а чтение паролей не отдаёт вовсе и не
// притворяется, что «скрывает» их: в списках пользователей только имена.
ipcMain.handle("yc:mdb", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  if (!ycMdb) return { ok: false, error: "Модуль Managed-баз не подключён к приложению (src/yc-mdb.js)." };
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  // Список действий проверяется ДО обращения к облаку: чужое действие должно
  // получить отказ со списком, а не непонятную ошибку разбора базы.
  const ALL = ["list", "card", "hosts", "databases", "users", "logs", "operations", "presets", "start", "stop", "create", "delete"];
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие Managed-баз: " + op + ". Доступно: " + ALL.join(", ") + "." };
  const engine = String(a.engine || "").trim().toLowerCase();
  const eng = ycMdb.engineOf(engine);
  const ref = a.cluster || a.clusterId || a.id || a.name || "";
  const noCluster = { ok: false, error: "Не нашёл кластер «" + ref + "» в каталоге. Список — действие «Кластеры»." };
  try {
    if (op === "list") {
      const list = await ycMdb.clusters(cfg.oauth, engine, cfg.folderId);
      return {
        ok: true,
        engine: engine,
        engineRu: eng ? eng.ru : engine,
        clusters: list,
        lines: list.length
          ? list.map((c) => ycMdb.clusterLine(c, engine))
          : ["Кластеров " + (eng ? eng.ru : engine) + " в каталоге нет. Создать — кнопкой «＋ Создать кластер» (это платно: класс тарифицируется по часам)."],
        message: "Кластеров: " + list.length + ".",
        warnings: list.some((c) => String(c.status).toUpperCase() === "STOPPED")
          ? ["Остановленный кластер дешевле, но не бесплатен: диск и резервные копии тарифицируются и у него."]
          : [],
      };
    }
    if (op === "card") {
      const r = await ycMdb.cardLines(cfg.oauth, engine, ref, { folderId: cfg.folderId, database: a.database, user: a.user });
      return {
        ok: true,
        engine: engine,
        cluster: r.cluster,
        hosts: r.hosts,
        connection: r.connection,
        lines: r.lines,
        message: "Кластер «" + r.cluster.name + "»: " + r.cluster.statusHuman + ".",
      };
    }
    if (op === "presets") {
      const list = await ycMdb.presets(cfg.oauth, engine);
      return {
        ok: true,
        engine: engine,
        presets: list,
        lines: list.length
          ? list.map((p) => p.id + " — " + (p.cores || "?") + " vCPU, " + (p.memoryHuman || "?") + (p.zoneIds.length ? " · зоны: " + p.zoneIds.join(", ") : ""))
          : ["Облако не отдало список классов хостов."],
        message: "Классов: " + list.length + ".",
      };
    }
    if (op === "create") {
      // Платный и необратимый шаг: без явного согласия показываем, что будет
      // создано, и просим подтвердить. Цена — почасовая, её точную цифру даёт
      // каталог цен облака (действие «Цена по слову» в «Деньгах»).
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error:
            "Создание кластера " + (eng ? eng.ru : engine) + " — платное и необратимое решение: класс «" + (a.preset || "?") + "» и диск " +
            (Number(a.diskGb) > 0 ? Number(a.diskGb) : "по умолчанию") + " ГБ тарифицируются почасово, а точную цену за час покажет каталог облака " +
            "(в «Деньгах» действие «Цена по слову»). Проверь имя, каталог и подсеть, затем подтверди.",
          lines: [
            "Будет создан кластер «" + (a.name || "?") + "» в каталоге «" + (cfg.folderName || cfg.folderId) + "».",
            "Версия: " + (a.version || "?") + " · класс: " + (a.preset || "?") + " · диск: " + (Number(a.diskGb) > 0 ? Number(a.diskGb) + " ГБ" : "по умолчанию") + " · зона: " + (a.zone || ycMdb.ZONE_DEFAULT) + ".",
            "Пароль пользователя будет сгенерирован и показан ОДИН раз — сохрани его в хранилище секретов.",
          ],
        };
      }
      const r = await ycMdb.create(cfg.oauth, engine, {
        folderId: cfg.folderId,
        name: a.name,
        version: a.version,
        preset: a.preset,
        diskGb: a.diskGb,
        diskType: a.diskType,
        zone: a.zone,
        subnet: a.subnet,
        networkId: a.networkId,
        user: a.user,
        userPassword: a.userPassword,
        database: a.database,
        publicIp: a.publicIp,
      });
      return {
        ok: true,
        changed: r.changed,
        cluster: r.cluster,
        clusterId: r.clusterId,
        operationId: r.operationId,
        secret: r.secret,
        secretLabel: r.secretLabel,
        lines: [r.message],
        warnings: r.warnings || [],
        message: r.message,
      };
    }
    // Всё остальное работает с конкретным кластером: находим его по имени или id.
    const cl = await ycMdb.findCluster(cfg.oauth, engine, cfg.folderId, ref);
    if (!cl && op !== "delete") return noCluster;
    if (op === "hosts") {
      const list = await ycMdb.hosts(cfg.oauth, engine, cl.id);
      return {
        ok: true,
        hosts: list,
        lines: list.length ? list.map((h) => ycMdb.hostLine(h)) : ["Хостов не видно — это странно для кластера: проверь состояние (карточка кластера)."],
        message: "Хостов: " + list.length + ".",
      };
    }
    if (op === "databases") {
      const list = await ycMdb.databases(cfg.oauth, engine, cl.id);
      return {
        ok: true,
        databases: list,
        lines: list.length ? list.map((d) => d.name + (d.owner ? " — владелец " + d.owner : "")) : ["Баз не видно: у кластера есть только служебные."],
        message: "Баз: " + list.length + ".",
      };
    }
    if (op === "users") {
      const list = await ycMdb.users(cfg.oauth, engine, cl.id);
      return {
        ok: true,
        users: list,
        lines: list.length
          ? list.map((u) => u.name + (u.permissions.length ? " — доступ: " + u.permissions.join(", ") : ""))
          : ["Пользователей нет — в такую базу некому войти."],
        message: "Пользователей: " + list.length + ".",
        warnings: ["Пароли облако в чтении не отдаёт: видеть их нельзя ни здесь, ни в консоли. Забыт пароль — его меняют, а не «смотрят»."],
      };
    }
    if (op === "logs") {
      const r = await ycMdb.logs(cfg.oauth, engine, cl.id, { minutes: a.minutes, serviceType: a.serviceType, limit: a.limit });
      const lines = r.rows.length
        ? r.rows.map((x) => (x.timestamp ? String(x.timestamp).replace("T", " ").slice(0, 19) + "  " : "") + x.text)
        : ["За " + r.minutes + " мин записей нет — это не ошибка, а тишина в логе."];
      return { ok: true, logs: r.rows, minutes: r.minutes, lines: lines, message: "Записей: " + r.rows.length + " за " + r.minutes + " мин." };
    }
    if (op === "operations") {
      const list = await ycMdb.operations(cfg.oauth, engine, cl.id, { limit: a.limit });
      return {
        ok: true,
        operations: list,
        lines: list.length
          ? list.map((o) => (o.done ? "✓ " : "⏳ ") + String(o.createdAt || "").replace("T", " ").slice(0, 19) + " — " + (o.description || o.metadataType || o.id) + (o.error ? " · ошибка: " + o.error : ""))
          : ["Операций у кластера не видно."],
        message: "Операций: " + list.length + ".",
      };
    }
    if (op === "start" || op === "stop") {
      const r = await ycMdb.power(cfg.oauth, engine, op, cl, {});
      return {
        ok: true,
        changed: r.changed,
        action: r.action || op,
        cluster: r.cluster,
        operationId: r.operationId,
        lines: [r.message],
        warnings: r.warnings || [],
        message: r.message,
      };
    }
    if (op === "delete") {
      if (a.confirm !== true) {
        const target = cl || (await ycMdb.findCluster(cfg.oauth, engine, cfg.folderId, ref));
        if (!target) return noCluster;
        return {
          ok: false,
          needsConfirm: true,
          error:
            "Удаление кластера «" + target.name + "» НЕОБРАТИМО: вместе с кластером уйдут его базы и резервные копии — восстановить данные будет не из чего. " +
            "Если данные ещё нужны, сначала сделай копию.",
          lines: ["Кластер: " + target.name + " · " + (eng ? eng.ru : engine) + " " + (target.version || "?") + " · состояние: " + target.statusHuman + (target.deletionProtection ? " · ВКЛЮЧЕНА защита от удаления" : "")],
        };
      }
      const target = cl || (await ycMdb.findCluster(cfg.oauth, engine, cfg.folderId, ref));
      if (!target) return noCluster;
      const r = await ycMdb.remove(cfg.oauth, engine, { clusterId: target.id });
      return {
        ok: true,
        deleted: r.deleted,
        cluster: r.cluster,
        operationId: r.operationId,
        lines: [r.message],
        warnings: r.warnings || [],
        message: r.message,
      };
    }
    return { ok: false, error: "Неизвестное действие Managed-баз: " + op + ". Доступно: " + ALL.join(", ") + "." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── DNS-зоны и записи из интерфейса ─────────────────────────────────────────
// Записи DNS умели уже двое — агент (ycDns) и форма карточки зоны, — а у плитки
// действий не было вовсе: список зон, постановка и снятие записи прямо из окна
// были недоступны. Канал собран на ТЕХ ЖЕ функциях yandex-cloud.js, что у
// агента и карточки: строгость Cloud DNS (нельзя удалить несуществующее и
// добавить поверх существующей пары «имя+тип») разобрана там, а здесь — выбор
// действия, подтверждение и ответ словами. Разрешения агента (allowCreate и
// allowDelete) не спрашиваются: галочки ограничивают МОДЕЛЬ, а здесь действует
// человек в своём окне — так же, как у записи из карточки зоны.
// ── Группы машин (Instance Groups) ─────────────────────────────────────────
// Группа — ресурс со своей жизнью: она сама создаёт машины по шаблону, держит
// их число и пересоздаёт удалённые руками. Платят МАШИНЫ группы — как обычные
// машины, за час работы, поэтому создание спрашивает согласие, а список честно
// называет размер. Канал отдельный, а не часть «yc:compute»: у группы свой
// набор действий, и смешивать два разных ресурса в одном канале — путать их.
ipcMain.handle("yc:ig", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  if (!ycIg) return { ok: false, error: "Модуль Instance Groups не подключён к приложению (src/yc-ig.js)." };
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  const ALL = ["list", "card", "instances", "operations", "create", "start", "stop", "delete"];
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие Instance Groups: " + op + ". Доступно: " + ALL.join(", ") + "." };
  const ref = String(a.group || a.groupId || a.id || a.name || "").trim();
  const noGroup = { ok: false, error: "Не нашёл группу «" + ref + "» в каталоге. Список — действие «Группы машин»." };
  try {
    if (op === "list") {
      const list = await ycIg.groups(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        groups: list,
        lines: list.length
          ? list.map((g) => ycIg.groupLine(g))
          : ["Групп машин в каталоге нет. Создать — кнопкой «＋ Создать группу»: машины группы платят за час работы."],
        message: "Групп: " + list.length + ".",
        warnings: list.some((g) => g.runningOutdated)
          ? ["У части групп есть машины с устаревшей конфигурацией: группа пересоздаст их сама — это нормальный ход обновления."]
          : [],
      };
    }
    if (op === "create") {
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error:
            "Создание группы машин — решение с ценой: каждая машина группы платит за час работы, как обычная машина Compute Cloud, а группа сама создаёт и пересоздаёт машины. Проверь имя, размер и подсеть, затем подтверди.",
          lines: [
            "Будет создана группа «" + (a.name || "?") + "» в каталоге «" + (cfg.folderName || cfg.folderId) + "».",
            "Машин: " + (Number(a.size) > 0 ? Number(a.size) : 2) + " · на машину: " + (a.cores || 2) + " vCPU" + (a.memoryGb ? ", " + a.memoryGb + " ГБ" : "") + " · подсеть: " + (a.subnet || "?") + ".",
            "Ориентир цены — в «Деньгах»: ycCosts { service: \"compute\" } и каталог цен облака.",
          ],
        };
      }
      const r = await ycIg.create(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        subnet: a.subnet || a.subnetId,
        size: a.size,
        cores: a.cores,
        memoryGb: a.memoryGb,
        coreFraction: a.coreFraction,
        diskSizeGb: a.diskSizeGb != null ? a.diskSizeGb : a.diskGb,
        diskType: a.diskType,
        zone: a.zone,
        imageFamily: a.imageFamily || a.image,
        imageId: a.imageId,
        platformId: a.platformId || a.platform,
        publicIp: a.publicIp,
        preemptible: a.preemptible,
        securityGroups: a.securityGroups || a.securityGroupIds,
        serviceAccountId: a.serviceAccountId,
        sshPublicKey: a.sshPublicKey,
        sshUser: a.sshUser,
        description: a.description,
      });
      return {
        ok: true,
        changed: true,
        group: r.group,
        groupId: r.groupId,
        operationId: r.operationId,
        lines: [r.message],
        warnings: r.warnings || [],
        message: r.message,
      };
    }
    // Всё остальное — про конкретную группу: находим её по имени или id.
    const g = await ycIg.findGroup(cfg.oauth, cfg.folderId, ref);
    if (!g && op !== "delete") return noGroup;
    if (op === "card") {
      const c = await ycIg.card(cfg.oauth, cfg.folderId, ref);
      if (!c) return noGroup;
      const grp = c.group;
      const t = grp.template;
      const lines = [ycIg.groupLine(grp)];
      lines.push(
        "Шаблон: " + (t.platformId || "—") + " · " + (t.cores || "?") + " vCPU" +
          (t.coreFraction && t.coreFraction !== "100" ? " (" + t.coreFraction + "%)" : "") +
          (t.memoryHuman ? " · " + t.memoryHuman : "") +
          (t.diskHuman ? " · диск " + t.diskHuman + " " + (t.diskTypeId || "") : "") +
          (t.hasPublicIp ? " · с публичным адресом" : " · без публичного адреса") +
          (t.preemptible ? " · прерываемые" : "")
      );
      if (grp.targetGroupId) lines.push("Отдаёт трафик Network Load Balancer: target group " + grp.targetGroupId);
      if (grp.appTargetGroupId) lines.push("Отдаёт трафик Application Load Balancer: target group " + grp.appTargetGroupId);
      if (grp.healthChecks) lines.push("Проверок здоровья: " + grp.healthChecks);
      lines.push("Машины (" + c.instances.length + "):" + (c.instances.length ? "" : " пока нет — группа их создаёт"));
      for (const i of c.instances) lines.push("  " + ycIg.instanceLine(i));
      if (c.operations.length) {
        lines.push("Последние операции:");
        for (const o of c.operations.slice(0, 5)) lines.push("  " + (o.done ? "✓" : "…") + " " + (o.description || o.id) + (o.createdAt ? " · " + o.createdAt : ""));
      }
      return { ok: true, group: grp, instances: c.instances, operations: c.operations, lines: lines, message: "Группа «" + grp.name + "»: " + grp.statusHuman + "." };
    }
    if (op === "instances") {
      const list = await ycIg.instances(cfg.oauth, g.id);
      return {
        ok: true,
        instances: list,
        lines: list.length
          ? list.map((i) => ycIg.instanceLine(i))
          : ["Машин в группе «" + g.name + "» нет: группа их создаёт по шаблону — подожди или проверь состояние группы."],
        message: "Машин: " + list.length + ".",
      };
    }
    if (op === "operations") {
      const list = await ycIg.operations(cfg.oauth, g.id);
      return {
        ok: true,
        operations: list,
        lines: list.length
          ? list.map((o) => (o.done ? "✓" : "…") + " " + (o.description || o.id) + (o.createdAt ? " · " + o.createdAt : ""))
          : ["Операций у группы не видно."],
        message: "Операций: " + list.length + ".",
      };
    }
    if (op === "start" || op === "stop") {
      const r = await ycIg.power(cfg.oauth, op, g, { folderId: cfg.folderId });
      return { ok: true, changed: r.changed, group: r.group, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "delete") {
      const target = g || (await ycIg.findGroup(cfg.oauth, cfg.folderId, ref));
      if (!target) return noGroup;
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error:
            "Удаление группы «" + target.name + "» необратимо: она будет удалена ВМЕСТЕ с машинами" +
            (target.targetSize ? " (" + target.targetSize + " шт.)" : "") +
            " и их дисками. Снимки нужно сделать заранее. Подтверди удаление.",
          lines: [ycIg.groupLine(target)],
        };
      }
      const r = await ycIg.remove(cfg.oauth, { folderId: cfg.folderId, group: target });
      return { ok: true, changed: true, groupId: r.groupId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
  } catch (e) {
    return { ok: false, error: "Instance Groups (yc:ig, действие " + op + "): " + ((e && e.message) || String(e)) };
  }
});

ipcMain.handle("yc:alb", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  if (!ycAlb) return { ok: false, error: "Модуль Application Load Balancer не подключён к приложению (src/yc-alb.js)." };
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  const ALL = ["list", "card", "targets", "routers", "backends", "health", "targetnew", "tgupdate", "targetadd", "targetremove", "targetdel", "routernew", "routerupd", "routerdel", "backnew", "backupd", "backdel", "listeneradd", "listenerupd", "listenerdel", "lbupdate", "lbnew", "lbstart", "lbstop", "lbdel"];
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие Application Load Balancer: " + op + ". Доступно: " + ALL.join(", ") + "." };
  const ref = String(a.lb || a.id || a.name || "").trim();
  const missingLb = { ok: false, error: "Не нашёл балансировщик «" + ref + "» в каталоге. Список — действие list." };
  try {
    if (op === "list") {
      const list = await ycAlb.loadBalancers(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        loadBalancers: list,
        lines: list.length
          ? list.map((l) => ycAlb.lbLine(l))
          : ["Балансировщиков в каталоге нет. Вход в приложение собирают по шагам: группа целей → группа бэкендов → HTTP-роутер → балансировщик со слушателем."],
        message: "Балансировщиков: " + list.length + ".",
        warnings: list.some((l) => !l.active)
          ? ["Часть балансировщиков не в работе: остановленный перестаёт отвечать по адресам, но тарифицируется всё равно."]
          : [],
      };
    }
    if (op === "targets") {
      const list = await ycAlb.targetGroups(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        targetGroups: list,
        lines: list.length ? list.map((g) => ycAlb.tgLine(g)) : ["Групп целей в каталоге нет."],
        message: "Групп целей: " + list.length + ".",
        warnings: ["Группа целей знает только адрес и подсеть: ни порта, ни пути, ни проверок здоровья в ней нет — их задаёт группа бэкендов."],
      };
    }
    if (op === "routers") {
      const list = await ycAlb.httpRouters(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        httpRouters: list,
        lines: list.length ? list.map((r) => ycAlb.routerLine(r)) : ["HTTP-роутеров в каталоге нет."],
        message: "HTTP-роутеров: " + list.length + ".",
      };
    }
    if (op === "backends") {
      const list = await ycAlb.backendGroups(cfg.oauth, cfg.folderId);
      return {
        ok: true,
        backendGroups: list,
        lines: list.length ? list.map((b) => ycAlb.backendGroupLine(b)) : ["Групп бэкендов в каталоге нет: маршрут роутера обязан вести в существующую группу — создай её из группы целей действием «Создать группу бэкендов» (backnew)."],
        message: "Групп бэкендов: " + list.length + ".",
        warnings: ["Порт целей и проверки здоровья задаются в ГРУППЕ БЭКЕНДОВ, а не в группе целей: создание — backnew, а здоровье целей показывает действие health."],
      };
    }
    if (op === "health") {
      // Здоровье — у ПАРЫ «группа бэкендов + группа целей»: пара ищется у
      // балансировщика, потому что ссылки на группу целей нет ни у него, ни у
      // роутера. Группа называется полем backendGroup, когда их несколько.
      const r = await ycAlb.targetStates(cfg.oauth, {
        folderId: cfg.folderId,
        lb: ref,
        backendGroup: a.backendGroup || a.backendGroupId || a.backends,
        targetGroup: a.targetGroup || a.target || a.group,
      });
      return {
        ok: true,
        lb: r.lb,
        backendGroup: r.backendGroup,
        targetGroup: r.targetGroup,
        states: r.states,
        healthy: r.healthyCount,
        lines: r.lines,
        message: r.message,
        warnings: r.warnings || [],
      };
    }
    if (op === "card") {
      const c = await ycAlb.card(cfg.oauth, cfg.folderId, ref);
      if (!c) return missingLb;
      const lines = [ycAlb.lbLine(c.lb)];
      if (c.lb.listeners.length) {
        lines.push("Слушатели (" + c.lb.listeners.length + "):");
        for (const l of c.lb.listeners) lines.push("  " + ycAlb.listenerLine(l));
      } else {
        lines.push("Слушателей нет: балансировщик создан, но ни на одном порту не отвечает.");
      }
      // Настройки самого ресурса: доступ-логи, авто-масштаб и сдвиг зоны. Раньше
      // они молчали в карточке, хотя именно из-за них «не находится» разбор
      // запросов и растёт счёт за простой.
      const setup = [];
      setup.push(c.lb.logsDisabled
        ? "доступ-логи выключены"
        : c.lb.logGroupId
          ? "доступ-логи в группу " + c.lb.logGroupId
          : "доступ-логи не заданы (пишутся в группу каталога по умолчанию)");
      if (c.lb.autoScale) {
        setup.push("авто-масштаб: минимум " + (c.lb.autoScale.min || "2") + " единиц на зону" + (c.lb.autoScale.max === "0" ? ", без верхнего предела" : ", максимум " + (c.lb.autoScale.max || "?") + " всего"));
      }
      setup.push(c.lb.allowZonalShift ? "сдвиг зоны разрешён" : "сдвиг зоны запрещён (по умолчанию)");
      lines.push("Настройки: " + setup.join(" · ") + ".");
      for (const pair of c.listeners) {
        lines.push("Роутер «" + pair.router.name + "»:");
        for (const h of pair.router.hosts) {
          for (const rt of h.routes) {
            lines.push("  " + (h.authority.length ? "домены: " + h.authority.join(", ") : "любой домен") + " · " + (rt.pathExact ? "точный путь " + rt.pathExact : "путь " + (rt.pathPrefix || "/") + "*") + " → группа бэкендов " + (rt.backendGroupId || "—"));
          }
        }
      }
      // HTTPS-слушатели: сертификат, его состояние и срок. Без этого «сайт не
      // открывается» ищут в роутере, а причина — в истёкшем сертификате.
      if ((c.certificates || []).length) {
        lines.push("Сертификаты HTTPS-слушателей:");
        for (const x of c.certificates) lines.push("  " + ycAlb.certLine(x));
      }
      if (c.backendGroups.length) lines.push("Группы бэкендов: " + c.backendGroups.map((b) => b.name).join(", "));
      if (c.targetGroups.length) {
        lines.push("Группы целей (" + c.targetGroups.length + "):");
        for (const g of c.targetGroups) {
          lines.push("  " + ycAlb.tgLine(g));
          for (const t of g.targets) lines.push("    " + ycAlb.targetLine(t));
        }
      }
      return {
        ok: true,
        lb: c.lb,
        listeners: c.listeners,
        certificates: c.certificates || [],
        targetGroups: c.targetGroups,
        backendGroups: c.backendGroups,
        lines: lines,
        message: "Балансировщик «" + c.lb.name + "»: " + c.lb.statusHuman + ".",
        warnings: [].concat(
          c.warnings || [],
          !c.targetGroupsResolved && c.targetGroups.length
            ? ["Связь с группами целей не подтвердилась (нет групп бэкендов или маршрутов): показаны все группы целей каталога."]
            : []
        ),
      };
    }
    if (op === "targetnew") {
      const r = await ycAlb.createTargetGroup(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        ips: a.ips || a.targets,
        subnet: a.subnet || a.subnetId,
        description: a.description,
      });
      return { ok: true, changed: true, targetGroup: r.group, groupId: r.groupId, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "tgupdate") {
      // Правка группы целей — это имя и описание: состав меняют точечно
      // (targetadd/targetremove), а не правкой, где список заменяется целиком.
      const r = await ycAlb.updateTargetGroup(cfg.oauth, {
        folderId: cfg.folderId,
        group: a.group || a.targetGroup || a.id || a.name,
        newName: a.newName || a.rename,
        description: a.description != null && String(a.description).trim() !== "" ? String(a.description).trim() : undefined,
      });
      return { ok: true, changed: true, targetGroup: r.group, fields: r.fields, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "targetadd" || op === "targetremove") {
      const r = await ycAlb.changeTargets(cfg.oauth, op === "targetadd" ? "add" : "remove", {
        folderId: cfg.folderId,
        group: a.group || a.targetGroup || a.id,
        ips: a.ips || a.targets,
        subnet: a.subnet || a.subnetId,
      });
      return { ok: true, changed: true, targetGroup: r.group, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "targetdel") {
      const g = await ycAlb.findTargetGroup(cfg.oauth, cfg.folderId, a.group || a.targetGroup || a.id || a.name);
      if (!g) return { ok: false, error: "Не нашёл группу целей «" + (a.group || a.targetGroup || a.id || a.name || "") + "» в каталоге. Список — действие targets." };
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Удаление группы целей «" + g.name + "» необратимо: список из " + g.targetCount + " целей будет потерян. Сами машины не тронутся, но балансировщик перестанет знать, куда ходить. Подтверди удаление.",
          lines: [ycAlb.tgLine(g)],
        };
      }
      const r = await ycAlb.removeTargetGroup(cfg.oauth, { folderId: cfg.folderId, group: g });
      return { ok: true, changed: true, groupId: r.groupId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "routernew") {
      const r = await ycAlb.createHttpRouter(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        host: a.host || a.authority,
        pathPrefix: a.pathPrefix || a.prefix,
        pathExact: a.pathExact,
        backendGroup: a.backendGroup || a.backendGroupId,
        routeName: a.routeName,
        description: a.description,
      });
      return { ok: true, changed: true, router: r.router, routerId: r.routerId, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "routerdel") {
      const r0 = await ycAlb.findHttpRouter(cfg.oauth, cfg.folderId, a.router || a.id || a.name);
      if (!r0) return { ok: false, error: "Не нашёл HTTP-роутер «" + (a.router || a.id || a.name || "") + "» в каталоге. Список — действие routers." };
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Удаление HTTP-роутера «" + r0.name + "» необратимо: правила (" + r0.routeCount + ") будут потеряны, а слушатель, который на него смотрит, перестанет отвечать. Подтверди удаление.",
          lines: [ycAlb.routerLine(r0)],
        };
      }
      const r = await ycAlb.removeRouter(cfg.oauth, { folderId: cfg.folderId, router: r0 });
      return { ok: true, changed: true, routerId: r.routerId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "backnew") {
      const r = await ycAlb.createBackendGroup(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        kind: a.kind || a.type,
        targetGroup: a.targetGroup || a.group,
        port: a.port,
        backendName: a.backendName,
        healthPath: a.healthPath || a.healthCheckPath,
        healthService: a.healthService,
        description: a.description,
      });
      return { ok: true, changed: true, backendGroup: r.group, groupId: r.groupId, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "routerupd") {
      // Правка роутера уходит со списком виртуальных хостов ЦЕЛИКОМ: облако
      // принимает этот список только заменой, поэтому модуль читает текущий и
      // возвращает его обратно с одним изменённым местом.
      const r = await ycAlb.updateHttpRouter(cfg.oauth, {
        folderId: cfg.folderId,
        router: a.router || a.id || a.name,
        newName: a.newName || a.rename,
        description: a.description != null && String(a.description).trim() !== "" ? String(a.description).trim() : undefined,
        vhost: a.vhost || a.virtualHost,
        host: a.host != null ? a.host : a.authority,
        routeName: a.routeName || a.route,
        pathPrefix: a.pathPrefix != null || a.prefix != null ? a.pathPrefix || a.prefix : undefined,
        pathExact: a.pathExact,
        backendGroup: a.backendGroup || a.backendGroupId,
      });
      return { ok: true, changed: r.changed, router: r.router, routerId: r.routerId, fields: r.fields, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "backupd") {
      // Порт и проверки здоровья живут В бэкенде, а список бэкендов меняется
      // только целиком — поэтому правка тоже идёт заменой списка.
      const r = await ycAlb.updateBackendGroup(cfg.oauth, {
        folderId: cfg.folderId,
        group: a.group || a.backendGroup || a.id || a.name,
        newName: a.newName || a.rename,
        description: a.description != null && String(a.description).trim() !== "" ? String(a.description).trim() : undefined,
        backend: a.backend || a.backendName,
        port: a.port,
        healthPath: a.healthPath || a.healthCheckPath,
        healthService: a.healthService,
        noHealthCheck: a.noHealthCheck === true || a.dropHealthCheck === true,
        targetGroup: a.targetGroup || a.targetGroupId,
      });
      return { ok: true, changed: r.changed, backendGroup: r.group, groupId: r.groupId, fields: r.fields, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "backdel") {
      const g = await ycAlb.findBackendGroup(cfg.oauth, cfg.folderId, a.group || a.backendGroup || a.id || a.name);
      if (!g) return { ok: false, error: "Не нашёл группу бэкендов «" + (a.group || a.backendGroup || a.id || a.name || "") + "» в каталоге. Список — действие backends." };
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Удаление группы бэкендов «" + g.name + "» необратимо: проверки здоровья и настройки балансировки будут потеряны, а роутер или потоковый слушатель, который на неё смотрит, перестанет отвечать. Подтверди удаление.",
          lines: [ycAlb.backendGroupLine(g)],
        };
      }
      const r = await ycAlb.removeBackendGroup(cfg.oauth, { folderId: cfg.folderId, group: g });
      return { ok: true, changed: true, groupId: r.groupId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "listeneradd") {
      const r = await ycAlb.addListener(cfg.oauth, {
        folderId: cfg.folderId,
        lb: ref,
        listenerName: a.listenerName,
        listener: a.listener || a.kind,
        port: a.port,
        router: a.router || a.httpRouter || a.httpRouterId,
        certificate: a.certificate || a.certificateId,
        backendGroup: a.backendGroup || a.backendGroupId,
        address: a.address || a.staticAddress,
        httpToHttps: a.httpToHttps,
        sni: a.sni || a.sniHandlers,
      });
      return { ok: true, changed: true, listener: r.listener, listenerName: r.listenerName, sni: r.sni || [], lb: r.lb, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "listenerupd") {
      // Правка слушателя точечная: чего не назвали — остаётся прежним (вид,
      // порт, адрес, роутер, сертификат, домены SNI). Переименовать слушателя
      // нельзя — :updateListener опознаёт его по имени.
      const r = await ycAlb.updateListener(cfg.oauth, {
        folderId: cfg.folderId,
        lb: ref,
        listenerName: a.listenerName || a.listenerToUpdate,
        listener: a.listener || a.kind,
        port: a.port,
        router: a.router || a.httpRouter || a.httpRouterId,
        certificate: a.certificate || a.certificateId,
        backendGroup: a.backendGroup || a.backendGroupId,
        address: a.address || a.staticAddress,
        httpToHttps: a.httpToHttps,
        sni: a.sni != null || a.sniHandlers != null ? a.sni != null ? a.sni : a.sniHandlers : null,
      });
      return { ok: true, changed: true, listener: r.listener, listenerName: r.listenerName, sni: r.sni || [], fields: r.fields, lb: r.lb, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "listenerdel") {
      // Необратимое для входа: адрес и порт закрываются вместе со слушателем,
      // поэтому человека спрашивают ДО запроса.
      const lb0 = await ycAlb.findLoadBalancer(cfg.oauth, cfg.folderId, ref);
      if (!lb0) return missingLb;
      const name = String(a.listenerName || a.listener || "").trim();
      const found = lb0.listeners.find((l) => l.name === name) || null;
      if (!found) {
        return {
          ok: false,
          error: "У балансировщика «" + lb0.name + "» нет слушателя «" + name + "»." + (lb0.listeners.length ? " Слушатели: " + lb0.listeners.map((l) => l.name).join(", ") + "." : " Слушателей нет вовсе."),
        };
      }
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Слушатель «" + found.name + "» убирается с балансировщика «" + lb0.name + "»: вход по нему закроется" + (found.addresses.length ? ", адрес " + found.addresses.join(", ") + " освободится" : "") + ", а домен, который на него смотрел, перестанет открываться. Подтверди удаление.",
          lines: ["  " + ycAlb.listenerLine(found)],
        };
      }
      const r = await ycAlb.removeListener(cfg.oauth, { folderId: cfg.folderId, lb: lb0, listenerName: found.name });
      return { ok: true, changed: true, listenerName: r.listenerName, lb: r.lb, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "lbupdate") {
      // Правка самого балансировщика: имя, описание, группы безопасности,
      // доступ-логи, авто-масштаб и допуск к сдвигу зоны. Состав слушателей
      // меняют отдельными действиями — PATCH с listenerSpecs[] стёр бы всех,
      // кого нет в списке.
      const r = await ycAlb.updateLoadBalancer(cfg.oauth, {
        folderId: cfg.folderId,
        lb: ref,
        newName: a.newName || a.rename,
        description: a.description != null && String(a.description).trim() !== "" ? String(a.description).trim() : undefined,
        securityGroups: a.securityGroups || a.securityGroupIds,
        logGroup: a.logGroup || a.logs || a.logGroupId,
        noLogs: a.noLogs === true || a.disableLogs === true,
        minZoneSize: a.minZoneSize,
        maxSize: a.maxSize,
        allowZonalShift: a.allowZonalShift != null ? a.allowZonalShift : a.zonalShift,
      });
      return { ok: true, changed: true, lb: r.lb, fields: r.fields, operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "lbnew") {
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Балансировщик ПЛАТНЫЙ: ресурсные единицы и сам ресурс тарифицируются за час, даже когда трафика нет. Подтверди создание.",
          lines: [
            "Будет создан балансировщик «" + (a.name || "?") + "» в каталоге «" + (cfg.folderName || cfg.folderId) + "».",
            "Слушатель: " + (a.listener || "http") + " · порт " + (a.port || (String(a.listener || "").toLowerCase() === "https" ? 443 : 80)) + " · зона: " + (a.zone || "по подсети " + (a.subnet || "?")),
            "Ориентир цены — в «Деньгах»: ycBilling { action: \"price\", query: \"Application Load Balancer\" } и каталог цен облака.",
          ],
        };
      }
      const r = await ycAlb.createLoadBalancer(cfg.oauth, {
        folderId: cfg.folderId,
        name: a.name,
        subnet: a.subnet || a.subnetId,
        zone: a.zone || a.zoneId,
        listener: a.listener || a.kind,
        port: a.port,
        listenerName: a.listenerName,
        router: a.router || a.httpRouter || a.httpRouterId,
        certificate: a.certificate || a.certificateId,
        backendGroup: a.backendGroup || a.backendGroupId,
        address: a.address || a.staticAddress,
        securityGroups: a.securityGroups || a.securityGroupIds,
        httpToHttps: a.httpToHttps,
        sni: a.sni || a.sniHandlers,
        minZoneSize: a.minZoneSize,
        maxSize: a.maxSize,
        description: a.description,
      });
      return { ok: true, changed: true, lb: r.lb, lbId: r.lbId, sni: r.sni || [], operationId: r.operationId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "lbstart" || op === "lbstop") {
      const lb = await ycAlb.findLoadBalancer(cfg.oauth, cfg.folderId, ref);
      if (!lb) return missingLb;
      const r = await ycAlb.power(cfg.oauth, op === "lbstart" ? "start" : "stop", lb, { folderId: cfg.folderId });
      return { ok: true, changed: r.changed, lb: r.lb, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    if (op === "lbdel") {
      const lb = await ycAlb.findLoadBalancer(cfg.oauth, cfg.folderId, ref);
      if (!lb) return missingLb;
      if (a.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Удаление балансировщика «" + lb.name + "» необратимо: он уйдёт вместе со слушателями и адресами" + (lb.addresses.length ? " (" + lb.addresses.join(", ") + ")" : "") + ", а домен, который на них смотрел, перестанет открываться. Подтверди удаление.",
          lines: [ycAlb.lbLine(lb)],
        };
      }
      const r = await ycAlb.remove(cfg.oauth, { folderId: cfg.folderId, lb: lb });
      return { ok: true, changed: true, lbId: r.lbId, lines: [r.message], warnings: r.warnings || [], message: r.message };
    }
    return { ok: false, error: "Неизвестное действие Application Load Balancer: " + op + ". Доступно: " + ALL.join(", ") + "." };
  } catch (e) {
    return { ok: false, error: "Application Load Balancer (yc:alb, действие " + op + "): " + ((e && e.message) || String(e)) };
  }
});

ipcMain.handle("yc:dns", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "zones").trim().toLowerCase();
  const ALL = ["zones", "card", "records", "add", "delete"];
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие DNS: " + op + ". Доступно: " + ALL.join(", ") + "." };
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  try {
    const list = (await yandexCloud.listService(cfg.oauth, cfg.folderId, yandexCloud.serviceByKey("dns"))).items || [];
    if (op === "zones") {
      return {
        ok: true,
        zones: list,
        lines: list.length
          ? list.map((z) => yandexCloud.dnsZoneLine(z))
          : ["DNS-зон в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создать зону: кнопкой «＋ Создать» у плитки «DNS-зоны» (имя — домен без точки)."],
        message: "Зон: " + list.length + ".",
      };
    }
    const ref = String(a.zone || a.zoneId || a.id || "").trim();
    const zone = yandexCloud.findDnsZone(list, ref);
    if (!zone) {
      return {
        ok: false,
        error: "Не нашёл зону «" + ref + "»." + (list.length ? " В каталоге: " + list.map((z) => yandexCloud.dnsZoneLine(z)).join("; ") + "." : " Зон в каталоге нет."),
      };
    }
    const who = "Зона «" + zone.name + "» (" + zone.id + ")";
    if (op === "card") {
      const sets = await yandexCloud.listRecordSets(cfg.oauth, zone.id);
      const lines = [who, "Записей: " + sets.length + "."];
      if (zone.createdAt) lines.push("Создана: " + String(zone.createdAt).replace("T", " ").slice(0, 19) + ".");
      if (zone.description) lines.push("Описание: " + zone.description + ".");
      return { ok: true, zone: zone, records: sets.length, lines: lines, message: who };
    }
    if (op === "records") {
      const sets = await yandexCloud.listRecordSets(cfg.oauth, zone.id);
      const lines = [who];
      if (!sets.length) lines.push("Записей нет — в зоне только служебные NS, и API их не показывает.");
      else for (const r of sets) lines.push(yandexCloud.dnsRecordLine(r));
      return { ok: true, zone: zone, records: sets, lines: lines, message: "Записей: " + sets.length + "." };
    }
    if (op === "add") {
      // Значения человек пишет строкой в форме окна и пачкой в карточке: и
      // запятые, и уже готовый массив принимаем одинаково — иначе «1.1.1.1,
      // 2.2.2.2» уехало бы одной строкой и стало одним значением.
      const rawValues = a.values != null ? a.values : a.value != null ? a.value : a.data;
      const vals = Array.isArray(rawValues) ? rawValues : String(rawValues == null ? "" : rawValues).split(",").map((s) => s.trim()).filter(Boolean);
      const check = yandexCloud.checkDnsRecord({ name: a.name, type: a.type, ttl: a.ttl, data: vals }, zone.name);
      if (check.problems.length) return { ok: false, error: check.problems.join(" ") };
      const r = await yandexCloud.upsertRecordSet(cfg.oauth, zone.id, { name: a.name, type: a.type, ttl: a.ttl, data: vals });
      return {
        ok: true,
        zone: zone,
        record: { name: r.name, type: r.type, ttl: r.ttl, values: r.values },
        lines: [(r.replaced ? "♻ Запись заменена: " : "✅ Запись добавлена: ") + yandexCloud.dnsRecordLine(check.record), who],
        warnings: (r.warnings || []).concat(["Обновление DNS в интернете занимает от минуты до часов — сразу после добавления запись может ещё не отвечать."]),
        message: r.replaced ? "Запись заменена." : "Запись добавлена.",
      };
    }
    // Удаление: сначала называем, что именно перестанет отвечать, и просим
    // согласие — у человека остаётся шанс сохранить значения (они в строке).
    const wantName = yandexCloud.normalizeRecordSet({ name: a.name }).name;
    const wantType = String(a.type || "").trim().toUpperCase();
    if (!wantName || !wantType) return { ok: false, error: "Для удаления нужны имя и тип записи: имя — FQDN с точкой (www.example.com.), тип — например A." };
    if (a.confirm !== true) {
      const existing = (await yandexCloud.listRecordSets(cfg.oauth, zone.id)).find((r) => r.name === wantName && r.type === wantType) || null;
      if (!existing) return { ok: false, error: "В зоне нет записи " + wantName + " " + wantType + " — удалять нечего." };
      return {
        ok: false,
        needsConfirm: true,
        error: "Удаление остановит всё, что на эту запись смотрит: домен или сайт может перестать открываться, а почта — приходить. Значения перед удалением видно, вернуть запись можно, но вручную и заново.",
        lines: ["Запись: " + yandexCloud.dnsRecordLine(existing), who],
      };
    }
    const del = await yandexCloud.deleteRecordSet(cfg.oauth, zone.id, { name: a.name, type: a.type });
    return {
      ok: true,
      deleted: true,
      zone: zone,
      record: { name: del.name, type: del.type, values: del.values },
      lines: ["🗑 Запись удалена: " + del.type + " " + del.name + " (значений было " + del.values + ")", who],
      message: "Запись удалена.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Serverless Containers: правка и ревизии из окна (часть 91, заход 8) ────────
// До этого захода окно умело только список, создание пустого контейнера,
// удаление, логи и откат из карточки консоли. Новая ревизия (а с ней — образ,
// переменные окружения, ресурсы и тёплые экземпляры minInstances),
// переименование и публичный доступ жили ТОЛЬКО у агента (ycContainer). Канал
// зовёт те же функции, что агент и облачная консоль (src/yandex-cloud.js),
// поэтому поведение окна и агента — одно и то же.
//
// Про деньги. Сама ревизия не тарифицируется: платят за вызовы и за ТЁПЛЫЕ
// экземпляры (minInstances > 0), которые держат контейнер запущенным всегда.
// Поэтому «новая ревизия» не просит согласия (как «создать машину»), но честно
// предупреждает, когда тёплые экземпляры заданы, а публикация в интернет —
// необратимо-опасное действие и помечено в интерфейсе как таковое.
ipcMain.handle("yc:container", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "card", "revisions", "revision", "newrev", "rollback", "update", "public", "private"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие Serverless Containers: " + op + ". Доступно: " + ALL.join(", ") + "." };
  try {
    if (op === "list") {
      const items = (await yandexCloud.listService(cfg.oauth, cfg.folderId, yandexCloud.serviceByKey("serverlessContainers"))).items || [];
      return {
        ok: true,
        containers: items,
        lines: items.length
          ? items.map((c) => "• " + (c.name || c.id) + " — " + (c.status || "—") + (c.description ? " · " + c.description : "") + (c.url ? " · " + c.url : " · адрес вызова не показан"))
          : ["Контейнеров в каталоге нет — их можно создать кнопкой «＋ Создать» у плитки «Serverless-контейнеры»."],
        message: "Контейнеров: " + items.length + ".",
      };
    }
    const ref = String(a.container || a.id || a.name || "").trim();
    if (!ref) return { ok: false, error: "Укажи контейнер — имя или id (список: действие list)." };
    const cont = await ycFindContainerByRef(cfg, ref);
    const who = "Контейнер «" + (cont.name || cont.id) + "» (" + cont.id + ")";
    const urlLine = "Адрес вызова: " + (cont.url || "— (нет адреса: включи публичный доступ действием «Открыть всему интернету»)");
    if (op === "card") {
      const { revs, active } = await ycActiveRevision(cfg, cont.id);
      const lines = [
        who,
        "Статус: " + (cont.status || "—") + (cont.description ? " · " + cont.description : ""),
        "Создан: " + (cont.createdAt || "—"),
        urlLine,
      ];
      if (!revs.length) {
        lines.push("Ревизий нет: контейнер создан, но ни разу не выкатывался. Новая ревизия — действием «Новая ревизия» (нужен образ вида cr.yandex/<registry-id>/<image>:tag).");
      } else {
        lines.push("Ревизий: " + revs.length + " · активная — " + (active ? active.id : "—"));
        lines.push(ycRevisionDetails(yandexCloud.revisionSummary(active || {})));
      }
      lines.push("Образ, переменные окружения и ресурсы задаются ТОЛЬКО новой ревизией: «правка» меняет имя и описание.");
      return { ok: true, container: cont, revision: active ? yandexCloud.revisionSummary(active) : null, lines: lines, message: who };
    }
    if (op === "revisions") {
      const revs = await yandexCloud.listRevisions(cfg.oauth, { containerId: cont.id, pageSize: 100, filter: a.filter ? String(a.filter) : undefined });
      const activeId = (revs.find((r) => r.status === "ACTIVE") || revs[0] || {}).id || "";
      const lines = [who, urlLine];
      if (!revs.length) lines.push("Ревизий нет.");
      else for (const r of revs) lines.push(ycRevisionLine(yandexCloud.revisionSummary(r), r.id === activeId));
      return { ok: true, container: cont, revisions: revs, lines: lines, message: "Ревизий: " + revs.length + "." };
    }
    if (op === "revision") {
      const rid = String(a.revisionId || a.revision || "").trim();
      if (!rid) return { ok: false, error: "Укажи revisionId — id виден в действии «Ревизии»." };
      const rev = await yandexCloud.getRevision(cfg.oauth, rid);
      return {
        ok: true,
        container: cont,
        revision: yandexCloud.revisionSummary(rev),
        lines: [who, ycRevisionDetails(yandexCloud.revisionSummary(rev))],
        message: "Ревизия " + rid + ".",
      };
    }
    if (op === "newrev") {
      const { active } = await ycActiveRevision(cfg, cont.id);
      const opts = yandexCloud.revisionToDeployOpts(active, {
        imageUrl: a.image || a.imageUrl,
        memoryMb: a.memoryMb,
        cores: a.cores,
        coreFraction: a.coreFraction,
        timeoutSec: a.timeoutSec,
        concurrency: a.concurrency,
        minInstances: a.minInstances,
        networkId: a.networkId,
        serviceAccountId: a.serviceAccountId,
        runtime: a.runtime,
        logGroupId: a.logGroupId,
        env: ycJsonArg(a.env),
        envReplace: a.envReplace === true,
        description: a.description,
        folderId: cfg.folderId,
      });
      if (!opts.imageUrl) {
        return { ok: false, error: "У новой ревизии нет образа. Контейнер ещё не выкатывался — укажи образ вручную, например cr.yandex/<registry-id>/<image>:latest (реестр: плитка «Реестр образов»)." };
      }
      await yandexCloud.deployContainerRevision(cfg.oauth, Object.assign({ containerId: cont.id }, opts));
      const after = await ycActiveRevision(cfg, cont.id);
      const src = active ? "настройки взяты из активной ревизии " + active.id + " (указанные поля переопределены)" : "первая ревизия контейнера";
      return {
        ok: true,
        changed: true,
        container: cont,
        revision: after.active ? yandexCloud.revisionSummary(after.active) : null,
        lines: ["✅ Ревизия развёрнута (" + src + ").", urlLine, ycRevisionDetails(yandexCloud.revisionSummary(after.active || {}))],
        warnings: (parseInt(a.minInstances, 10) || 0) > 0
          ? ["Тёплые экземпляры (мин. инстансов " + a.minInstances + ") держат контейнер запущенным всегда — за них платят, даже когда запросов нет."]
          : [],
        message: "Ревизия развёрнута.",
      };
    }
    if (op === "rollback") {
      const rid = String(a.revisionId || a.revision || "").trim();
      if (!rid) return { ok: false, error: "Укажи revisionId, на которую откатить (список: действие «Ревизии»)." };
      await yandexCloud.rollbackContainer(cfg.oauth, cont.id, rid);
      const after = await ycActiveRevision(cfg, cont.id);
      return {
        ok: true,
        changed: true,
        container: cont,
        lines: ["✅ Контейнер откачен на ревизию " + rid + ".", "Активная ревизия теперь: " + ((after.active && after.active.id) || "—") + ".", urlLine],
        message: "Откат выполнен.",
      };
    }
    if (op === "update") {
      const patch = {};
      if (a.newName != null && String(a.newName).trim()) patch.name = String(a.newName).trim();
      if (a.description != null) patch.description = String(a.description);
      const updated = await yandexCloud.updateContainer(cfg.oauth, cont.id, patch);
      const labelKeys = Object.keys(updated.labels || {});
      return {
        ok: true,
        changed: true,
        container: updated,
        lines: [
          "✅ Контейнер обновлён: «" + (updated.name || cont.name) + "»" + (updated.description ? " — " + updated.description : "") +
            (labelKeys.length ? "\nМетки: " + labelKeys.map((k) => k + "=" + updated.labels[k]).join(", ") : ""),
          "Образ, переменные окружения и ресурсы правятся ТОЛЬКО новой ревизией (действие «Новая ревизия»).",
        ],
        message: "Контейнер обновлён.",
      };
    }
    if (op === "public") {
      const r = await yandexCloud.setContainerPublicAccess(cfg.oauth, cont.id);
      return {
        ok: true,
        changed: !r.already,
        container: cont,
        lines: [(r.already ? "ℹ Контейнер уже открыт для вызова из интернета." : "⚠ Контейнер открыт для вызова из интернета."), urlLine, "Привязка «все пользователи → serverless.containers.invoker» выдана на сам контейнер."],
        warnings: ["Любой человек из интернета сможет звать контейнер по адресу и увидеть то, что он отвечает. Если внутри есть пароли или личные данные — закрой контейнер обратно (действие «Закрыть от интернета»)."],
        message: r.already ? "Контейнер уже был открыт." : "Контейнер открыт.",
      };
    }
    // private — единственное оставшееся действие (список ALL сверен выше).
    const r2 = await yandexCloud.unsetContainerPublicAccess(cfg.oauth, cont.id);
    return {
      ok: true,
      changed: !r2.already,
      container: cont,
      lines: [r2.already ? "ℹ Контейнер и так закрыт: привязки «все пользователи» на нём нет." : "🔒 Контейнер закрыт от интернета: привязка «все пользователи → invoker» снята.", urlLine],
      message: r2.already ? "Контейнер уже был закрыт." : "Контейнер закрыт.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Object Storage: файлы бакета из окна (часть 91, заход 10) ──────────────
// Бакет создаётся «для файлов и статики», а положить в него файл из окна было
// нечем: объекты умел только агент (`ycStorage`), а карточка бакета — лишь
// показывать список и удалять по одному. Тела запросов лежат в
// src/yandex-cloud.js (S3-совместимый API, XML-ответы, IAM-токен БЕЗ подписи
// AWS, предел одного запроса S3_MAX_BYTES) — здесь выбор действия и отказ.
//
// Платность честная: САМ файл бесплатен, платят за объём (ГБ·месяц), поэтому
// «Загрузить файл» помечено платным и спрашивает согласие — но в тексте сказано
// именно про объём, а не выдуманная цена за штуку.
ipcMain.handle("yc:storage", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "objects", "upload", "download", "delete", "url", "access", "public", "private"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие Object Storage: " + op + ". Доступно: " + ALL.join(", ") + "." };
  const humanSize = (n) => {
    const v = Number(n) || 0;
    if (v >= 1073741824) return (Math.round((v / 1073741824) * 10) / 10) + " ГБ";
    if (v >= 1048576) return (Math.round((v / 1048576) * 10) / 10) + " МБ";
    if (v >= 1024) return Math.round(v / 1024) + " КБ";
    return v + " Б";
  };
  try {
    const buckets = (await yandexCloud.listService(cfg.oauth, cfg.folderId, yandexCloud.serviceByKey("storage"))).items || [];
    if (!buckets.length) {
      return { ok: false, error: "Бакетов в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Создай бакет кнопкой «＋ Создать» у плитки «Объектное хранилище»." };
    }
    if (op === "list") {
      return {
        ok: true,
        buckets: buckets,
        lines: buckets.map((b) => "• " + (b.name || b.id) + " — " + (b.status || "—") + (b.defaultStorageClass ? " · класс " + b.defaultStorageClass : "") + " (" + b.id + ")"),
        message: "Бакетов: " + buckets.length + ".",
      };
    }
    const ref = String(a.bucket || a.name || "").trim();
    const bucket = ref ? buckets.find((b) => b.id === ref) || buckets.find((b) => b.name === ref) : buckets.length === 1 ? buckets[0] : null;
    if (!bucket) {
      return { ok: false, error: "Не нашёл бакет «" + ref + "»" + (ref ? "." : " — бакетов несколько, выбери «Бакет» полем.") + " В каталоге: " + buckets.map((b) => b.name).join(", ") + "." };
    }
    const who = "Бакет «" + bucket.name + "» (" + bucket.id + ")";
    const key = String(a.key || a.object || "").replace(/^\/+/, "");
    const objNeeded = op === "objects" || op === "upload" || op === "download" || op === "delete" || op === "url";
    if (objNeeded && op !== "objects" && !key) {
      return { ok: false, error: "Укажи key — путь объекта в бакете, например site/index.html (что уже лежит: действие «Объекты бакета»)." };
    }

    if (op === "objects") {
      const prefix = String(a.prefix || "").replace(/^\/+/, "");
      const r = await yandexCloud.listBucketObjects(cfg.oauth, { bucket: bucket.name, prefix: prefix, limit: a.limit });
      const lines = [who];
      if (!r.items.length) {
        lines.push(prefix ? "По префиксу «" + prefix + "» пусто." : "В бакете нет ни одного объекта.");
        lines.push("Положить файл — действием «Загрузить файл»: он спросит файл на диске и ключ в бакете.");
      } else {
        for (const it of r.items) lines.push("• " + it.key + (it.size ? " · " + humanSize(it.size) : "") + (it.lastModified ? " · " + String(it.lastModified).slice(0, 16).replace("T", " ") : ""));
        lines.push("Объектов: " + r.count + (r.truncated ? " (показаны первые — сузь префиксом)" : "") + ". Открытый адрес — действием «Ссылка на объект».");
      }
      return { ok: true, bucket: bucket, objects: r.items, lines: lines, message: "Объектов: " + r.count + "." };
    }

    if (op === "access") {
      const r = await yandexCloud.getBucketAccess(cfg.oauth, bucket.name);
      return {
        ok: true,
        bucket: bucket,
        flags: r.flags,
        public: !!r.flags.read,
        lines: [who, r.flags.read ? "Анонимное чтение ВКЛ: объекты открываются по ссылке у любого." : "Анонимное чтение выкл: по ссылке придёт отказ 403 — это нормально для закрытого бакета.", "Перечисление содержимого анонимно: " + (r.flags.list ? "ВКЛ" : "выкл") + "."],
        message: r.flags.read ? "Бакет публичный." : "Бакет закрытый.",
      };
    }

    if (op === "url") {
      const acc = await yandexCloud.getBucketAccess(cfg.oauth, bucket.name);
      const url = yandexCloud.objectPublicUrl(bucket.name, key);
      const open = !!acc.flags.read;
      return {
        ok: true,
        bucket: bucket,
        key: key,
        url: url,
        public: open,
        lines: [who, "Объект: " + key, "Открытый адрес: " + url, open ? "Бакет открыт на чтение — ссылка работает у любого, кто её знает (и её видят поисковики)." : "Бакет ЗАКРЫТ: ссылка вернёт 403, пока не включён публичный доступ (действие «Открыть бакет»)."],
        warnings: open ? [] : ["Чтобы файл открывался по ссылке у других, у бакета должно быть разрешено анонимное чтение — тогда файлы станут видны всем, кто знает ссылку."],
        message: "Ссылка на объект.",
      };
    }

    if (op === "upload") {
      const fromFile = String(a.file || a.from || "").trim();
      const content = a.content != null ? String(a.content) : null;
      if (!fromFile && content == null) {
        return { ok: false, error: "Для загрузки нужен либо файл на диске (поле «Файл на ПК» — его выбирает системный диалог), либо содержимое текстом." };
      }
      if (a.confirmed !== true) {
        let size = 0;
        if (fromFile) {
          const p = resolvePath(fromFile, loadSettings());
          try {
            size = fs.statSync(p).size;
          } catch {
            return { ok: false, error: "Файла «" + fromFile + "» нет. Проверь путь: " + p };
          }
        }
        return {
          ok: false,
          needsConfirm: true,
          error: "Объект в бакете занимает место и тарифицируется за объём (ГБ за месяц), пока его не удалят. Подтверди загрузку.",
          lines: [who, "Ключ в бакете: " + key + (fromFile ? "\nФайл: " + fromFile + (size ? " (" + humanSize(size) + ")" : "") : "\nСодержимое задано текстом")],
        };
      }
      let body = null;
      if (fromFile) {
        const p = resolvePath(fromFile, loadSettings());
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, error: "Файла «" + fromFile + "» нет (путь от рабочей папки). Проверь: " + p };
        if (fs.statSync(p).size > yandexCloud.S3_MAX_BYTES) {
          return { ok: false, error: "Файл больше " + Math.round(yandexCloud.S3_MAX_BYTES / 1048576) + " МБ — одним запросом такое не залить. Сожми его или положи частями." };
        }
        body = fs.readFileSync(p);
      } else {
        body = Buffer.from(content, "utf8");
      }
      const r = await yandexCloud.putBucketObject(cfg.oauth, { bucket: bucket.name, key: key, body: body, contentType: a.contentType });
      return {
        ok: true,
        changed: true,
        bucket: bucket,
        key: r.key,
        size: r.size,
        url: r.url,
        lines: [
          "✅ Файл в облаке: " + r.key + " (" + humanSize(r.size) + ", " + yandexCloud.contentTypeFor(r.key) + ")",
          who,
          "Открытый адрес: " + r.url,
          "Ссылка откроется у других, только если у бакета разрешено анонимное чтение — включает действие «Открыть бакет» (и файлы станут видны поисковикам).",
        ],
        message: "Файл загружен.",
      };
    }

    if (op === "download") {
      const obj = await yandexCloud.getBucketObject(cfg.oauth, { bucket: bucket.name, key: key });
      const to = String(a.to || a.saveAs || "").trim();
      const p = to ? resolvePath(to, loadSettings()) : nodePath.join(agentWorkDir(loadSettings()), nodePath.basename(obj.key));
      fs.mkdirSync(nodePath.dirname(p), { recursive: true });
      fs.writeFileSync(p, obj.body);
      return {
        ok: true,
        bucket: bucket,
        key: obj.key,
        path: p,
        size: obj.size,
        lines: ["✅ Объект скачан: " + obj.key + " → " + p, "Размер: " + humanSize(obj.size) + " · тип: " + obj.contentType, who],
        message: "Объект скачан.",
      };
    }

    if (op === "delete") {
      if (a.confirmed !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Удаление объекта необратимо: вернуть его можно только залив файл заново.",
          lines: [who, "Объект: " + key],
        };
      }
      const r = await yandexCloud.deleteBucketObject(cfg.oauth, { bucket: bucket.name, key: key });
      return { ok: true, changed: true, deleted: true, bucket: bucket, lines: ["🗑 Объект удалён: " + r.key, who], message: "Объект удалён." };
    }

    if (op === "public") {
      if (a.confirmed !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Открытый бакет читает любой, кто знает ссылку, а содержимое становится видно ПОИСКОВИКАМ. Не открывай бакет с паролями, ключами и личными файлами — для закрытого хранения есть Lockbox.",
          lines: [who],
        };
      }
      const r = await yandexCloud.setBucketPublicAccess(cfg.oauth, bucket.name, true);
      return {
        ok: true,
        changed: true,
        bucket: bucket,
        flags: r.flags,
        lines: ["⚠ Бакет открыт для чтения из интернета.", who, "Объекты откроются у любого, кто знает ссылку; перечисление содержимого анонимно осталось выключено."],
        warnings: ["Содержимое бакета видно поисковикам. Закрыть обратно — действие «Закрыть бакет»."],
        message: "Бакет открыт.",
      };
    }
    // private — единственное оставшееся действие (список ALL сверен выше).
    const r2 = await yandexCloud.setBucketPublicAccess(cfg.oauth, bucket.name, false);
    return {
      ok: true,
      changed: true,
      bucket: bucket,
      flags: r2.flags,
      lines: ["🔒 Бакет закрыт: по ссылкам придёт отказ 403.", who, "Сами файлы на месте — вернуть доступ можно действием «Открыть бакет»."],
      message: "Бакет закрыт.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── База YDB: таблицы и записи (часть 91, заход 9) ─────────────────────────
// Таблицы YDB живут в HTTP Document API, и у него СВОЙ протокол: операция
// задаётся заголовком X-Amz-Target, значения атрибутов типизированы, а запрос
// всегда идёт в корень адреса самой базы. Всё это (и разбор значений, и адрес)
// живёт в src/yc-db.js и больше нигде; здесь — выбор действия, отказ и перевод
// ответа на русский.
//
// Честность, без которой кнопки врут: в КОЛОНКАХ документной таблицы YDB
// хранятся только поля первичного ключа, остальные поля лежат в самих записях.
// Поэтому «создать таблицу» спрашивает ключ, а не список колонок, и обещает
// ровно это. Произвольные колонки (YQL-таблицы) — ДРУГОЙ протокол (Ydb.Query по
// gRPC), и он живёт здесь же отдельным действием «query»: там настоящие колонки,
// SELECT, CREATE TABLE и всё, что умеет YQL. Протокол — в src/yc-yql.js, канал
// только выбирает действие и переводит ответ.
ipcMain.handle("yc:db", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "tables", "table", "create", "scan", "get", "put", "delete", "drop", "query"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие YDB: " + op + ". Доступно: " + ALL.join(", ") + "." };
  // Ячейка формы приходит строкой JSON, поэтому разбираем её общей ycJsonArg, а
  // массив отвергаем: и ключ, и запись — это НАБОР ПОЛЕЙ, а не список значений.
  const obj = (v) => {
    const j = ycJsonArg(v);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  };
  try {
    const found = await ycDb.findDatabase(cfg.oauth, cfg.folderId, a.database || a.db);
    const dbs = found.list || [];
    if (op === "list") {
      return {
        ok: true,
        databases: dbs,
        lines: dbs.length
          ? dbs.map((d) => "• " + (d.name || d.id) + " — " + (d.status || "—") + (d.endpoint ? " · " + d.endpoint : "") + " (" + d.id + ")")
          : ["Баз YDB в каталоге нет — их можно создать кнопкой «＋ Создать» у плитки «YDB»."],
        message: "Баз YDB: " + dbs.length + ".",
      };
    }
    if (!dbs.length) {
      return { ok: false, error: "Баз YDB в каталоге «" + (cfg.folderName || cfg.folderId) + "» нет. Сначала создай базу кнопкой «＋ Создать» у плитки «YDB»." };
    }
    const db = found.db;
    if (!db) {
      return { ok: false, error: "Баз несколько — выбери «Базу» полем (имя или id). В каталоге: " + dbs.map((d) => d.name + " (" + d.id + ")").join(", ") + "." };
    }
    const who = "База «" + (db.name || db.id) + "» (" + db.id + ")";

    // YQL (SQL): настоящие таблицы и любые запросы — gRPC Ydb.Query (src/yc-yql.js).
    // Опасные запросы (DROP/DELETE/ALTER/TRUNCATE) необратимы, поэтому
    // спрашиваются ДВАЖДЫ — окном и каналом (`a.confirmed`), как и удаления выше.
    if (op === "query") {
      const text = String(a.query || a.sql || "").trim();
      if (!text) return { ok: false, error: "Пустой запрос: напиши текст на YQL, например SELECT * FROM pets LIMIT 10." };
      const kind = ycDb.queryKind(text);
      const kindRu = kind === "destructive" ? "меняет данные необратимо" : kind === "write" ? "меняет данные" : "только чтение";
      if (kind === "destructive" && a.confirmed !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Этот запрос необратим — он удаляет или меняет данные (DROP / DELETE / ALTER / TRUNCATE). Повтори с подтверждением, если это правда нужно.",
          lines: [who, "Запрос: " + text.split("\n")[0].slice(0, 200)],
        };
      }
      const r = await ycDb.yql(cfg.oauth, db, { query: text });
      const lines = [who, "Запрос выполнен" + (r.rowCount ? ": строк " + r.rowCount : " (данных не вернул)") + " — " + kindRu + "."];
      for (const l of ycDb.formatSets(r.sets, { maxRows: a.maxRows || 50 })) lines.push(l);
      if (!r.sets.length) lines.push("Для CREATE / INSERT / UPDATE это нормально: команда выполнена, таблиц ответ не содержит.");
      if (r.issues && r.issues.length) lines.push("Замечания: " + r.issues.join("; "));
      return { ok: true, changed: kind !== "read", database: db, kind: kind, sets: r.sets, rowCount: r.rowCount, lines: lines, message: kind === "read" ? "Запрос выполнен." : "Запрос выполнен, данные изменены." };
    }

    const table = String(a.table || "").trim();

    if (op === "tables") {
      const r = await ycDb.listDocumentTables(cfg.oauth, db);
      const lines = [who];
      if (!r.tables.length) {
        lines.push("Таблиц нет — база пустая.");
        lines.push("Создать — действием «＋ Создать таблицу». В колонках таблицы хранится только ключ, остальные поля лежат в самих записях.");
      } else {
        for (const t of r.tables) lines.push("• " + t);
        lines.push("Таблиц: " + r.tables.length + ". Записи — действием «Записи таблицы», структура — «Структура таблицы».");
      }
      return { ok: true, database: db, tables: r.tables, lines: lines, message: "Таблиц: " + r.tables.length + "." };
    }

    if (!table) return { ok: false, error: "Укажи таблицу (table) — имя видно в действии «Таблицы базы»." };

    if (op === "table") {
      const d = await ycDb.describeDocumentTable(cfg.oauth, db, table);
      const keyText = d.keys.map((k) => k.name + " [" + k.type + "]").join(", ") || "—";
      return {
        ok: true,
        database: db,
        tableInfo: d,
        lines: [
          "Таблица «" + d.table + "»" + (d.status ? " · " + d.status : ""),
          who,
          "Записей: " + d.itemCount + " · размер: " + d.sizeBytes + " Б",
          "Ключ: " + keyText,
          "В колонках таблицы — ТОЛЬКО поля ключа; остальные поля хранятся в самих записях (так устроен Document API YDB).",
        ],
        message: "Структура таблицы «" + d.table + "».",
      };
    }

    if (op === "create") {
      const keys = obj(a.keys);
      if (!keys) {
        return { ok: false, error: "Укажи keys — поля первичного ключа JSON-объектом, например {\"id\":\"S\"} или {\"species\":\"S\",\"name\":\"S\"}. Первый ключ — ключ поиска (HASH), остальные — сортировки (RANGE). Тип ключа: S — строка, N — число, B — байты." };
      }
      const r = await ycDb.createDocumentTable(cfg.oauth, db, { table: table, keys: keys });
      return {
        ok: true,
        changed: true,
        database: db,
        lines: [
          "✅ Таблица создана: " + r.table + " (ключ: " + r.keys.join(", ") + ")",
          who,
          "В колонках живёт только ключ; любые другие поля можно класть в записи — действием «Положить запись».",
        ],
        message: "Таблица создана.",
      };
    }

    if (op === "scan") {
      const r = await ycDb.scanDocumentTable(cfg.oauth, db, { table: table, limit: a.limit });
      if (!r.items.length) {
        return {
          ok: true,
          database: db,
          table: r.table,
          items: [],
          lines: ["В таблице «" + r.table + "» пусто.", who, "Положить запись — действием «Положить запись»: поля ключа в ней обязательны."],
          message: "Записей нет.",
        };
      }
      return {
        ok: true,
        database: db,
        table: r.table,
        items: r.items,
        lines: [
          "Таблица «" + r.table + "»: записей " + r.count + (r.count >= r.limit ? " (показаны первые " + r.limit + ")" : ""),
          who,
          JSON.stringify(r.items, null, 2),
          "Одна запись — действием «Прочитать запись», структура — «Структура таблицы».",
        ],
        message: "Записей: " + r.count + ".",
      };
    }

    if (op === "get") {
      const key = obj(a.key);
      if (!key) return { ok: false, error: "Укажи key — поля первичного ключа записи JSON-объектом, например {\"id\":\"1\"} (ключ виден в действии «Структура таблицы»)." };
      const r = await ycDb.getDocumentItem(cfg.oauth, db, { table: table, key: key });
      if (!r.item) return { ok: false, error: "Записи с таким ключом в таблице «" + r.table + "» нет.", lines: [who, "Что есть — действие «Записи таблицы»."] };
      return {
        ok: true,
        database: db,
        table: r.table,
        item: r.item,
        lines: ["Запись из «" + r.table + "»:", JSON.stringify(r.item, null, 2), who],
        message: "Запись прочитана.",
      };
    }

    if (op === "put") {
      const item = obj(a.item);
      if (!item) return { ok: false, error: "Укажи item — запись JSON-объектом, например {\"id\":\"1\",\"name\":\"Tom\"}. Поля первичного ключа в ней обязательны (ключ виден в действии «Структура таблицы»)." };
      const r = await ycDb.putDocumentItem(cfg.oauth, db, { table: table, item: item });
      return {
        ok: true,
        changed: true,
        database: db,
        table: r.table,
        lines: [
          "✅ Запись сохранена в «" + r.table + "» (полей: " + r.fields.length + ")",
          who,
          "Запись кладётся ЦЕЛИКОМ: если такая уже была, её прежние поля заменяются этим набором.",
        ],
        message: "Запись сохранена.",
      };
    }

    if (op === "delete") {
      const key = obj(a.key);
      if (!key) return { ok: false, error: "Укажи key — поля первичного ключа записи JSON-объектом (ключ виден в действии «Структура таблицы»)." };
      if (a.confirmed !== true) {
        const existing = await ycDb.getDocumentItem(cfg.oauth, db, { table: table, key: key }).catch(() => ({ item: null }));
        if (!existing.item) return { ok: false, error: "Записи с таким ключом в таблице «" + table + "» нет — удалять нечего." };
        return {
          ok: false,
          needsConfirm: true,
          error: "Удаление записи необратимо: вернуть её можно только заново заполнив поля.",
          lines: ["Запись: " + JSON.stringify(existing.item), who],
        };
      }
      await ycDb.deleteDocumentItem(cfg.oauth, db, { table: table, key: key });
      return { ok: true, changed: true, deleted: true, database: db, lines: ["🗑 Запись удалена из «" + table + "»", who], message: "Запись удалена." };
    }

    // drop — последнее оставшееся действие (список ALL сверен выше).
    if (a.confirmed !== true) {
      return {
        ok: false,
        needsConfirm: true,
        error: "Удаление таблицы необратимо: она уйдёт ВМЕСТЕ со всеми записями, и вернуть данные из окна будет нельзя.",
        lines: [who, "Таблица: " + table],
      };
    }
    await ycDb.deleteDocumentTable(cfg.oauth, db, table);
    return { ok: true, changed: true, deleted: true, database: db, lines: ["🗑 Таблица удалена вместе со всеми записями: " + table, who], message: "Таблица удалена." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── API-шлюз (API Gateway): шлюз целиком — из OpenAPI-спецификации ──────────
// API-шлюз — это «вход» в приложение: он принимает запросы по адресу
// `<id>.apigw.yandexcloud.net`, разбирает их по спецификации и уводит в
// интеграции. У сервиса была только плитка-список и общее создание пустого
// ресурса, а создать шлюз ИЗ СПЕЦИФИКАЦИИ, показать её, поправить и удалить было
// нечем — ни человеку, ни агенту. Тела запросов живут в src/yc-apigw.js; здесь
// выбор действия и понятный отказ. Изменяющие методы возвращают OPERATION,
// поэтому их результат ждёт waitOperation, а готовый шлюз читается ПЕРЕЧИТЫВАНИЕМ.
// Права агента здесь НЕ спрашиваем: галочки «Разрешить АГЕНТУ…» ограничивают
// модель, а здесь действует человек в своём окне — как у лог-групп и файлов бакета.
ipcMain.handle("yc:apigw", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "gateway", "spec", "create", "update", "delete"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycApiGw) return { ok: false, error: "Модуль API-шлюза не подключён к приложению (src/yc-apigw.js)." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие API-шлюза: " + op + ". Доступно: " + ALL.join(", ") + "." };
  try {
    const base = (await yandexCloud.endpoint("serverless-apigateway")) || ycApiGw.APIGW_FALLBACK;
    const iam = await yandexCloud.getIamToken(cfg.oauth);
    const gateways = await ycApiGw.listGateways(iam, base, cfg.folderId);
    if (op === "list") {
      return {
        ok: true,
        folder: { id: cfg.folderId, name: cfg.folderName },
        gateways: gateways,
        lines: gateways.length ? gateways.map((g) => ycApiGw.gatewayLine(g)) : ["API-шлюзов в каталоге нет. Создать — действием «＋ Создать шлюз из спецификации»."],
        message: "API-шлюзов: " + gateways.length + ".",
      };
    }
    // Создание стоит ДО поиска шлюза: у нового шлюза ещё нет записи в каталоге, и
    // поиск по имени отбил бы создание «не нашёл».
    if (op === "create") {
      const name = String(a.name || "").trim();
      if (!name) return { ok: false, error: "Укажи имя шлюза (name): строчные латинские буквы, цифры и дефис, 2–63 символа." };
      const spec = a.spec != null ? a.spec : a.openapiSpec;
      const o = await ycApiGw.createGateway(iam, base, {
        folderId: cfg.folderId,
        name: name,
        spec: spec,
        description: a.description,
        labels: ycJsonArg(a.labels),
        executionTimeout: a.executionTimeout,
      });
      const done = await yandexCloud.waitOperation(cfg.oauth, o && o.id, 180000);
      const made = (done && done.response) || {};
      const g = made.id ? await ycApiGw.getGateway(iam, base, made.id).catch(() => null) : null;
      const info = g || ycApiGw.gatewayInfo(made);
      const brief = ycApiGw.specBrief(spec);
      return {
        ok: true,
        changed: true,
        id: info.id || made.id || "",
        name: info.name || name,
        gateway: info,
        lines: [
          "✅ API-шлюз создан: " + (info.name || name) + (info.id ? " (" + info.id + ")" : ""),
          info.url ? "Адрес по умолчанию: " + info.url : "Адрес появится через несколько секунд — обнови список.",
          "Путей в спецификации: " + brief.pathCount + (brief.integrations ? " · интеграций: " + brief.integrations : ""),
          "Дальше: спецификацию видно действием «Спецификация шлюза», меняется — «✎ Править шлюз».",
        ],
        message: "API-шлюз создан.",
      };
    }
    const ref = String(a.gateway || a.apiGatewayId || a.apiGateway || a.id || a.name || "").trim();
    const found = ycApiGw.matchGateway(gateways, ref);
    const missing = { ok: false, error: "Не нашёл API-шлюз «" + ref + "»" + (ref ? "." : " — шлюзов несколько, выбери поле «Шлюз».") + " В каталоге: " + gateways.map((g) => g.name).join(", ") + "." };
    if (op === "gateway") {
      if (!found) return missing;
      const g = await ycApiGw.getGateway(iam, base, found.id);
      return {
        ok: true,
        gateway: g,
        lines: [
          ycApiGw.gatewayLine(g),
          "Адрес: " + (g.url || "—"),
          "Описание: " + (g.description || "—"),
          "Метки: " + (Object.keys(g.labels || {}).length ? JSON.stringify(g.labels) : "нет"),
          "Время выполнения: " + (g.executionTimeout || "по умолчанию"),
          "Группа логов: " + (g.logGroupId || "—"),
          "Создан: " + (g.createdAt || "—"),
        ],
        message: "API-шлюз.",
      };
    }
    if (op === "spec") {
      if (!found) return missing;
      const s = await ycApiGw.getSpec(iam, base, found.id, a.format);
      const brief = ycApiGw.specBrief(s.openapiSpec);
      return {
        ok: true,
        gateway: found,
        format: brief.format,
        paths: brief.paths,
        spec: s.openapiSpec,
        lines: ["Спецификация API-шлюза «" + found.name + "» (" + (brief.format || "—") + ", путей " + brief.pathCount + "):"].concat(
          brief.paths.length ? brief.paths.map((p) => "  " + p) : ["  (путей в спецификации не нашлось)"],
          ["", s.openapiSpec]
        ),
        message: "Спецификация шлюза.",
      };
    }
    if (op === "update") {
      if (!found) return missing;
      const spec = a.spec != null ? a.spec : a.openapiSpec;
      const o = await ycApiGw.updateGateway(iam, base, found.id, {
        name: a.newName,
        description: a.description,
        labels: a.labels != null ? ycJsonArg(a.labels) : undefined,
        spec: spec,
        executionTimeout: a.executionTimeout,
      });
      await yandexCloud.waitOperation(cfg.oauth, o && o.id, 180000);
      const g = await ycApiGw.getGateway(iam, base, found.id);
      return { ok: true, changed: true, gateway: g, lines: ["✅ API-шлюз изменён.", ycApiGw.gatewayLine(g)], message: "API-шлюз изменён." };
    }
    // delete — единственное оставшееся действие; необратимо, поэтому требует согласия.
    if (a.confirmed !== true) {
      return {
        ok: false,
        needsConfirm: true,
        error: "Удаление API-шлюза необратимо: его адрес <id>.apigw.yandexcloud.net перестанет отвечать, а всё, что на него ссылалось (DNS, сайт, бот), получит ошибку. Подтверди удаление.",
        lines: found ? [ycApiGw.gatewayLine(found)] : [],
      };
    }
    if (!found) return missing;
    const o = await ycApiGw.deleteGateway(iam, base, found.id);
    await yandexCloud.waitOperation(cfg.oauth, o && o.id, 120000);
    return { ok: true, changed: true, deleted: true, id: found.id, lines: ["🗑 API-шлюз удалён: " + (found.name || found.id), (found.url || "Адрес") + " больше не отвечает."], message: "API-шлюз удалён." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Lockbox: секреты и их версии ────────────────────────────────────────────
// Секрет — это «место для ключей и паролей»: значение подставляет само облако,
// поэтому в приложении ценность секрета — версии (ключи) и выданный доступ. У
// сервиса была плитка-список и добавление версии из карточки, а посмотреть
// секрет, выдать роль сервисному аккаунту или удалить его было нечем. Тела
// запросов живут в src/yandex-cloud.js, проверки и слова — в src/yc-lockbox.js,
// здесь — выбор действия и понятный отказ. Значения секретов НИКОГДА не читаются
// обратно: API их не отдаёт, и ответ содержит только имена ключей.
// Права агента здесь НЕ спрашиваем: галочки ограничивают модель, а в своём окне
// человек действует сам — как у лог-групп, файлов бакета и API-шлюза.
ipcMain.handle("yc:lockbox", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "secret", "versions", "create", "putversion", "grant", "delete"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycLockbox) return { ok: false, error: "Модуль секретов не подключён к приложению (src/yc-lockbox.js)." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие секретов: " + op + ". Доступно: " + ALL.join(", ") + "." };
  try {
    const secrets = await yandexCloud.listSecrets(cfg.oauth, cfg.folderId);
    if (op === "list") {
      return {
        ok: true,
        folder: { id: cfg.folderId, name: cfg.folderName },
        secrets: secrets,
        lines: secrets.length ? secrets.map((s) => ycLockbox.secretLine(s)) : ["Секретов в каталоге нет. Создать — действием «＋ Создать секрет»."],
        message: "Секретов: " + secrets.length + ".",
      };
    }
    // Создание стоит ДО поиска секрета: у нового секрета ещё нет записи в списке.
    if (op === "create") {
      const name = ycLockbox.checkName(a.name);
      const made = await yandexCloud.createResource(cfg.oauth, cfg.folderId, "lockbox", name);
      const made2 = await yandexCloud.findSecret(cfg.oauth, cfg.folderId, (made && made.name) || name);
      const info = made2 ? ycLockbox.secretInfo(made2) : { id: (made && made.resourceId) || "", name: name };
      return {
        ok: true,
        changed: true,
        id: info.id || "",
        name: info.name || name,
        secret: info,
        lines: [
          "✅ Секрет создан: " + (info.name || name) + (info.id ? " (" + info.id + ")" : ""),
          "Пустой секрет бесполезен — добавь версию действием «↑ Новая версия» (пары «ключ → значение»).",
        ],
        message: "Секрет создан.",
      };
    }
    const ref = String(a.secret || a.id || a.name || "").trim();
    const found = ycLockbox.matchSecret(secrets, ref);
    const missing = { ok: false, error: "Не нашёл секрет «" + ref + "»" + (ref ? "." : " — секретов несколько, выбери поле «Секрет».") + " В каталоге: " + secrets.map((s) => s.name).join(", ") + "." };
    if (op === "secret") {
      if (!found) return missing;
      const full = await yandexCloud.getSecret(cfg.oauth, found.id);
      const versions = await yandexCloud.listSecretVersions(cfg.oauth, found.id);
      const info = ycLockbox.secretInfo(full);
      return {
        ok: true,
        secret: info,
        lines: [
          ycLockbox.secretLine(full),
          "Описание: " + (info.description || "—"),
          "Статус: " + info.statusHuman,
          "Текущая версия: " + (info.currentVersionId || "—"),
          "Версий всего: " + versions.length,
          "Защита от удаления: " + (info.deletionProtection ? "включена" : "нет"),
          "Создан: " + (info.createdAt || "—"),
        ],
        message: "Секрет.",
      };
    }
    if (op === "versions") {
      if (!found) return missing;
      const versions = await yandexCloud.listSecretVersions(cfg.oauth, found.id);
      return {
        ok: true,
        secret: ycLockbox.secretInfo(found),
        versions: versions,
        lines: ["Версии секрета «" + (found.name || ref) + "» (свежие сверху), всего " + versions.length + ":"].concat(
          versions.length ? versions.map((v) => ycLockbox.versionLine(v)) : ["  (версий нет — секрет пуст)"],
          ["", "Значения секретов API не отдаёт — видны только имена ключей."]
        ),
        message: "Версии секрета.",
      };
    }
    if (!found) return missing;
    if (op === "putversion") {
      const entries = ycLockbox.checkEntries(a.entries != null ? a.entries : (a.payload != null ? a.payload : a.values));
      const r = await yandexCloud.putSecretVersion(cfg.oauth, found.id, entries);
      return {
        ok: true,
        changed: true,
        id: found.id,
        versionId: r.versionId,
        lines: [
          "✅ Новая версия секрета «" + (found.name || ref) + "»: " + r.versionId,
          "Ключи: " + (r.keys.join(", ") || "—"),
          "Значения в ответе не показываю: они ушли в облако и обратно не читаются.",
        ],
        message: "Версия секрета добавлена.",
      };
    }
    if (op === "grant") {
      const saId = String(a.serviceAccountId || a.saId || a.account || "").trim();
      if (!saId) return { ok: false, error: "Укажи serviceAccountId — сервисный аккаунт, которому выдаём доступ к секрету (список: плитка «Сервисные аккаунты»)." };
      const role = String(a.role || a.roleId || "").trim() || ycLockbox.DEFAULT_ROLE;
      await yandexCloud.grantSecretAccess(cfg.oauth, found.id, saId, role);
      return {
        ok: true,
        changed: true,
        id: found.id,
        lines: [
          "✅ Доступ к секрету «" + (found.name || ref) + "» выдан сервисному аккаунту " + saId + " (роль " + role + ").",
          "Теперь ревизия контейнера может прочитать значения из этого секрета.",
        ],
        message: "Доступ к секрету выдан.",
      };
    }
    // delete — единственное оставшееся действие; необратимо, поэтому требует согласия.
    if (a.confirmed !== true) {
      return {
        ok: false,
        needsConfirm: true,
        error: "Удаление секрета необратимо: все его версии и значения исчезнут, а ревизии, которые на него ссылаются, перестанут стартовать. Подтверди удаление.",
        lines: found ? [ycLockbox.secretLine(found)] : [],
      };
    }
    await yandexCloud.deleteResource(cfg.oauth, "lockbox", found.id);
    return { ok: true, changed: true, deleted: true, id: found.id, lines: ["🗑 Секрет удалён: " + (found.name || found.id), "Все его версии и значения больше не вернуть."], message: "Секрет удалён." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Container Registry: реестр и его образы ─────────────────────────────────
// Реестр образов копит образы с каждой выкаткой, а они занимают ПЛАТНОЕ
// хранилище и живут, пока их не уберут. В окне реестр был только плиткой-списком,
// а образы — лишь в карточке (список и удаление по одному): создать реестр,
// посмотреть образы, убрать их пачкой и удалить сам реестр было нечем. Тела
// запросов — в src/yandex-cloud.js, проверки и слова — в src/yc-registry.js,
// здесь — выбор действия и понятный отказ. Облако НЕ удаляет непустой реестр:
// поэтому удаление честно говорит «сначала убери образы», а не падает с 400.
ipcMain.handle("yc:registry", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "images", "create", "delimage", "clean", "delete"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  if (!ycRegistry) return { ok: false, error: "Модуль реестра не подключён к приложению (src/yc-registry.js)." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие реестра: " + op + ". Доступно: " + ALL.join(", ") + "." };
  try {
    const svcDef = yandexCloud.serviceByKey("containerRegistry");
    const regs = ((await yandexCloud.listService(cfg.oauth, cfg.folderId, svcDef)).items) || [];
    if (op === "list") {
      return {
        ok: true,
        folder: { id: cfg.folderId, name: cfg.folderName },
        registries: regs,
        lines: regs.length ? regs.map((r) => ycRegistry.registryLine(r)) : ["Реестров в каталоге нет. Создать — действием «＋ Создать реестр»."],
        message: "Реестров: " + regs.length + ".",
      };
    }
    // Создание стоит ДО поиска реестра: у нового реестра ещё нет записи в списке.
    if (op === "create") {
      const name = ycRegistry.checkName(a.name);
      await yandexCloud.ensureRegistry(cfg.oauth, cfg.folderId, name);
      const made = await yandexCloud.findRegistry(cfg.oauth, cfg.folderId, name);
      const info = made ? ycRegistry.registryInfo(made) : { id: "", name: name };
      return {
        ok: true,
        changed: true,
        id: info.id || "",
        name: name,
        lines: [
          "✅ Реестр создан: " + name + (info.id ? " (" + info.id + ")" : ""),
          "Адрес образов: cr.yandex/" + (info.id || "<id>") + "/<образ>:<тег>. Класть образы — выкаткой.",
        ],
        message: "Реестр создан.",
      };
    }
    const ref = String(a.registry || a.registryId || a.registryName || "").trim();
    const found = ycRegistry.matchRegistry(regs, ref);
    const missing = { ok: false, error: "Не нашёл реестр «" + ref + "»" + (ref ? "." : " — реестров несколько, выбери поле «Реестр».") + " В каталоге: " + regs.map((r) => r.name).join(", ") + "." };
    if (op === "images") {
      if (!found) return missing;
      const images = await yandexCloud.listRegistryImages(cfg.oauth, found.id);
      return {
        ok: true,
        registry: ycRegistry.registryInfo(found),
        images: images,
        lines: ["Образы реестра «" + found.name + "», всего " + images.length + ":"].concat(
          images.length ? images.map((i) => ycRegistry.imageLine(i)) : ["  (образов нет — реестр пуст)"]
        ),
        message: "Образов: " + images.length + ".",
      };
    }
    if (!found) return missing;
    if (op === "delimage") {
      const imageRef = String(a.image || a.imageId || a.tag || "").trim();
      if (!imageRef) return { ok: false, error: "Укажи образ (image) — id или тег. Список: действие «Образы реестра»." };
      const img = ycRegistry.matchImage(await yandexCloud.listRegistryImages(cfg.oauth, found.id), imageRef);
      if (!img) return { ok: false, error: "В реестре «" + found.name + "» нет образа «" + imageRef + "» — возможно, его уже удалили." };
      const info = ycRegistry.imageInfo(img);
      if (a.confirmed !== true) {
        return { ok: false, needsConfirm: true, error: "Удаление образа необратимо: его теги исчезнут вместе с ним, и вернуть образ будет нельзя. Если на тег ссылается контейнер, следующая выкатка его не соберёт. Подтверди удаление.", lines: [ycRegistry.imageLine(img)] };
      }
      await yandexCloud.deleteRegistryImage(cfg.oauth, img.id);
      return { ok: true, changed: true, deleted: true, id: img.id, lines: ["🗑 Образ удалён: " + (info.name || info.id) + " (теги: " + info.tagText + ")", "Вернуть образ нельзя; теги больше на него не указывают."], message: "Образ удалён." };
    }
    if (op === "clean") {
      const images = await yandexCloud.listRegistryImages(cfg.oauth, found.id);
      const olderDays = Number(a.olderThanDays || a.days || 0);
      let targets = images;
      if (olderDays > 0) {
        const cut = Date.now() - olderDays * 86400000;
        targets = images.filter((i) => {
          const t = Date.parse((i && i.createdAt) || "");
          return !isNaN(t) && t < cut;
        });
      }
      if (!targets.length) {
        return { ok: true, changed: false, cleared: 0, lines: ["Убирать нечего: " + (olderDays > 0 ? "образов старше " + olderDays + " дн. в реестре нет." : "в реестре нет образов.")], message: "Убирать нечего." };
      }
      if (a.confirmed !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Убрать образы из реестра «" + found.name + "» — необратимо: их и их теги не вернуть, собрать заново можно только новой выкаткой. Готов удалить " + targets.length + " образ(ов)? Подтверди уборку.",
          lines: targets.slice(0, 20).map((i) => ycRegistry.imageLine(i)).concat(targets.length > 20 ? ["… и ещё " + (targets.length - 20)] : []),
        };
      }
      let done = 0;
      const failed = [];
      for (const img of targets) {
        try {
          await yandexCloud.deleteRegistryImage(cfg.oauth, img.id);
          done++;
        } catch (e) {
          failed.push((img.name || img.id) + ": " + ((e && e.message) || e));
        }
      }
      return {
        ok: true,
        changed: done > 0,
        cleared: done,
        lines: ["🧹 Убрано образов: " + done + " из " + targets.length + "."].concat(failed.length ? ["Не удалось убрать: " + failed.join("; ")] : []),
        message: "Убрано образов: " + done + ".",
      };
    }
    // delete — реестр необратим, и облако НЕ удаляет непустой реестр: говорим об
    // этом словами, а не отдаём 400 из сети.
    const imagesLeft = await yandexCloud.listRegistryImages(cfg.oauth, found.id);
    if (imagesLeft.length) {
      return { ok: false, error: "Реестр «" + found.name + "» не пуст: в нём " + imagesLeft.length + " образ(ов). Облако не удаляет непустой реестр — сначала убери образы действием «🧹 Убрать все образы», потом повтори удаление." };
    }
    if (a.confirmed !== true) {
      return { ok: false, needsConfirm: true, error: "Удаление реестра необратимо: адрес cr.yandex/" + found.id + " перестанет существовать. Подтверди удаление.", lines: [ycRegistry.registryLine(found)] };
    }
    await yandexCloud.deleteResource(cfg.oauth, "containerRegistry", found.id);
    return { ok: true, changed: true, deleted: true, id: found.id, lines: ["🗑 Реестр удалён: " + found.name, "Его адрес cr.yandex/" + found.id + " больше не существует."], message: "Реестр удалён." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ── Cloud Postbox: адреса (домены), с которых шлют письма ───────────────────
// Postbox — SES-совместимый API: пользовательский OAuth-токен он не принимает и
// каталог берёт из САМОГО СЕРВИСНОГО АККАУНТА. Поэтому канал сначала меняет
// JSON-ключ сервисного аккаунта на IAM-токен (src/yc-sa.js), а потом говорит с
// облаком заголовком X-YaCloud-SubjectToken.
ipcMain.handle("yc:postbox", async (_e, args) => {
  const cfg = ycConfig();
  const a = args || {};
  const op = String(a.op || a.action || "list").trim().toLowerCase();
  const ALL = ["list", "card", "create", "dkim", "dkimon", "dkimoff", "delete"];
  if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён — вставь OAuth-токен в настройках (Настройки → «☁️ Yandex Cloud»)." };
  if (!ycPostbox) return { ok: false, error: "Модуль почты не подключён к приложению (src/yc-postbox.js)." };
  if (ALL.indexOf(op) === -1) return { ok: false, error: "Неизвестное действие почты: " + op + ". Доступно: " + ALL.join(", ") + "." };
  const tok = await postboxToken(cfg);
  if (!tok.token) return { ok: false, error: tok.error };
  try {
    const all = await yandexCloud.listEmailIdentities(tok.token);
    if (op === "list") {
      return {
        ok: true,
        count: all.count,
        identities: all.items,
        lines: all.items.length ? all.items.map((it) => ycPostbox.identityLine(it)) : ["Адресов нет. Создать — действием «＋ Создать адрес»."],
        message: "Адресов: " + all.count + ".",
      };
    }
    // Создание стоит ДО поиска адреса: у нового адреса ещё нет записи в списке.
    if (op === "create") {
      const addr = ycPostbox.checkAddress(a.name || a.address || a.identity);
      const made = await yandexCloud.createEmailIdentity(tok.token, addr);
      const info = ycPostbox.identityInfo(made);
      return {
        ok: true,
        changed: true,
        address: addr,
        identity: info,
        lines: [
          "✅ Адрес создан: " + addr,
          "Проверка владения доменом: " + info.statusHuman + " · подпись DKIM: " + (info.dkim.present ? info.dkim.statusHuman : "данных нет"),
          "Осталось подтвердить владение доменом: добавь в DNS записи из раздела «Настройка подписи писем (DKIM)» на странице адреса — две CNAME-записи (Simple), имя — <селектор>._domainkey.<адрес>.",
        ],
        warnings: ["Письма с этого адреса пойдут только после подтверждения домена — облако проверит DNS-записи само."],
        message: "Адрес создан.",
      };
    }
    const ref = String(a.address || a.identity || a.name || "").trim();
    const found = ycPostbox.matchIdentity(all.items, ref);
    if (!found) {
      return {
        ok: false,
        error:
          "Не нашёл адрес «" + ref + "»" + (ref ? "." : " — адресов несколько, выбери поле «Адрес».") +
          " В каталоге: " + all.items.map((x) => x.name).join(", ") + ".",
      };
    }
    if (op === "card") {
      const full = await yandexCloud.getEmailIdentity(tok.token, found.name);
      return { ok: true, address: found.name, identity: ycPostbox.identityInfo(full), lines: ycPostbox.cardLines(full), message: "Адрес." };
    }
    if (op === "dkim") {
      const full = await yandexCloud.getEmailIdentity(tok.token, found.name);
      const d = ycPostbox.identityInfo(full).dkim;
      if (!d.present) return { ok: true, address: found.name, dkim: d, lines: ["У адреса «" + found.name + "» данных о подписи DKIM нет — облако их не отдало."], message: "Подпись DKIM." };
      const lines = [
        "Подпись DKIM адреса «" + found.name + "»: " + (d.enabled ? "включена" : "выключена"),
        "Запись в DNS: " + d.statusHuman + (d.originHuman ? " · настройка: " + d.originHuman : "") + (d.currentKeyHuman ? ", ключ " + d.currentKeyHuman : ""),
      ];
      const recs = ycPostbox.dnsRecordLines(found.name, d);
      lines.push("", ...(recs.length ? recs : ["Селекторов у подписи нет — облако их не отдало; сами записи видны в консоли на странице адреса."]));
      lines.push("", "Включить или выключить подпись: действия «✍ Включить подпись DKIM» и «🔒 Выключить подпись DKIM».");
      return { ok: true, address: found.name, dkim: d, lines: lines, message: "Подпись DKIM." };
    }
    if (op === "dkimon" || op === "dkimoff") {
      const on = op === "dkimon";
      // Выключение рушит доставляемость — спрашиваем человека ДО запроса.
      if (!on && a.confirmed !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: "Выключение подписи DKIM рушит доставляемость: письма без подписи чаще попадают в спам и хуже проверяются почтовыми службами. Подтверди выключение.",
          lines: [ycPostbox.identityLine(found)],
        };
      }
      await yandexCloud.setEmailDkimSigning(tok.token, found.name, on);
      const full = await yandexCloud.getEmailIdentity(tok.token, found.name);
      const d = ycPostbox.identityInfo(full).dkim;
      return {
        ok: true,
        changed: true,
        address: found.name,
        dkim: d,
        lines: [(on ? "✍ Подпись DKIM включена: " : "🔒 Подпись DKIM выключена: ") + found.name, "Запись в DNS: " + d.statusHuman],
        message: on ? "Подпись DKIM включена." : "Подпись DKIM выключена.",
      };
    }
    // delete — единственное оставшееся действие; необратимо, поэтому требует согласия.
    if (a.confirmed !== true) {
      return {
        ok: false,
        needsConfirm: true,
        error: "Удаление адреса необратимо: с него перестанут уходить письма, а его DNS-записи (DKIM) перестанут работать. Подтверди удаление.",
        lines: [ycPostbox.identityLine(found)],
      };
    }
    await yandexCloud.deleteEmailIdentity(tok.token, found.name);
    return {
      ok: true,
      changed: true,
      deleted: true,
      address: found.name,
      lines: ["🗑 Адрес удалён: " + found.name, "Письма с него больше не уйдут; вернуть адрес можно только создав его заново."],
      message: "Адрес удалён.",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

}

module.exports = { registerYcIpc };



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
  const { ipcMain, yandexCloud, ycConsole, ycCosts, ycVpc, ycCompute, ycIam, ycFunctions, ycBilling, ycCdn, ycMonitoring, ycAi, ycMdb, ycIg, loadSettings, saveSettings, svc, fs, path: nodePath, resolvePath, agentWorkDir } = deps;
  const {
    YANDEX_OAUTH_URL,
    ycConfig,
    ycRequireAuth,
    readYcLogsText,
    ycCliStatus,
    ycCliInstall,
  } = svc;

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
    const services = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
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


}

module.exports = { registerYcIpc };



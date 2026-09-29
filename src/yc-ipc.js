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
  const { ipcMain, yandexCloud, ycConsole, ycCosts, ycVpc, ycCompute, ycIam, ycFunctions, ycBilling, ycCdn, loadSettings, saveSettings, svc } = deps;
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

}

module.exports = { registerYcIpc };



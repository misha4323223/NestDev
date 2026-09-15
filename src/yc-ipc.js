"use strict";

/* ─── Каналы «yc:*»: мост между интерфейсом и Yandex Cloud ────────────────────
   Раньше 17 обработчиков были рассыпаны по main.js между почтой, памятью и
   деплоем: найти нужный можно было только поиском. Здесь они собраны в одном
   месте и получают зависимости снаружи — как остальные вынесенные подсистемы.

   Каждый обработчик возвращает { ok, ... } и НИКОГДА не бросает наружу: ошибка
   облака превращается в текст для интерфейса. Платные ресурсы создаются только
   с явным согласием (opts.confirmed) — цена показывается до создания.

   16 каналов: авторизация и каталог, права агента, дашборд, обзор консоли,
   список и откат ревизий, ресурсы, стоимость, создание/удаление, логи и yc CLI. */

function registerYcIpc(deps) {
  const { ipcMain, yandexCloud, ycConsole, ycCosts, loadSettings, saveSettings, svc } = deps;
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

ipcMain.handle("yc:setPermissions", (_e, allowCreate, allowDelete, allowUpdate) => {
  const merged = {
    ...loadSettings(),
    ycAllowAgentCreate: !!allowCreate,
    ycAllowAgentDelete: !!allowDelete,
    ycAllowAgentUpdate: !!allowUpdate,
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
}

module.exports = { registerYcIpc };

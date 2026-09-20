"use strict";

/* ─── Настройки и группы выдачи: каналы окна и телефона ───────────────────────
   Раньше стояли в main.js (этап B, часть 30): три канала — settings:get,
   settings:set и policy:groups. Само хранилище (схема, миграции, секреты) живёт
   в src/settings-store.js, применение к подсистемам — в src/agent-env.js и
   src/browser-ipc.js; здесь только то, что связывает их с интерфейсом.

   Почему это место нельзя переносить механически. settings:set — не «сохранить
   присланный объект», а ЗАЩИТА от устаревшего или обрезанного объекта:

     • интерфейс, загруженный ДО автовыбора каталога Yandex Cloud, приносил
       пустой ycFolderId и стирал выбор — агент снова видел «каталог не выбран»;
     • сохранение с телефона (или старой версией окна) приходило без sitePasswords
       и mailPassword и затирало пароли.

   Тут же живёт выбор рабочей папки в системном диалоге (dialog:pickDir): его зовут и
   настройки, и панель проекта, а спрашивать надо именно рабочую папку. Родитель
   диалога — окно приложения: без него диалог открывался бы отдельным окном, которое
   легко потерять за главным.

   Эти поля берутся из текущих настроек, а не из присланного объекта. Каждая
   защита закрыта проверками (test/settings-ipc.test.js) и живым прогоном
   (scripts/live-settings-ipc.js), потому что ошибка тут тихая: настройки
   сохраняются, окно довольно, а поле молча потеряно.

   Живое значение здесь одно: `lastAgentRepoDir` — папка, куда агент последний раз
   клонировал репозиторий. При смене рабочей папки её надо сбросить, иначе агент
   продолжил бы работать в папке прошлой локации. Переменная принадлежит main.js
   (её читают пути-и-git, GitHub-каналы и инструменты), поэтому модуль получает
   сеттер мостом live — копия «застыла» бы и сброса не случилось. */

function registerSettingsIpc(deps) {
  const {
    ipcMain,
    loadSettings,
    saveSettings,
    normalizeSettings,
    applyAgentEnv,
    applyBrowserSettings,
    mobileBridge,
    toolPolicy,
    live,
    dialog,
    getWindow,
    ipcGuard,
    secretMask,
  } = deps;

// Кому отдаём настоящие значения секретов, а кому заглушки.
//
// Окно на ПК — доверенный клиент: оно само ходит к провайдеру (окно контекста,
// проверка ключа), поэтому ключи ему нужны настоящими. Так же и внутренние
// вызовы (наборы, живые прогоны): рендерера за ними нет.
//
// Телефон подключается по LAN и открытому ws://, и значения ему не нужны: прогон
// агента и запросы делает главный процесс. Из настроек ему выдают заглушки
// (см. src/secret-mask.js). Кто позвал — решает та же проверка отправителя, что
// стоит на разрушительных каналах (src/ipc-guard.js).
const maskedFor = (e) => ipcGuard.senderKind(e, getWindow ? getWindow() : null) === "mobile";
// Отказ чужому рендереру внутри приложения: настройки — это ключи, пароли и PIN,
// а второго окна приложению никто не обещал.
const deniedFor = (e, channel) => ipcGuard.denyReason(e, { window: getWindow ? getWindow() : null, channel });

ipcMain.handle("settings:get", (e) => {
  const bad = deniedFor(e, "settings:get");
  if (bad) return { ok: false, error: bad };
  const s = loadSettings();
  return maskedFor(e) ? secretMask.maskSecrets(s) : s;
});
// Группы выдачи секретов (terminal, git, cloud …) для настроек: собираются из
// таблицы прав (tool-policy.js) — рендерер ничего не дублирует у себя.
ipcMain.handle("policy:groups", (e) => {
  const bad = deniedFor(e, "policy:groups");
  if (bad) return [];
  return toolPolicy.scopeGroups();
});
ipcMain.handle("settings:set", (e, s0) => {
  const bad = deniedFor(e, "settings:set");
  if (bad) return { ok: false, error: bad };
  // Заглушки из настроек, присланных телефоном, — это «поле не трогали»:
  // разворачиваем их в прежние значения ДО слияния (src/secret-mask.js).
  // Иначе сохранение любого другого параметра с телефона стёрло бы ключи.
  const prev = loadSettings();
  const s = secretMask.restoreMasked(s0, prev);
  if (s && s.workingDir && prev.workingDir !== s.workingDir) {
    live.setLastAgentRepoDir(null); // рабочая папка сменилась — сбрасываем «активный репозиторий»
  }
  const merged = normalizeSettings({ ...prev, ...(s || {}) });
  // Защита хранилища паролей: если сохранение пришло без массива sitePasswords
  // (старая версия интерфейса, обрезанный объект, мобильный клиент) — не затираем
  // уже сохранённые записи. Пустой массив — это осознанная очистка, её пропускаем.
  if (!s || !Array.isArray(s.sitePasswords)) merged.sitePasswords = prev.sitePasswords || [];
  // Защита пароля почты: сохранение без ключа mailPassword (мобильный клиент,
  // старый интерфейс) не должно стирать уже сохранённый пароль приложения.
  if (!s || s.mailPassword === undefined) merged.mailPassword = prev.mailPassword || "";
  // Защита выбора Yandex Cloud: каталог/облако меняются ТОЛЬКО своими IPC
  // (yc:setToken, yc:setFolder, автовыбор внутри yc:status, сброс в yc:logout) —
  // в форме настроек такого поля нет. Объект интерфейса, загруженный ДО автовыбора
  // каталога, приносил пустой (или устаревший) ycFolderId и стирал выбор: агент
  // снова видел «каталог не выбран», и каталог приходилось выбирать заново.
  // Та же болезнь, что у sitePasswords и mailPassword. Поэтому поля Yandex Cloud
  // берём из текущих настроек, а не из присланного объекта.
  merged.ycFolderId = prev.ycFolderId || "";
  merged.ycFolderName = prev.ycFolderName || "";
  merged.ycCloudId = prev.ycCloudId || "";
  // При смене рабочей папки — сбрасываем локальную папку выбранного GitHub-репозитория,
  // чтобы не подхватывать старый путь от прошлой локации.
  if (s && s.workingDir && prev.workingDir !== s.workingDir) {
    merged.githubRepoDir = "";
    // Рабочая папка сменилась вручную — обновляем папку активного проекта, чтобы список не расходился.
    if (Array.isArray(merged.projects) && merged.activeProjectId) {
      const pr = merged.projects.find((p) => p.id === merged.activeProjectId);
      if (pr) pr.dir = merged.workingDir;
    }
  }
  applyAgentEnv(merged);
  // Мобильный доступ: при включении без PIN — генерируем его, затем применяем к мосту.
  if (merged.mobileEnabled && !merged.mobilePin) {
    merged.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  }
  applyBrowserSettings(merged);
  saveSettings(merged);
  mobileBridge.applySettings(merged);
  // Ответ уходит тому же клиенту — значит и состав у него должен быть тот же.
  // Иначе телефон, сохранив галочку, получил бы в ответ настоящие ключи.
  return maskedFor(e) ? secretMask.maskSecrets(merged) : merged;
});

// Выбор рабочей папки: окно спрашиваем в момент вызова — оно могло быть закрыто или
// пересоздано. Без живого окна диалог всё равно открывается, просто без родителя
// (иначе на закрытом окне Electron бросил бы ошибку и выбор папки не работал бы вовсе).
ipcMain.handle("dialog:pickDir", async (e) => {
  const bad = deniedFor(e, "dialog:pickDir");
  if (bad) return null;
  const w = getWindow ? getWindow() : null;
  const parent = w && !w.isDestroyed() ? w : undefined;
  // Electron 43 перестал запоминать последнюю папку и открывает диалог в «Загрузках»
  // (это в его breaking changes). Раньше папку помнила сама система, и выбор начинался
  // там, где человек остановился. Теперь называем папку явно — текущую рабочую:
  // иначе каждый выбор начинался бы с «Загрузок».
  const cur = loadSettings() || {};
  const opts = { properties: ["openDirectory"], title: "Выберите рабочую директорию" };
  if (cur.workingDir) opts.defaultPath = cur.workingDir;
  const r = await dialog.showOpenDialog(parent, opts);
  return r.canceled ? null : r.filePaths[0];
});
}

module.exports = { registerSettingsIpc };

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
  } = deps;

ipcMain.handle("settings:get", () => loadSettings());
// Группы выдачи секретов (terminal, git, cloud …) для настроек: собираются из
// таблицы прав (tool-policy.js) — рендерер ничего не дублирует у себя.
ipcMain.handle("policy:groups", () => toolPolicy.scopeGroups());
ipcMain.handle("settings:set", (_e, s) => {
  const prev = loadSettings();
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
  return merged;
});
}

module.exports = { registerSettingsIpc };

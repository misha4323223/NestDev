"use strict";
/* ─── Жизненный цикл приложения: старт, окно и порядок остановки ───────────────
   Вынесено из src/main.js (этап B, часть 37).

   Зачем отдельный модуль. Именно здесь уже была живая находка: падение
   createWindow() обрывало цепочку `whenReady`, и подписка апдейтера не ставилась
   вовсе — приложение молча перестаёт видеть обновления сборки. Ровно то же с
   любым следующим шагом: мост телефона с негодным портом в настройках (например,
   99999) бросает прямо в `listen`, и после него ни апдейтер, ни тик OTA не
   заводятся. Поэтому шаги старта идут через `runStep`: отказ шага виден в логе, но
   НЕ отменяет остальные.

   Второе, что здесь сторожится набором и живым прогоном: ПОРЯДОК остановки. Дети
   приложения (фоновые процессы, терминал, превью-сервер) на Windows переживают
   выход родителя и держат порты, поэтому они гасятся до моста телефона; браузер
   агента просим закрыться первым, потому что Chromium гаснет сам и дольше всех.
   Порядок — часть поведения, а не оформление.

   Что принимает: app, BrowserWindow, createWindow, mobileBridge, loadSettings,
   initAutoUpdater, autoUpdater, Notification, ota, browserTools, bgProcesses,
   bgKill, termShutdown, devShutdown, getWindow — и необязательные `platform`,
   `setTimer`, `everyTimer`: они нужны, чтобы проверять оба поведения закрытия окон
   и оба таймера OTA без настоящего Electron и без ожидания в минуту. */

// Сколько последних отказов шагов держим в памяти (тик OTA идёт каждую минуту —
// без предела список рос бы всё время работы приложения).
const FAILURES_KEPT = 20;

function createLifecycle(deps) {
  const {
    app,
    BrowserWindow,
    createWindow,
    mobileBridge,
    loadSettings,
    initAutoUpdater,
    autoUpdater,
    Notification,
    ota,
    browserTools,
    bgProcesses,
    bgKill,
    termShutdown,
    devShutdown,
    getWindow,
    platform = process.platform,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    everyTimer = (fn, ms) => setInterval(fn, ms),
  } = deps || {};

  const failures = []; // последние отказы шагов: { step, error }

  // Один шаг старта или остановки. Отказ шага НЕ должен отменять остальные: иначе
  // одна сломанная настройка (мост с негодным портом) тихо выключает обновления, а
  // один упавший шаг остановки оставляет живым dev-сервер, который держит порт.
  function runStep(name, fn) {
    try {
      return fn();
    } catch (e) {
      failures.push({ step: name, error: (e && e.message) || String(e) });
      if (failures.length > FAILURES_KEPT) failures.shift();
      console.error("[lifecycle] шаг «" + name + "» не выполнен:", (e && e.stack) || e);
      return null;
    }
  }

  // Шаги остановки и их ПОРЯДОК (проверяется набором и живым прогоном):
  //   • браузер агента — просим гаснуть первым: Chromium закрывается сам и дольше всех;
  //   • фоновые процессы и терминал — дети приложения: на Windows они переживают
  //     выход родителя и продолжают держать порты;
  //   • превью проекта — тоже ребёнок (dev-сервер); у него своя запись процесса,
  //     поэтому порядок с чисткой карты ему не важен, важно что он вообще вызван;
  //   • мост телефона — последним: пока идут остальные остановки, телефон ещё не
  //     должен терять страницу.
  const SHUTDOWN_STEPS = [
    { name: "браузер агента", run: () => browserTools.stop().catch(() => {}) }, // закрываем окно Chromium агента
    {
      name: "фоновые процессы",
      run: () => {
        for (const rec of bgProcesses.values()) bgKill(rec);
        bgProcesses.clear();
      },
    },
    { name: "терминал", run: () => termShutdown() },
    { name: "превью проекта", run: () => devShutdown() }, // превью (dev-сервер проекта) — состояние и остановка в src/preview-ipc.js
    { name: "мост телефона", run: () => mobileBridge.stop() },
  ];

  // Порядок шагов остановки именами — для проверок и для тех, кто читает код.
  const shutdownOrder = () => SHUTDOWN_STEPS.map((s) => s.name);

  // Остановка при выходе приложения: гасим всё, что переживёт процесс. Возвращает
  // отказы этого прохода (пустой список — всё остановилось).
  function runShutdown() {
    failures.length = 0;
    for (const step of SHUTDOWN_STEPS) runStep(step.name, step.run);
    return failures.slice();
  }

  // Старт: окно, настройки моста, подписка апдейтера, тик OTA и повторное создание
  // окна по activate. Порядок важен — сначала окно (в нём живёт интерфейс), а
  // подписка апдейтера и тик OTA обязаны состояться даже если окно не создалось.
  function start() {
    if (!app || typeof app.whenReady !== "function") return Promise.resolve([]);
    return app.whenReady().then(() => {
      runStep("окно", () => createWindow());
      runStep("настройки мобильного моста", () => mobileBridge.applySettings(loadSettings()));
      // Штатный апдейтер сборки: подписка и проверка по таймеру — код в src/ota-ipc.js.
      runStep("подписка апдейтера", () => initAutoUpdater({ autoUpdater, Notification, getWindow }));
      // Локальный self-update (OTA): проверка при старте и каждые 60 секунд
      const otaTick = () => {
        runStep("тик OTA", () => ota.check(loadSettings()).catch(() => {}));
      };
      setTimer(otaTick, 5000);
      everyTimer(otaTick, 60000);
      app.on("activate", () => {
        runStep("окно (activate)", () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      });
      return failures.slice();
    });
  }

  // Подписка оболочки на события приложения. Отдельно от start(), чтобы порядок
  // регистрации был виден в одном месте: выход, закрытие всех окон, старт.
  function startLifecycle() {
    // При выходе — останавливаем все фоновые процессы.
    app.on("before-quit", () => runShutdown());

    app.on("window-all-closed", () => {
      if (platform !== "darwin") app.quit();
    });

    return start();
  }

  return { startLifecycle, runShutdown, shutdownOrder, failures: () => failures.slice() };
}

module.exports = { createLifecycle, FAILURES_KEPT };

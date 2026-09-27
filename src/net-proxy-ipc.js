"use strict";

/* ─── Канал проверки прокси: settings:testProxy ───────────────────────────────
   Окно просит главный процесс сходить наружу через настроенный прокси и сказать,
   каким IP нас видит провайдер. Это ровно то, что человек хочет знать: прокси
   настроен и прокси РАБОТАЕТ — разные вещи.

   Почему проверка идёт из главного процесса, а не из окна. В окне свой сетевой
   стек (Chromium), он ничего не знает ни о наших прокси-настройках, ни о пути
   настоящего запроса агента: проверка оттуда была бы проверкой ДРУГОГО
   соединения и врала бы в обе стороны. Здесь ходит тот же код
   (src/net-proxy.js), который поведёт запрос прогона.

   Адрес берём из того, что прислало окно: человек жмёт «Проверить» сразу после
   ввода и мог ещё не сохранить настройки. Пусто — берём сохранённый адрес. */

function registerNetProxyIpc(deps) {
  const { ipcMain, netProxy, loadSettings, ipcGuard, getWindow } = deps;

  // Отказ чужому рендереру внутри приложения: проверка ходит в сеть от имени
  // приложения и раскрывает адрес прокси — права те же, что у настроек.
  ipcMain.handle("settings:testProxy", async (e, ui) => {
    const bad = ipcGuard.denyReason(e, { window: getWindow ? getWindow() : null, channel: "settings:testProxy" });
    if (bad) return { ok: false, error: bad };
    const s = loadSettings() || {};
    const typed = ui && typeof ui === "object" && ui.proxyUrl != null ? String(ui.proxyUrl).trim() : "";
    return netProxy.testProxy({ proxyUrl: typed || s.proxyUrl || "" });
  });
}

module.exports = { registerNetProxyIpc: registerNetProxyIpc };

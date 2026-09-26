"use strict";
/* Мобильный доступ: когда интерфейс открыт через мост приложения (http://<ПК-IP>:9090),
   этот скрипт подключается по WebSocket к ядру на ПК и делает его полноценным:
   window.api (как в Electron), PIN-гейт при подключении, PWA (установка на главный экран).

   В Electron (window.api уже есть) и в веб-превью без моста (WS не поднимется) — no-op. */
(function () {
  if (window.api) return; // Electron: API уже предоставлен preload'ом
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  // Активен ТОЛЬКО когда страницу отдал мост приложения (src/mobile-bridge.js
  // подмешивает /bootstrap.js с флагом). В веб-превью (server.js) и Electron
  // этого флага нет — скрипт ничего не делает, мок-режим и preload не ломаются.
  if (!window.__mobileBridge) return;

  var WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  var ws = null;
  var authed = false;
  // Приоритет входа: свой СЕАНС (переподключение) → одноразовый ТОКЕН ПАРЫ
  // из QR-кода → PIN, который ввёл человек. PIN остаётся запасным путём: если
  // код с ПК потерян или на ПК нажали «сменить PIN», вход всегда возможен.
  var SESSION_KEY = "ai-agent-device-session";
  var authSecret = null; // { kind: "session" | "pair" | "pin", value: "..." }
  var enteredPin = "";
  var seq = 0;
  var pending = new Map(); // id → {resolve, reject}
  var queue = []; // вызовы до авторизации
  var listeners = {}; // channel → [cb]
  var gateEl = null;
  var pinInput = null;
  var gateErrorEl = null;
  var gateStatusEl = null;
  var reconnectTimer = null;
  var closed = false;
  var everOpened = false;
  var gateBusy = false;
  var gateAutoTimer = null;
  var gateViewportBound = false;
  var gateHost = location.host || "";

  // ─── Что пришло из адреса: токен пары или PIN (QR-код с экрана ПК) ───
  // На экране ПК (Настройки → «Мобильный доступ») есть QR-код с адресом вида
  // http://192.168.1.42:9090/#pair=<одноразовый токен>. Камера телефона открывает
  // такую ссылку — и доказывать ничего не надо: токен уже в адресе, а после
  // первого обмена он гаснет (мост гасит его у себя). Ссылка со старым форматом
  // (#pin=482913) тоже работает: PIN ушёл из QR-кодов, но не из приложения.
  // Из адресной строки секрет сразу убираем (history.replaceState), чтобы он не
  // остался в истории браузера и не попал в скриншот экрана.
  function pairFromLocation() {
    var raw = String(location.hash || "") + "&" + String(location.search || "");
    var m = /(?:^|[#?&])(?:pair|token)=(\w{16,64})(?:&|$)/i.exec(raw);
    return m ? m[1] : "";
  }
  function pinFromLocation() {
    var raw = String(location.hash || "") + "&" + String(location.search || "");
    var m = /(?:^|[#?&])(?:pin|p)=(\d{4,6})(?:&|$)/i.exec(raw);
    return m ? m[1] : "";
  }
  var urlPair = pairFromLocation();
  var urlPin = pinFromLocation();
  if (urlPair) authSecret = { kind: "pair", value: urlPair };
  else if (urlPin) {
    enteredPin = urlPin;
    authSecret = { kind: "pin", value: urlPin };
  }
  if (urlPair || urlPin) {
    try {
      history.replaceState(null, "", location.pathname + (location.search || ""));
    } catch (e) {}
  }

  // ─── Свой сеанс устройства: помним между перезагрузками страницы ───
  // Сеанс выдаёт ПК при успешной паре (auth_ok + session). С ним телефон
  // переподключается сам — заново сканировать код не надо.
  function readStoredSession() {
    try {
      return String(localStorage.getItem(SESSION_KEY) || "");
    } catch (e) {
      return "";
    }
  }
  function storeSession(v) {
    try {
      if (v) localStorage.setItem(SESSION_KEY, v);
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  // Отправка доказательства: одно и то же сообщение t:"auth", но с разным полем.
  function sendAuth() {
    if (!authSecret) return false;
    var msg =
      authSecret.kind === "pin"
        ? { t: "auth", pin: authSecret.value }
        : authSecret.kind === "pair"
          ? { t: "auth", pair: authSecret.value }
          : { t: "auth", session: authSecret.value };
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ─── Вызов канала (очередь до авторизации) ───
  function call(ch, args) {
    return new Promise(function (resolve, reject) {
      if (!authed) {
        queue.push({ ch: ch, args: args || [], resolve: resolve, reject: reject });
        return;
      }
      sendCall(ch, args || [], resolve, reject);
    });
  }

  function sendCall(ch, args, resolve, reject) {
    var id = ++seq;
    pending.set(id, { resolve: resolve, reject: reject });
    try {
      ws.send(JSON.stringify({ t: "call", id: id, ch: ch, args: args }));
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  }

  function flushQueue() {
    var q = queue;
    queue = [];
    for (var i = 0; i < q.length; i++) {
      var item = q[i];
      sendCall(item.ch, item.args, item.resolve, item.reject);
    }
  }

  function on(ch) {
    return function (cb) {
      (listeners[ch] = listeners[ch] || []).push(cb);
    };
  }

  function invoke(ch) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      return call(ch, args);
    };
  }

  // ─── API-поверхность (зеркало preload.js) ───
  window.api = {
    isElectron: true,
    getSettings: invoke("settings:get"),
    setSettings: invoke("settings:set"),
    loadChats: invoke("chats:load"),
    saveChats: invoke("chats:save"),
    sendMessage: invoke("ai:send"),
    answerQuestion: invoke("ai:answer"),
    undoStatus: invoke("undo:status"),
    undoRollback: invoke("undo:rollback"),
    stopMessage: invoke("ai:stop"),
    testConnection: invoke("ai:test"),
    listModels: invoke("ai:models"),
    probeLocalModel: invoke("ai:probeLocal"), // замер локальной модели (с телефона тоже)
    policyGroups: invoke("policy:groups"), // группы выдачи секретов (настройки с телефона)
    pickDirectory: invoke("dialog:pickDir"),
    // Куда класть работу агента: выбор папок делается на ПК (окно первого запуска),
    // но список каналов у телефона тот же — иначе разъехавшееся имя ломает
    // сохранение настроек молча.
    setupState: invoke("setup:state"),
    setupSave: invoke("setup:save"),
    onAiEvent: on("ai:event"),
    onChatsReload: on("chats:reload"),

    githubDeviceStart: invoke("github:deviceStart"),
    githubDeviceCancel: invoke("github:deviceCancel"),
    githubDisconnect: invoke("github:disconnect"),
    githubUser: invoke("github:user"),
    onGithubEvent: on("github:event"),
    openExternal: invoke("shell:openExternal"),

    fsListTree: invoke("fs:listTree"),
    fsReadFile: invoke("fs:readFile"),
    fsReadImage: invoke("fs:readImage"),
    fsCreateFile: invoke("fs:createFile"),
    fsCreateFolder: invoke("fs:createFolder"),
    fsWriteFile: invoke("fs:writeFile"),
    fsDelete: invoke("fs:delete"),
    fsImportDropped: invoke("fs:importDropped"),
    fsPathForFile: function () {
      return "";
    },
    fsOpenInExplorer: invoke("fs:openInExplorer"),

    tasksBoard: invoke("tasks:board"),
    // Миссии: с телефона видно, что делает агент, и работу можно поставить на
    // паузу или продолжить — обработчики в main те же, что у окна на ПК.
    missionState: invoke("mission:state"),
    missionPause: invoke("mission:pause"),
    missionStop: invoke("mission:stop"),
    missionResume: invoke("mission:resume"),
    missionOpen: invoke("mission:open"),
    missionFinish: invoke("mission:finish"),
    agentFilesStatus: invoke("agentfiles:status"),
    tasksList: invoke("tasks:list"),
    tasksAdd: invoke("tasks:add"),
    tasksUpdate: invoke("tasks:update"),
    tasksDone: invoke("tasks:done"),
    tasksDelete: invoke("tasks:delete"),
    // Автозадачи запускает только окно на ПК (прогон не должен удваиваться с телефона),
    // но методы интерфейса должны существовать и здесь: иначе вызов на телефоне молча
    // ничего не делает, и причину не видно.
    tasksAutoAck: invoke("tasks:auto-ack"),
    tasksAutoRearm: invoke("tasks:auto-rearm"),
    onTasksChanged: on("tasks:changed"),
    projectsList: invoke("projects:list"),
    projectsCreate: invoke("projects:create"),
    projectsActivate: invoke("projects:activate"),
    projectsRemove: invoke("projects:remove"),

    gitRepoInfo: invoke("git:repoInfo"),
    gitStatus: invoke("git:status"),
    gitLog: invoke("git:log"),
    gitCommitDetail: invoke("git:commitDetail"),
    gitRevert: invoke("git:revert"),
    gitResetHard: invoke("git:resetHard"),
    gitRestore: invoke("git:restore"),
    gitUndoLastCommit: invoke("git:undoLastCommit"),
    gitClone: invoke("git:clone"),
    gitDiff: invoke("git:diff"),
    gitCommit: invoke("git:commit"),
    gitPush: invoke("git:push"),
    gitPull: invoke("git:pull"),
    gitUnstage: invoke("git:unstage"),
    gitRm: invoke("git:rm"),

    githubPickRepo: invoke("github:pickRepo"),
    githubRepos: invoke("github:repos"),
    githubSelectRepo: invoke("github:selectRepo"),
    githubSelectedRepo: invoke("github:selectedRepo"),
    githubUnselectRepo: invoke("github:unselectRepo"),
    githubPublish: invoke("github:publish"),

    termStart: invoke("term:start"),
    termInput: invoke("term:input"),
    termStop: invoke("term:stop"),
    termStatus: invoke("term:status"),
    termComplete: invoke("term:complete"),
    onTermEvent: on("term:event"),

    devStart: invoke("dev:start"),
    devStop: invoke("dev:stop"),
    devStatus: invoke("dev:status"),
    onDevEvent: on("dev:event"),

    // ── Yandex Cloud ──
    // Этого блока в мобильной копии API не было: телефон показывал «Yandex Cloud
    // не подключён» и просил ввести токен заново, хотя на ПК каталог уже выбран,
    // и вообще не мог ни посмотреть статус, ни войти, ни открыть дашборд ресурсов.
    ycStatus: invoke("yc:status"),
    ycSetToken: invoke("yc:setToken"),
    ycFolders: invoke("yc:folders"),
    ycSetFolder: invoke("yc:setFolder"),
    ycSetPermissions: invoke("yc:setPermissions"),
    ycLogout: invoke("yc:logout"),
    ycResources: invoke("yc:resources"),
    ycCosts: invoke("yc:costs"),
    ycCreate: invoke("yc:create"),
    ycDelete: invoke("yc:delete"),
    ycDeploy: invoke("yc:deploy"),
    ycLogs: invoke("yc:logs"),
    ycCliStatus: invoke("yc:cliStatus"),
    ycInstallCli: invoke("yc:installCli"),

    // ── Почта агента ──
    mailTest: invoke("mail:test"),
    mailTestSend: invoke("mail:testSend"),
    mailRecent: invoke("mail:recent"),

    // ── Память диалогов ──
    memoryStats: invoke("memory:stats"),
    memoryDays: invoke("memory:days"),
    memoryOpenDir: invoke("memory:openDir"),
    memoryClear: invoke("memory:clear"),

    // ── Самообновление кода (применяется на ПК, не на телефоне) ──
    otaStatus: invoke("ota:status"),
    otaCheck: invoke("ota:check"),
    otaRollback: invoke("ota:rollback"),
    otaOpenDir: invoke("ota:openDir"),
    otaReset: invoke("ota:reset"),

    // ── Браузер агента: постоянный профиль и свой Chrome по CDP ──
    browserProfileInfo: invoke("browser:profileInfo"),
    browserClearProfile: invoke("browser:clearProfile"),
    browserConnect: invoke("browser:connect"),
    browserConnectInfo: invoke("browser:connectInfo"),

    // ── G4F (локальный/свой OpenAI-совместимый шлюз) ──
    g4fTest: invoke("g4f:test"),
    g4fProbe: invoke("g4f:probe"),

    mobileStatus: invoke("mobile:status"),
    mobilePinRegen: invoke("mobile:pinRegen"),
  };

  // Хост моста: для превью-адресов вида http://localhost:5000 подставляем IP ПК.
  window.mobileApi = { host: location.host, connected: false };

  // ─── PIN-гейт ───
  /* Оформление страницы входа: один инжектируемый <style>, без inline-стилей.
     Тёмная тема «Replit» — как replit-theme.css в приложении (тёмно-синие
     поверхности, синее главное действие, оранжевый только в логотипе;
     тени и градиенты выключены)…
     Ключевое — высота и прокрутка по visualViewport: на телефоне клавиатура
     перекрывает низ экрана, и фиксированная центрированная карточка «прятала»
     кнопку «Подключиться». Теперь карточка центрируется через margin:auto в
     скроллируемом контейнере и потому остаётся доступной при любой высоте
     видимой области. */
  var GATE_CSS = [
    "#mobile-gate{position:fixed;left:0;right:0;top:0;z-index:99999;overflow:auto;-webkit-overflow-scrolling:touch;",
    "background:#0d0d0f;color:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;",
    "font-size:15px;line-height:1.4;-webkit-text-size-adjust:100%;}",
    "#mobile-gate .mg-wrap{display:flex;min-height:100%;box-sizing:border-box;",
    "padding:max(12px,env(safe-area-inset-top)) 16px max(14px,env(safe-area-inset-bottom));}",
    "#mobile-gate .mg-card{margin:auto;width:min(100%,340px);box-sizing:border-box;",
    "background:#18181b;border:1px solid #2a2a2f;border-radius:18px;padding:16px 15px 12px;}",
    "#mobile-gate .mg-top{display:flex;align-items:center;gap:10px;margin-bottom:12px;}",
    "#mobile-gate .mg-logo{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:#f26207;color:#ffffff;",
    "display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;}",
    "#mobile-gate .mg-name{font-size:14.5px;font-weight:600;letter-spacing:.1px;}",
    "#mobile-gate .mg-sub{font-size:11.5px;color:#9da2b3;margin-top:2px;}",
    "#mobile-gate .mg-pin{display:block;width:100%;box-sizing:border-box;text-align:center;",
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:23px;font-weight:600;",
    "letter-spacing:.3em;text-indent:.3em;padding:10px 6px;border-radius:12px;border:1px solid #2a2a2f;",
    "background:#131315;color:#f4f4f5;outline:none;-webkit-appearance:none;appearance:none;}",
    "#mobile-gate .mg-pin::placeholder{color:#6e7684;}",
    "#mobile-gate .mg-pin:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.4);}",
    "#mobile-gate .mg-err{min-height:15px;margin-top:7px;font-size:12px;color:#ee5a5a;}",
    "#mobile-gate .mg-btn{display:block;width:100%;margin-top:5px;padding:13px;border:none;border-radius:12px;",
    "cursor:pointer;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;font-family:inherit;",
    "touch-action:manipulation;-webkit-tap-highlight-color:transparent;}",
    "#mobile-gate .mg-btn:active{background:#3b82f6;}",
    "#mobile-gate .mg-btn:disabled{opacity:.5;}",
    "#mobile-gate .mg-status{min-height:15px;margin-top:9px;font-size:11.5px;color:#6e7684;}",
    "#mobile-gate .mg-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;",
    "margin-top:6px;font-size:11px;color:#6e7684;}",
    "#mobile-gate .mg-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    "#mobile-gate .mg-link{background:none;border:none;padding:4px 0;color:#9da2b3;font-size:11px;",
    "font-family:inherit;text-decoration:underline;cursor:pointer;touch-action:manipulation;}",
    "@media (max-height:430px){#mobile-gate .mg-card{margin:auto auto 0;}}",
    "#mobile-gate.hide{display:none;}",
  ].join("");

  function ensureGateStyle() {
    if (document.getElementById("mobile-gate-css")) return;
    var st = document.createElement("style");
    st.id = "mobile-gate-css";
    st.textContent = GATE_CSS;
    document.head.appendChild(st);
  }

  // Видимая область меняется при появлении клавиатуры — подгоняем высоту
  // карточки-оверлея, иначе поле ввода и кнопка уезжают под клавиатуру.
  function syncGateViewport() {
    if (!gateEl) return;
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight || document.documentElement.clientHeight;
    gateEl.style.height = Math.round(h) + "px";
    gateEl.style.top = Math.round(vv ? vv.offsetTop : 0) + "px";
  }

  function bindGateViewport() {
    if (gateViewportBound) return;
    gateViewportBound = true;
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncGateViewport);
      window.visualViewport.addEventListener("scroll", syncGateViewport);
    }
    window.addEventListener("resize", syncGateViewport);
    window.addEventListener("orientationchange", syncGateViewport);
  }

  function unbindGateViewport() {
    if (!gateViewportBound) return;
    gateViewportBound = false;
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", syncGateViewport);
      window.visualViewport.removeEventListener("scroll", syncGateViewport);
    }
    window.removeEventListener("resize", syncGateViewport);
    window.removeEventListener("orientationchange", syncGateViewport);
  }

  function setGateBusy(on, label) {
    gateBusy = !!on;
    if (!gateEl) return;
    var btn = gateEl.querySelector("#mobile-gate-btn");
    if (!btn) return;
    btn.disabled = gateBusy;
    btn.textContent = gateBusy ? label || "Подключаюсь…" : "Подключиться";
  }

  function gateStatus(msg) {
    if (gateStatusEl) gateStatusEl.textContent = msg || "";
  }

  function showGate() {
    if (gateEl) return;
    ensureGateStyle();
    gateEl = document.createElement("div");
    gateEl.id = "mobile-gate";
    gateEl.innerHTML = [
      '<div class="mg-wrap"><div class="mg-card">',
      '<div class="mg-top"><div class="mg-logo">A</div><div>',
      '<div class="mg-name">NestDev</div>',
      '<div class="mg-sub">PIN из Настроек на ПК → «Мобильный доступ»</div>',
      "</div></div>",
      '<input id="mobile-pin" class="mg-pin" type="tel" inputmode="numeric" pattern="[0-9]*"',
      ' autocomplete="one-time-code" enterkeyhint="go" maxlength="6" placeholder="······" aria-label="PIN" />',
      '<div id="mobile-gate-err" class="mg-err"></div>',
      '<button id="mobile-gate-btn" class="mg-btn" type="button">Подключиться</button>',
      '<div id="mobile-gate-status" class="mg-status"></div>',
      '<div class="mg-foot"><span class="mg-host"></span>',
      '<button id="mobile-gate-retry" class="mg-link" type="button">Переподключиться</button></div>',
      "</div></div>",
    ].join("");
    document.body.appendChild(gateEl);
    pinInput = gateEl.querySelector("#mobile-pin");
    gateErrorEl = gateEl.querySelector("#mobile-gate-err");
    gateStatusEl = gateEl.querySelector("#mobile-gate-status");
    var hostEl = gateEl.querySelector(".mg-host");
    if (hostEl) hostEl.textContent = "ПК: " + gateHost;
    // PIN мог прийти из QR-кода: подставляем его в поле, чтобы человек видел, что
    // именно отправили, и мог поправить, если на ПК PIN уже сменили.
    if (pinInput && enteredPin && !pinInput.value) pinInput.value = enteredPin;
    var btn = gateEl.querySelector("#mobile-gate-btn");
    var retryBtn = gateEl.querySelector("#mobile-gate-retry");

    function tryAuth() {
      if (gateBusy) return;
      var v = String(pinInput.value || "").replace(/\D+/g, "");
      if (v.length < 4) {
        gateError("PIN — минимум 4 цифры.");
        return;
      }
      enteredPin = v;
      gateError("");
      if (!ws || ws.readyState === 3) {
        // Мост не отвечает: подключение могло отвалиться (сменился Wi-Fi).
        gateStatus("Нет связи с ПК. Переподключаюсь…");
        setGateBusy(false);
        connect();
        return;
      }
      if (ws.readyState === 0) {
        setGateBusy(true, "Соединяюсь…");
        gateStatus("PIN отправится сразу после соединения.");
        return;
      }
      setGateBusy(true, "Проверяю PIN…");
      gateStatus("");
      authSecret = { kind: "pin", value: v };
      if (!sendAuth()) {
        setGateBusy(false);
        gateStatus("Соединение не установлено. Пробую снова…");
      }
    }

    btn.onclick = tryAuth;
    if (retryBtn) {
      retryBtn.onclick = function () {
        setGateBusy(false);
        gateStatus("Переподключаюсь к ПК…");
        try {
          if (ws) ws.close();
        } catch (e) {}
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 60);
      };
    }
    pinInput.addEventListener("input", function () {
      var digits = String(pinInput.value || "").replace(/\D+/g, "").slice(0, 6);
      if (digits !== pinInput.value) pinInput.value = digits;
      if (gateErrorEl) gateErrorEl.textContent = "";
      // Шесть цифр введены — подключаемся сами: клавиатура телефона
      // перекрывает кнопку, и дотянуться до неё получается не всегда.
      if (digits.length === 6 && !gateBusy) {
        clearTimeout(gateAutoTimer);
        gateAutoTimer = setTimeout(tryAuth, 220);
      }
    });
    pinInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) tryAuth();
    });
    // Держим поле над клавиатурой (важно для iOS Safari).
    pinInput.addEventListener("focus", function () {
      syncGateViewport();
      setTimeout(function () {
        syncGateViewport();
        if (pinInput && pinInput.scrollIntoView) {
          try {
            pinInput.scrollIntoView({ block: "center", behavior: "smooth" });
          } catch (e) {}
        }
      }, 260);
    });
    bindGateViewport();
    syncGateViewport();
    setTimeout(function () {
      if (pinInput) pinInput.focus();
    }, 120);
  }

  function hideGate() {
    clearTimeout(gateAutoTimer);
    gateAutoTimer = null;
    unbindGateViewport();
    gateBusy = false;
    if (gateEl) {
      gateEl.parentNode && gateEl.parentNode.removeChild(gateEl);
      gateEl = null;
      pinInput = null;
      gateErrorEl = null;
      gateStatusEl = null;
    }
  }

  function gateError(msg) {
    gateStatus("");
    if (gateErrorEl) gateErrorEl.textContent = msg || "";
  }

  // Ошибка ввода: поле очищаем и снова фокусируем — иначе после неверного PIN
  // шесть уже введённых цифр блокировали набор новых.
  function resetPinField() {
    if (!pinInput) return;
    pinInput.value = "";
    enteredPin = "";
    try {
      pinInput.focus();
    } catch (e) {}
  }

  // ─── WebSocket ───
  function connect() {
    if (closed) return;
    // Уже есть живое соединение — второе не поднимаем (иначе события
    // приходят дважды, а «Переподключиться» плодит лишние сокеты).
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      everOpened = true;
      // Свой сеанс — раньше PIN и токена: переподключение не должно ничего
      // спрашивать у человека (и слать секреты, которые уже не нужны).
      if (!authSecret) {
        var sess = readStoredSession();
        if (sess) authSecret = { kind: "session", value: sess };
      }
      if (authSecret) {
        setGateBusy(true, authSecret.kind === "pin" ? "Проверяю PIN…" : "Подключаюсь…");
        sendAuth();
      } else {
        showGate();
        setGateBusy(false);
        gateStatus("Соединение с ПК установлено. Введи PIN.");
      }
    };
    ws.onmessage = function (e) {
      var m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!m) return;
      if (m.t === "auth_ok") {
        authed = true;
        // Мост отдаёт сеанс только тому, кто пришёл с токеном пары: дальше
        // телефон переподключается по нему, а не по PIN.
        if (m.session) {
          storeSession(m.session);
          authSecret = { kind: "session", value: m.session };
        }
        window.mobileApi.connected = true;
        hideGate();
        flushQueue();
        registerSw();
      } else if (m.t === "auth_err") {
        authed = false;
        setGateBusy(false);
        // Что именно устарело — от этого зависит текст. Сеанс гаснет при смене
        // входа на ПК, токен пары — после первого использования: перепутать их
        // значит показать человеку неверную подсказку.
        var wasSession = m.staleSession || (authSecret && authSecret.kind === "session");
        var wasPair = m.badPair || (authSecret && authSecret.kind === "pair");
        if (wasSession) {
          storeSession(""); // сеанс больше не годится — не повторяем его молча
          authSecret = null;
        } else if (wasPair) {
          authSecret = null;
        }
        // Галочку в адресе мог принести QR-код, а вход на ПК уже сменили: гейта
        // могло ещё не быть — тогда ошибка оставалась невидимой (пустой экран).
        if (!gateEl) showGate();
        if (gateEl) {
          resetPinField();
          gateError(
            m.lock
              ? "Слишком много попыток. Вход заблокирован на 5 минут."
              : wasSession
                ? "Подключение устарело — введи PIN с ПК (Настройки → Мобильный доступ)."
                : wasPair
                  ? "Код из QR-кода уже использован — отсканируй новый или введи PIN."
                  : "Неверный PIN. Попробуй ещё раз."
          );
        }
      } else if (m.t === "auth_lock") {
        authed = false;
        setGateBusy(false);
        if (!gateEl) showGate();
        resetPinField();
        gateError("Слишком много неверных попыток. Переподключение…");
      } else if (m.t === "res") {
        var p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.ok) p.resolve(m.v);
          else p.reject(new Error(m.e || "Ошибка вызова"));
        }
      } else if (m.t === "ev") {
        var cbs = listeners[m.ch];
        if (cbs) {
          for (var i = 0; i < cbs.length; i++) {
            try {
              cbs[i](m.v);
            } catch {}
          }
        }
      }
    };
    ws.onclose = function () {
      var wasAuthed = authed;
      authed = false;
      window.mobileApi.connected = false;
      setGateBusy(false);
      // Все зависшие вызовы — отклоняем (соединение упало).
      var pend = pending;
      pending = new Map();
      pend.forEach(function (p) {
        p.reject(new Error("Соединение с ПК потеряно"));
      });
      if (wasAuthed) {
        showGate();
        setGateBusy(false);
        gateStatus("Соединение потеряно. Введи PIN заново.");
      } else if (gateEl) {
        gateStatus("Связь с ПК потеряна. Переподключаюсь…");
      }
      // Моста здесь нет (веб-превью без приложения) — не крутим вечный цикл переподключения.
      if (everOpened || gateEl) scheduleReconnect();
    };
    ws.onerror = function () {
      try {
        ws.close();
      } catch {}
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  }

  function registerSw() {
    try {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      }
    } catch {}
  }

  connect();
})();
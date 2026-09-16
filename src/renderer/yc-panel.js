"use strict";

/* ─── Панель Yandex Cloud: дашборд сервисов и подключение в настройках ────────
   Вынесено из app.js (этап 2 разбора гигантов). Здесь живёт всё, что относится
   к Yandex Cloud: карта сервисов и создаваемых типов, статус подключения и
   встроенного yc CLI, дашборд в правой панели, раскрытие сервиса, логи, деплой
   контейнера и раздел «Yandex Cloud» в настройках.

   Модуль не знает про остальное окно: зависимости приходят одним объектом —
   доступ к DOM ($), IPC (api), всплывашки (toast/confirmModal/inputDialog),
   переходы (openSettings/openSidePanel) и живой доступ к настройкам
   (getSettings — их перезаписывают при смене профиля). За счёт этого модуль
   проверяется без окна, а app.js остаётся про чат и оболочку.

   Обработчики кнопок вешаются вызовом фабрики: app.js вызывает её на том же
   месте, где раньше начинался этот код, — разметка к тому времени уже готова. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.YcPanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (YcPanelDeps) {
  const {
    $, api, isElectron, toast, termAppend,
    confirmModal, inputDialog, openSettings, openSidePanel, getSettings,
  } = YcPanelDeps || {};
  // ── Yandex Cloud (дашборд + настройки) ──
  const YC_CREATABLE = ["ydb", "lockbox", "containerRegistry", "storage", "dns", "serverlessContainers", "vpc"];
  const YC_FORMS = {
    apiGateway: ["шлюз", "шлюза", "шлюзов"],
    certificateManager: ["сертификат", "сертификата", "сертификатов"],
    cdn: ["ресурс", "ресурса", "ресурсов"],
    dns: ["зона", "зоны", "зон"],
    logging: ["группа", "группы", "групп"],
    postbox: ["адрес", "адреса", "адресов"],
    containerRegistry: ["реестр", "реестра", "реестров"],
    iam: ["сервисный аккаунт", "сервисных аккаунта", "сервисных аккаунтов"],
    lockbox: ["секрет", "секрета", "секретов"],
    ydb: ["база", "базы", "баз"],
    storage: ["бакет", "бакета", "бакетов"],
    serverlessContainers: ["контейнер", "контейнера", "контейнеров"],
    vpc: ["сеть", "сети", "сетей"],
  };
  let ycStatusCache = null;
  let ycServicesCache = null;
  let ycDashKey = ""; // ключ развёрнутой карточки дашборда
  let ycTotal = null; // всего ресурсов в каталоге («Облако в цифрах»)
  let ycActiveServices = null; // сервисов с ресурсами

  function ycNounPlural(key, n) {
    const forms = YC_FORMS[key] || ["ресурс", "ресурса", "ресурсов"];
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return n + " " + forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return n + " " + forms[1];
    return n + " " + forms[2];
  }

  async function ycRefreshSettingsUI() {
    if (!isElectron) {
      // веб-превью: управление облаком живёт в main-процессе Electron
      const m = $("yc-settings-msg");
      if (m) m.textContent = "⚠️ Управление Yandex Cloud работает в desktop-приложении (на ПК): здесь можно только посмотреть поля настроек.";
      return;
    }
    const msg = $("yc-settings-msg");
    try {
      const st = await api.ycStatus();
      ycStatusCache = st;
      // Держим локальный объект настроек синхронным: иначе устаревший ycFolderId
      // из формы мог бы затереть только что выбранный каталог при «Сохранить».
      if (st) {
        if (st.folderId !== undefined) getSettings().ycFolderId = st.folderId;
        if (st.folderName !== undefined) getSettings().ycFolderName = st.folderName;
        if (st.cloudId !== undefined) getSettings().ycCloudId = st.cloudId;
      }
      const acc = $("yc-conn-account");
      if (st.loggedIn && st.iamOk) {
        $("yc-conn-status").textContent = "✅ Подключено" + (st.folderName ? " · каталог «" + st.folderName + "»" : "");
        $("yc-conn-status").classList.add("ok");
        ycSetHeaderDot(st.folderId ? "ok" : "warn");
        if (acc) {
          acc.textContent = "Аккаунт: " + ((st.clouds && st.clouds[0] && st.clouds[0].name) || "Yandex") + " · облако: " + (st.cloudId || "—");
          acc.classList.remove("hidden");
        }
        $("yc-token-row").classList.add("hidden");
        $("yc-folder-field").classList.remove("hidden");
        $("yc-perms").classList.remove("hidden");
        const sel = $("s-yc-folder");
        sel.innerHTML = "";
        for (const f of st.folders || []) {
          const o = document.createElement("option");
          o.value = f.id;
          o.textContent = f.name || f.id;
          sel.appendChild(o);
        }
        if (!(st.folders || []).length) {
          const o = document.createElement("option");
          o.value = "";
          o.textContent =
            "⚠️ Каталоги не загрузились" + (st.error ? " — " + String(st.error).slice(0, 80) : "") + " (нажми ↻)";
          sel.appendChild(o);
        }
        if (st.folderId) sel.value = st.folderId;
        $("s-yc-allow-create").checked = !!st.allowCreate;
        $("s-yc-allow-delete").checked = !!st.allowDelete;
        $("s-yc-allow-update").checked = !!st.allowUpdate;
        // Встроенный yc CLI: показываем, стоит ли он (и где) — настройка живёт в папке приложения.
        if (isElectron && api.ycCliStatus) {
          api.ycCliStatus()
            .then((cl) => {
              const el = $("yc-cli-status");
              if (el) el.textContent = cl && cl.installed ? "встроен: " + cl.path : "не установлен";
            })
            .catch(() => {});
        }
      } else {
        $("yc-conn-status").textContent = "Не подключено" + (st.error ? " — " + st.error : "");
        $("yc-conn-status").classList.remove("ok");
        ycSetHeaderDot("off");
        if (acc) acc.classList.add("hidden");
        $("yc-token-row").classList.remove("hidden");
        $("yc-folder-field").classList.add("hidden");
        $("yc-perms").classList.add("hidden");
      }
      if (msg) msg.textContent = "";
    } catch (e) {
      if (msg) msg.textContent = "Ошибка: " + ((e && e.message) || String(e));
    }
  }

  // Экран-подсказка, когда дашборд не может показать ресурсы (нет токена / веб-версия)
  function ycShowOnboard(icon, title, text) {
    const box = $("yc-dash");
    if (box) box.innerHTML = "";
    const sum = $("yc-summary");
    if (sum) sum.classList.add("hidden");
    ycSetHeaderDot("off");
    const onboard = $("yc-onboard");
    if (!onboard) return;
    const ic = onboard.querySelector(".yc-onboard-ic");
    const t = onboard.querySelector(".yc-onboard-title");
    const x = onboard.querySelector(".yc-onboard-text");
    if (ic && icon) ic.textContent = icon;
    if (t && title) t.textContent = title;
    if (x && text) x.textContent = text;
    onboard.classList.remove("hidden");
  }

  function ycHideOnboard() {
    const onboard = $("yc-onboard");
    if (onboard) onboard.classList.add("hidden");
  }

  async function ycLoadDashboard(force) {
    const statusEl = $("yc-dash-status");
    const box = $("yc-dash");
    if (!statusEl || !box) return;
    if (!isElectron) {
      statusEl.textContent = "Только в desktop-приложении";
      ycShowOnboard(
        "🖥",
        "Дашборд доступен в приложении на ПК",
        "Ресурсы Yandex Cloud, деплой и управление из чата работают в desktop-приложении (Windows/macOS/Linux). В веб-превью доступны только настройки: токен, каталог и разрешения агента."
      );
      return;
    }
    if (!ycStatusCache) {
      try {
        ycStatusCache = await api.ycStatus();
      } catch (e) {
        ycStatusCache = { error: (e && e.message) || String(e) };
      }
    }
    const st = ycStatusCache || {};
    if (!st.loggedIn) {
      statusEl.textContent = "🔑 Не подключено";
      ycShowOnboard(
        "☁️",
        "Yandex Cloud не подключён",
        "Подключи OAuth-токен Yandex — и здесь появится живой дашборд: базы YDB, бакеты Object Storage, реестр образов, Serverless-контейнеры, DNS-зоны, секреты Lockbox, API-шлюз и CDN. Агент сможет управлять ресурсами прямо из чата."
      );
      return;
    }
    ycHideOnboard();
    ycSetHeaderDot(st.iamOk === false ? "warn" : "ok");
    statusEl.textContent = "Каталог: " + (st.folderName || st.folderId || "—") + (st.iamOk === false ? " · ⚠️ " + (st.error || "") : "");
    if (!force && ycServicesCache) {
      ycRenderDash();
      return;
    }
    box.innerHTML = '<div class="yc-loading">Загрузка ресурсов…</div>';
    let r;
    try {
      r = await api.ycResources();
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!r || !r.ok) {
      statusEl.textContent = "⚠️ " + ((r && r.error) || "Ошибка загрузки");
      box.innerHTML = "";
      return;
    }
    ycServicesCache = r.services;
    ycTotal = r.total != null ? r.total : null;
    ycActiveServices = r.activeServices != null ? r.activeServices : null;
    ycRenderDash();
  }

  function ycRenderSummary(total, active) {
    const sum = $("yc-summary");
    if (!sum) return;
    sum.classList.remove("hidden");
    sum.innerHTML = "";
    const mk = (text) => {
      const s = document.createElement("span");
      s.className = "yc-summary-item";
      s.textContent = text;
      return s;
    };
    sum.appendChild(mk("🧮 Ресурсов: " + (total == null ? "—" : total)));
    sum.appendChild(mk("Сервисов с ресурсами: " + (active == null ? "—" : active)));
    const failed = (ycServicesCache || []).filter((s) => !s.ok);
    if (failed.length) {
      sum.appendChild(mk("⚠️ Не ответили: " + failed.length + " — " + failed.map((s) => s.title).slice(0, 3).join(", ")));
    }
  }

  function ycRenderDash() {
    const box = $("yc-dash");
    if (!box) return;
    box.innerHTML = "";
    ycRenderSummary(ycTotal, ycActiveServices);
    const svcs = ycServicesCache || [];
    const grid = document.createElement("div");
    grid.className = "yc-grid";
    for (const s of svcs) {
      const card = document.createElement("div");
      card.className = "yc-card" + (ycDashKey === s.key ? " open" : "");
      card.title = s.ok ? "Клик — список ресурсов" : (s.error ? s.error : "API недоступно");
      const head = document.createElement("div");
      head.className = "yc-card-head";
      const icon = document.createElement("span");
      icon.className = "yc-card-icon";
      icon.textContent = s.icon || "☁️";
      const title = document.createElement("span");
      title.className = "yc-card-title";
      title.textContent = s.title;
      head.appendChild(icon);
      head.appendChild(title);
      const body = document.createElement("div");
      body.className = "yc-card-body";
      const count = document.createElement("div");
      count.className = "yc-card-count" + (s.ok ? "" : " err");
      count.textContent = s.ok ? ycNounPlural(s.key, s.count) : "⚠ ошибка API";
      body.appendChild(count);
      if (!s.ok) {
        const err = document.createElement("div");
        err.className = "yc-card-err";
        err.textContent = String(s.error || "API недоступно").slice(0, 200);
        body.appendChild(err);
      }
      if (s.ok && YC_CREATABLE.includes(s.key)) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn btn-small yc-add";
        add.textContent = "＋ Создать";
        add.title = "Создать новый ресурс («" + s.title + "»). Может быть платным.";
        add.onclick = (e) => {
          e.stopPropagation();
          ycCreateFlow(s.key, s.title);
        };
        body.appendChild(add);
      }
      card.appendChild(head);
      card.appendChild(body);
      if (ycDashKey === s.key) {
        const list = document.createElement("div");
        list.className = "yc-card-list";
        if (!s.ok) {
          list.textContent = "Ошибка API: " + (s.error || "недоступно");
        } else if (!s.items || !s.items.length) {
          list.textContent = "Ресурсов нет — нажми «＋ Создать».";
        } else {
          for (const it of s.items.slice(0, 50)) {
            const row = document.createElement("div");
            row.className = "yc-item";
            const nm = document.createElement("span");
            nm.className = "yc-item-name ykc-openable";
            nm.textContent = it.name || it.id || "—";
            nm.title = "Открыть карточку ресурса (" + (it.id || "") + ")";
            // Клик по имени — вход в карточку: поля ресурса и связанные объекты
            // (подсети, образы, ключи, ревизии). Раньше список был тупиком.
            nm.onclick = (e) => {
              e.stopPropagation();
              if (!window.YcConsole) return;
              window.YcConsole.open({
                serviceKey: s.key,
                title: s.title,
                item: it,
                folderId: (ycStatusCache && ycStatusCache.folderId) || "",
              });
            };
            row.appendChild(nm);
            const actions = document.createElement("div");
            actions.className = "yc-item-actions";
            if (s.key === "serverlessContainers" && it.status) {
              const st = document.createElement("span");
              st.className = "yc-status " + String(it.status).toLowerCase();
              st.textContent = it.status;
              actions.appendChild(st);
            }
            if (s.key === "serverlessContainers" && it.url) {
              const go = document.createElement("button");
              go.type = "button";
              go.className = "btn btn-ghost btn-small";
              go.textContent = "↗";
              go.title = "Открыть URL контейнера: " + it.url;
              go.onclick = (e) => {
                e.stopPropagation();
                if (isElectron) api.openExternal(it.url);
              };
              actions.appendChild(go);
            }
            if (s.key === "serverlessContainers") {
              const lg = document.createElement("button");
              lg.type = "button";
              lg.className = "btn btn-ghost btn-small";
              lg.textContent = "📜";
              lg.title = "Логи контейнера (нужен yc CLI)";
              lg.onclick = async (e) => {
                e.stopPropagation();
                let r;
                try {
                  r = await api.ycLogs(s.key, it.id);
                } catch (err) {
                  r = { ok: false, error: (err && err.message) || String(err) };
                }
                if (r && r.ok && r.logs && r.logs.length) {
                  toast("📜 Логи: " + r.logs.length + " записей — открыты в консоли приложения");
                  termAppend("📜 Логи контейнера:\n" + r.logs.slice(-30).join("\n"));
                } else {
                  toast("❌ " + ((r && r.error) || "Логов нет за последние 3 часа"));
                }
              };
              actions.appendChild(lg);
            }
            const del = document.createElement("button");
            del.type = "button";
            del.className = "btn btn-danger btn-small";
            del.textContent = "🗑";
            del.title = "Удалить «" + (it.name || it.id) + "» (необратимо)";
            del.onclick = (e) => {
              e.stopPropagation();
              ycDeleteFlow(s.key, s.title, it);
            };
            actions.appendChild(del);
            row.appendChild(actions);
            list.appendChild(row);
          }
          if (s.items.length > 50) {
            const more = document.createElement("div");
            more.className = "yc-item-more";
            more.textContent = "… и ещё " + (s.items.length - 50);
            list.appendChild(more);
          }
        }
        card.appendChild(list);
      }
      card.onclick = () => {
        // Возврат к дашборду закрывает карточку ресурса — иначе она перекрывала бы
        // список, который пользователь только что открыл.
        if (window.YcConsole && window.YcConsole.isOpen()) window.YcConsole.close();
        ycDashKey = ycDashKey === s.key ? "" : s.key;
        ycRenderDash();
      };
      grid.appendChild(card);
    }
    box.appendChild(grid);
  }

  function ycCreateFlow(serviceKey, title) {
    // Цена — до создания: иначе платный ресурс создаётся вслепую, а счёт
    // пользователь увидит только в Yandex Cloud. Согласие — нажатие «Создать».
    Promise.resolve(api.ycCosts ? api.ycCosts(serviceKey, {}) : null).then((c) => {
      const est = c && c.ok ? c.estimate : null;
      const head = est
        ? (est.needsConfirm ? "Платный ресурс: " : "Ресурс: ") + (est.levelLabel || "") + (est.approxMonth != null ? " · ≈ " + String(est.approxMonth).replace(".", ",") + " ₽/мес" : "")
        : "Цену ресурса проверить не удалось.";
      const lines = c && c.ok && c.lines ? c.lines.slice(0, 6) : [];
      const hint = [head, ...lines, "", "Имя: латиница, цифры, дефис (2–63 символа)."].join("\n");
      inputDialog("＋ Создать: " + title, hint, "Создать").then(async (name) => {
      if (!name) return;
      let r;
      try {
        r = await api.ycCreate(serviceKey, name, { confirmed: true });
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      if (r && r.ok) {
        toast("✅ " + r.message);
        ycServicesCache = null;
        ycLoadDashboard(true);
      } else {
        toast("❌ " + ((r && r.error) || "Ошибка создания"));
      }
      });
    });
  }

  function ycDeleteFlow(serviceKey, title, item) {
    confirmModal("🗑 Удалить «" + (item.name || item.id) + "»?", title + ": удаление необратимо и может стереть данные. Продолжить?", async () => {
      let r;
      try {
        r = await api.ycDelete(serviceKey, item.id);
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      if (r && r.ok) {
        toast("✅ " + r.message);
        ycServicesCache = null;
        ycLoadDashboard(true);
      } else {
        toast("❌ " + ((r && r.error) || "Ошибка удаления"));
      }
    }, true);
  }

  // Обработчики Yandex Cloud
  $("btn-yc-connect").onclick = async () => {
    const t = $("s-yc-token").value.trim();
    if (!t) {
      toast("Вставь OAuth-токен (кнопка «🔑 Получить токен»)");
      return;
    }
    $("btn-yc-connect").disabled = true;
    let r;
    try {
      r = await api.ycSetToken(t);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    $("btn-yc-connect").disabled = false;
    if (r && r.ok) {
      toast("✅ Подключено к Yandex Cloud" + (r.folderName ? " · каталог «" + r.folderName + "»" : ""));
      ycStatusCache = null;
      ycServicesCache = null;
      ycRefreshSettingsUI();
      ycLoadDashboard(true);
    } else {
      toast("❌ " + ((r && r.error) || "Не удалось войти"));
    }
  };
  function ycTokenUrl() {
    return (ycStatusCache && ycStatusCache.oauthUrl) || "https://oauth.yandex.ru/authorize?response_type=token&client_id=1a6990aa636648e9b2ef855fa7bec2fb";
  }
  function ycOpenTokenPage() {
    const url = ycTokenUrl();
    if (isElectron) api.openExternal(url);
    else window.open(url, "_blank");
  }
  // Точка у кнопки «☁️» в шапке: зелёная — подключено, жёлтая — нужен каталог/IAM
  function ycSetHeaderDot(state) {
    const cls = "hd-dot" + (state === "ok" ? " ok" : state === "warn" ? " warn" : "");
    const d = $("btn-toggle-cloud-dot");
    if (d) d.className = cls;
    const rd = $("rail-cloud-dot");
    if (rd) rd.className = cls;
    const b = $("btn-toggle-cloud");
    if (b) {
      b.title =
        state === "ok"
          ? "Yandex Cloud подключён — ресурсы каталога и деплой"
          : state === "warn"
            ? "Yandex Cloud: проверь каталог или токен"
            : "Yandex Cloud — ресурсы каталога и деплой";
    }
  }
  $("btn-yc-get-token").onclick = ycOpenTokenPage;
  $("btn-yc-logout").onclick = () => {
    confirmModal("Выйти из Yandex Cloud?", "OAuth-токен будет удалён из приложения. Ресурсы в облаке не пострадают.", async () => {
      await api.ycLogout();
      ycStatusCache = null;
      ycServicesCache = null;
      ycRefreshSettingsUI();
      ycLoadDashboard(true);
      toast("Выход выполнен");
    });
  };
  $("btn-yc-refresh-folders").onclick = async () => {
    const sel0 = $("s-yc-folder");
    if (sel0) sel0.innerHTML = '<option value="">⏳ Загрузка каталогов…</option>';
    const r = await api.ycFolders();
    if (!r || !r.ok) {
      const msg = (r && r.error) || "Не удалось загрузить каталоги";
      // Раньше список просто оставался пустым (и «висел» без объяснения причины).
      if (sel0) sel0.innerHTML = '<option value="">⚠️ ' + String(msg).slice(0, 120) + ' — повтори ↻</option>';
      toast("❌ " + msg);
      return;
    }
    const sel = $("s-yc-folder");
    sel.innerHTML = "";
    for (const f of r.folders || []) {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.name || f.id;
      sel.appendChild(o);
    }
    if (ycStatusCache && ycStatusCache.folderId) sel.value = ycStatusCache.folderId;
    toast("Каталогов: " + ((r.folders || []).length));
  };
  $("s-yc-folder").onchange = () => {
    const sel = $("s-yc-folder");
    const f = (ycStatusCache && ycStatusCache.folders || []).find((x) => x.id === sel.value);
    api.ycSetFolder(sel.value, (f && f.name) || sel.value, (f && f.cloudId) || (ycStatusCache && ycStatusCache.cloudId) || "");
    // Каталог сохранён в main — отражаем это и в локальном объекте настроек.
    getSettings().ycFolderId = sel.value;
    getSettings().ycFolderName = (f && f.name) || sel.value;
    getSettings().ycCloudId = (f && f.cloudId) || (ycStatusCache && ycStatusCache.cloudId) || "";
    ycStatusCache = null;
    ycServicesCache = null;
    toast("Каталог: " + (f && f.name ? f.name : sel.value));
    ycLoadDashboard(true);
  };
  // Одна точка сохранения разрешений: чекбоксов три, а вызов один — иначе легко
  // забыть передать третье поле и молча сбросить его в false.
  function saveYcPerms() {
    const create = $("s-yc-allow-create").checked;
    const del = $("s-yc-allow-delete").checked;
    const upd = $("s-yc-allow-update").checked;
    api.ycSetPermissions(create, del, upd);
    return { create, del, upd };
  }
  $("s-yc-allow-create").onchange = () => {
    toast(saveYcPerms().create ? "Агенту разрешено создавать ресурсы" : "Создание агентом выключено");
  };
  $("s-yc-allow-delete").onchange = () => {
    toast(saveYcPerms().del ? "Агенту разрешено удалять ресурсы" : "Удаление агентом выключено");
  };
  $("s-yc-allow-update").onchange = () => {
    const p = saveYcPerms();
    toast(p.upd ? "Агенту разрешено менять контейнеры и деплоить ревизии" : "Правка контейнеров агентом выключена");
  };
  if ($("btn-yc-install-cli")) {
    $("btn-yc-install-cli").onclick = async () => {
      if (!isElectron || !api.ycInstallCli) {
        toast("yc CLI ставится в desktop-приложении");
        return;
      }
      const btn = $("btn-yc-install-cli");
      const stEl = $("yc-cli-status");
      btn.disabled = true;
      if (stEl) stEl.textContent = "скачиваю официальный yc CLI…";
      try {
        const r = await api.ycInstallCli();
        if (r && r.ok) {
          if (stEl) stEl.textContent = "встроен: " + (r.path || "");
          toast(r.already ? "yc CLI уже установлен" : "✅ yc CLI установлен" + (r.version ? " (версия " + r.version + ")" : ""));
        } else {
          if (stEl) stEl.textContent = "не установлен";
          toast("❌ " + ((r && r.error) || "не удалось установить yc CLI"));
        }
      } catch (e) {
        if (stEl) stEl.textContent = "не установлен";
        toast("❌ " + ((e && e.message) || String(e)));
      }
      btn.disabled = false;
    };
  }
  $("btn-yc-dash-refresh").onclick = () => {
    ycServicesCache = null;
    ycLoadDashboard(true);
  };
  $("btn-yc-dash-settings").onclick = () => openSettings("yandex");
  // Из настроек — сразу открыть дашборд
  if ($("btn-yc-open-dash")) {
    $("btn-yc-open-dash").onclick = () => {
      $("settings-overlay").classList.add("hidden");
      openSidePanel("cloud");
    };
  }
  if ($("btn-yc-onboard-settings")) {
    $("btn-yc-onboard-settings").onclick = () => {
      openSettings("yandex");
    };
  }
  if ($("btn-yc-onboard-token")) $("btn-yc-onboard-token").onclick = ycOpenTokenPage;
  $("btn-yc-paste-token").onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) {
        $("s-yc-token").value = t.trim();
        toast("Токен вставлен из буфера — нажми «Войти»");
      } else {
        toast("Буфер обмена пуст");
      }
    } catch (e) {
      toast("Не удалось прочитать буфер: " + ((e && e.message) || String(e)));
    }
  };
  $("btn-yc-deploy").onclick = () => {
    if (!isElectron) {
      toast("Деплой доступен в desktop-приложении");
      return;
    }
    const dir = getSettings().workingDir || "";
    if (!dir) {
      toast("Сначала выбери рабочую директорию (Настройки → 📁 Проект и GitHub)");
      return;
    }
    inputDialog("🚀 Деплой на Yandex Cloud", "Папка: " + dir + "\nИмя приложения (латиница, 2–63 символа). Docker должен быть установлен и запущен.", "Задеплоить").then(async (name) => {
      if (!name) return;
      const box = $("yc-deploy-box");
      const stepsEl = $("yc-deploy-steps");
      const resultEl = $("yc-deploy-result");
      box.classList.remove("hidden");
      stepsEl.innerHTML = "";
      resultEl.classList.add("hidden");
      stepsEl.innerHTML = '<div class="yc-loading">⏳ Деплой… (docker build может занять несколько минут)</div>';
      let r;
      try {
        r = await api.ycDeploy(dir, name, {});
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      stepsEl.innerHTML = "";
      for (const s of (r && r.steps) || []) {
        const d = document.createElement("div");
        d.className = "yc-step";
        d.textContent = s;
        stepsEl.appendChild(d);
      }
      if (r && r.ok) {
        if (r.url) {
          $("yc-deploy-url").textContent = r.url;
          resultEl.classList.remove("hidden");
        }
        toast("✅ Деплой завершён");
        ycServicesCache = null;
        ycLoadDashboard(true);
      } else {
        const d = document.createElement("div");
        d.className = "yc-step err";
        d.textContent = "❌ " + ((r && r.error) || "Ошибка деплоя");
        stepsEl.appendChild(d);
      }
    });
  };
  $("btn-yc-deploy-open").onclick = () => {
    const u = $("yc-deploy-url").textContent.trim();
    if (u && isElectron) api.openExternal(u);
  };
  // Наружу — только то, что зовёт оболочка окна: открыть дашборд (при заходе на
  // вкладку «cloud») и обновить статус подключения в настройках.
  return {
    loadDashboard: ycLoadDashboard,
    refreshSettingsUI: ycRefreshSettingsUI,
  };
});

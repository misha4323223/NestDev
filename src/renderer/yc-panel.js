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
    // Managed-базы (часть 88): у каждой своя плитка, и счёт обязан говорить
    // «2 кластера», а не «2 ресурса» — кластер PostgreSQL не то же самое, что
    // база YDB: её создают по-другому и платят иначе.
    postgresql: ["кластер", "кластера", "кластеров"],
    mysql: ["кластер", "кластера", "кластеров"],
    clickhouse: ["кластер", "кластера", "кластеров"],
    // Машины пришли на полку позже остальных (часть 75): без своей формы счёт
    // говорил бы «1 ресурс» там, где человек ждёт «1 машина».
    compute: ["машина", "машины", "машин"],
    instanceGroups: ["группа машин", "группы машин", "групп машин"],
    storage: ["бакет", "бакета", "бакетов"],
    serverlessContainers: ["контейнер", "контейнера", "контейнеров"],
    vpc: ["сеть", "сети", "сетей"],
  };
  let ycStatusCache = null;
  let ycServicesCache = null;
  let ycDashKey = ""; // ключ развёрнутой карточки дашборда
  let ycTotal = null; // всего ресурсов в каталоге («Облако в цифрах»)
  let ycActiveServices = null; // сервисов с ресурсами
  // Панель «полкой»: официальные иконки сервисов (yc-logos.js), поиск и
  // фильтр по полке, строка здоровья облака с балансом и платными хвостами.
  const YCL = typeof YcLogos !== "undefined" ? YcLogos : null;
  let ycFilter = "all"; // all | used | err
  let ycSearch = "";
  let ycLeaksOpen = false;
  let ycHealth = null; // ответ ycBilling(overview): платёжный аккаунт и хвосты
  let ycHealthErr = "";
  let ycHealthBusy = false;

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
        $("s-yc-allow-public").checked = !!st.allowPublic;
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
      ycLoadHealth();
      return;
    }
    ycMountBrand();
    ycMountCredit();
    box.innerHTML = "";
    box.appendChild(ycSkeleton(6));
    ycRenderHealth();
    let r;
    try {
      r = await api.ycResources();
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!r || !r.ok) {
      statusEl.textContent = "⚠️ " + ((r && r.error) || "Ошибка загрузки");
      box.innerHTML = "";
      const bad = document.createElement("div");
      bad.className = "yc-empty";
      bad.textContent = "Ресурсы не загрузились: " + ((r && r.error) || "облако не ответило") + ". Проверь токен и каталог, затем нажми ↻.";
      box.appendChild(bad);
      ycLoadHealth(!!force);
      return;
    }
    ycServicesCache = r.services;
    ycTotal = r.total != null ? r.total : null;
    ycActiveServices = r.activeServices != null ? r.activeServices : null;
    ycRenderDash();
    ycLoadHealth(!!force);
  }

  // ── Деньги, фильтр и иконки: всё, что делает панель «полкой» ────────────
  function ycMoney(v) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    const parts = Math.abs(n).toFixed(2).split(".");
    return (n < 0 ? "−" : "") + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + parts[1] + " ₽";
  }

  function ycTiles() {
    const q = ycSearch.trim().toLowerCase();
    return (ycServicesCache || []).filter((s) => {
      if (ycFilter === "used" && !(s.ok && s.count > 0)) return false;
      if (ycFilter === "err" && s.ok) return false;
      if (!q) return true;
      const hay = [s.ru, s.title, s.key, YCL ? YCL.official(s.key) : ""].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // Русское имя — то, как сервис называется в консоли облака; официальное
  // английское имя остаётся в подсказке (и в заголовке SVG при наведении).
  function ycServiceName(s) {
    return (s && (s.ru || s.title)) || "Сервис";
  }

  function ycLogoEl(key) {
    const box = document.createElement("span");
    box.className = "yc-tile-logo";
    if (YCL) {
      box.innerHTML = YCL.svgFor(key);
      const off = YCL.official(key);
      if (off) box.title = "Иконка сервиса: " + off;
    }
    return box;
  }

  // Знак платформы вставляем ровно один раз: внутри него есть id (clipPath), и
  // вторая вставка сломала бы ссылки.
  function ycMountBrand() {
    const host = $("yc-brand-mark");
    if (!host || host.dataset.filled === "1" || !YCL) return;
    host.innerHTML = YCL.uniqueIds(YCL.brand());
    host.dataset.filled = "1";
  }

  // Подпись под панелью: откуда иконки и — прямо — что приложение не продукт
  // Яндекс.Облака. Так требует и брендбук (никакой «причастности» Яндекса).
  function ycMountCredit() {
    const el = $("yc-credit");
    if (!el || el.dataset.filled === "1" || !YCL) return;
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "библиотека брендбука";
    link.title = YCL.SOURCE;
    link.onclick = (e) => {
      e.preventDefault();
      if (isElectron) api.openExternal(YCL.SOURCE);
    };
    el.appendChild(document.createTextNode("Иконки сервисов — официальная "));
    el.appendChild(link);
    el.appendChild(document.createTextNode(" Yandex Cloud (апрель 2026). Приложение работает с вашим аккаунтом Yandex Cloud и не является продуктом Яндекс.Облака."));
    el.dataset.filled = "1";
  }

  function ycSkeleton(n) {
    const grid = document.createElement("div");
    grid.className = "yc-grid";
    for (let i = 0; i < n; i += 1) {
      const t = document.createElement("div");
      t.className = "yc-skel yc-skel-tile";
      grid.appendChild(t);
    }
    return grid;
  }

  // Какой счёт показать одной цифрой, когда их НЕСКОЛЬКО: сначала тот, у которого
  // баланс в минусе (облако остановит ресурсы), затем выключенный, затем первый
  // по списку. Складывать балансы разных счетов нельзя — это разные деньги.
  function ycWorstAccount(list) {
    const rank = (a) => (Number(a.balance) < 0 ? 0 : a.active ? 2 : 1);
    return (
      (list || [])
        .slice()
        .sort((a, b) => rank(a) - rank(b) || (Number(a.balance) || 0) - (Number(b.balance) || 0))[0] || null
    );
  }

  // Строка про один платёжный аккаунт для подсказки чипа: имя, баланс, состояние.
  // Минус и «ВЫКЛЮЧЕН» называем прямо — именно из-за них облако останавливает
  // ресурсы, и человеку это нужно видеть без открытия «Денег».
  function ycAccountLine(a) {
    const negative = Number(a.balance) < 0;
    return (
      "Платёжный аккаунт «" + (a.name || a.id) + "» · " + (a.balanceHuman || ycMoney(a.balance)) +
      " · " + (a.active ? "активен" : "ВЫКЛЮЧЕН") +
      (negative ? " · баланс в минусе: новые ресурсы не создадутся, пока он не станет положительным" : "")
    );
  }

  // Строка здоровья: сколько ресурсов, что не ответило, баланс и — главное —
  // платные хвосты в рублях. Деньги берём у биллинга (он один знает баланс и
  // правило «что такое хвост»), но ждать его полка не обязана.
  function ycRenderHealth() {
    const sum = $("yc-summary");
    if (!sum) return;
    if (!ycServicesCache && !ycHealth && !ycHealthErr && !ycHealthBusy) {
      sum.classList.add("hidden");
      return;
    }
    sum.classList.remove("hidden");
    sum.innerHTML = "";
    const row = document.createElement("div");
    row.className = "yc-health";
    const chip = (label, value, opt) => {
      const o = opt || {};
      const node = document.createElement(o.onClick ? "button" : "span");
      node.className = "yc-chip" + (o.cls ? " " + o.cls : "") + (o.onClick ? " yc-chip-link" : "");
      if (o.onClick) {
        node.type = "button";
        node.onclick = o.onClick;
      }
      if (o.title) node.title = o.title;
      node.appendChild(document.createTextNode(label + " "));
      const b = document.createElement("b");
      b.textContent = value == null ? "—" : String(value);
      node.appendChild(b);
      return node;
    };
    row.appendChild(chip("Ресурсов", ycTotal == null ? "—" : ycTotal, { title: "Всего ресурсов в каталоге" }));
    row.appendChild(chip("Сервисов с ресурсами", ycActiveServices == null ? "—" : ycActiveServices, {}));
    const failed = (ycServicesCache || []).filter((s) => !s.ok);
    if (failed.length) {
      row.appendChild(
        chip("Ошибки API", failed.length, {
          cls: "err",
          title: failed.map((s) => s.title + ": " + (s.error || "нет ответа")).join("\n"),
        })
      );
    }

    const h = ycHealth;
    if (ycHealthBusy) {
      row.appendChild(chip("Деньги", "проверяю…", {}));
    } else if (ycHealthErr) {
      row.appendChild(
        chip("Баланс", "не видно", {
          cls: "warn",
          title: "Биллинг недоступен: " + ycHealthErr + "\nЧастая причина — нет роли billing.viewer: без неё облако не отдаёт платёжные аккаунты.",
        })
      );
    } else if (h && (h.account || (h.accounts || []).length)) {
      // Счетов может быть НЕСКОЛЬКО, и биллинг намеренно не выбирает за человека
      // (в yc-billing.js это закреплено тестом «аккаунт угадан при двух
      // доступных»). Но чип обязан назвать деньги: раньше в этой ветке стояло
      // «аккаунта нет», и человек читал «счёта нет вовсе», хотя счета и балансы
      // были видны в «Деньгах». Теперь чип берёт САМЫЙ ТРЕВОЖНЫЙ счёт (минус →
      // выключенный → первый), а все остальные показываются в подсказке.
      const list = (h.accounts && h.accounts.length ? h.accounts : [h.account]).filter(Boolean);
      const acc = h.account || ycWorstAccount(list);
      const negative = Number(acc.balance) < 0;
      const many = list.length > 1;
      row.appendChild(
        chip("Баланс", (acc.balanceHuman || ycMoney(acc.balance)) + (many ? " · счётов: " + list.length : ""), {
          cls: negative ? "err" : list.some((a) => a.active === false) ? "warn" : "ok",
          title:
            list.map((a) => ycAccountLine(a)).join("\n") +
            (many ? "\nПоказан самый тревожный счёт. Остальные — в «Деньги · подробнее» и в списке аккаунтов." : ""),
          onClick: many ? () => ycOpenActions("billing", "", "Биллинг") : undefined,
        })
      );
    } else if (h) {
      row.appendChild(
        chip("Баланс", "нет счёта", {
          cls: "warn",
          title: "Платёжных аккаунтов нет: облако не привязано к счёту — платные ресурсы создавать некуда.",
        })
      );
    }
    if (h && h.leaks) {
      const leaks = h.leaks;
      row.appendChild(
        chip("Хвосты", leaks.count + " · " + ycMoney(leaks.total) + "/мес", {
          cls: leaks.count ? "warn" : "ok",
          onClick: leaks.count
            ? () => {
                ycLeaksOpen = !ycLeaksOpen;
                ycRenderHealth();
              }
            : undefined,
          title: leaks.count ? "Платные хвосты: за что платят, хотя уже не нужно. Клик — список." : "Платных хвостов нет: диски привязаны к машинам, лишнего не видно.",
        })
      );
      if (leaks.running && leaks.running.length) {
        row.appendChild(
          chip("Работает", leaks.running.length + " · " + ycMoney(leaks.live) + "/мес", {
            title: "Работающие машины — это текущий счёт, а не мусор: круглосуточно столько.",
          })
        );
      }
    }
    // Деньги умеют больше, чем сводка: пороги-бюджеты, услуги и живые цены по
    // слову. Это тоже действия, поэтому вход в них — здесь, рядом с балансом, а
    // не спрятан в настройках.
    if (window.YcActions && window.YcActions.forService("billing").length) {
      row.appendChild(
        chip("Деньги", "подробнее", {
          onClick: () => ycOpenActions("billing", "", "Биллинг"),
          title: "Платёжные аккаунты, пороги-бюджеты, услуги и цены по слову — без агента",
        })
      );
    }
    // Яндекс AI живёт не ресурсом каталога, а ЗАПРОСОМ к сервису: у него нет ни
    // списка объектов, ни плитки на полке (плитка — это список, а списка у
    // перевода и речи не бывает), и иконки в официальной библиотеке брендбука для
    // него тоже нет. Поэтому вход в его действия — здесь, рядом с «Деньгами»:
    // тот же ряд, та же честность «без агента».
    if (window.YcActions && window.YcActions.forService("ai").length) {
      row.appendChild(
        chip("🧠 Яндекс AI", "перевод · снимки · речь", {
          onClick: () => ycOpenActions("ai", "", "Яндекс AI"),
          title: "Перевод (сразу на несколько языков), текст со снимка и PDF, озвучка и расшифровка записи — без агента, тем же токеном облака",
        })
      );
    }
    sum.appendChild(row);

    if (ycLeaksOpen && h && h.leaks && h.leaks.tails && h.leaks.tails.length) {
      const box = document.createElement("div");
      box.className = "yc-leaks";
      const head = document.createElement("div");
      head.className = "yc-leaks-head";
      head.textContent = "Платные хвосты — " + h.leaks.tails.length + " на " + ycMoney(h.leaks.total) + " в месяц";
      box.appendChild(head);
      for (const t of h.leaks.tails.slice().sort((a, b) => (Number(b.month) || 0) - (Number(a.month) || 0))) {
        const line = document.createElement("div");
        line.className = "yc-leak";
        const why = document.createElement("span");
        why.className = "yc-leak-why";
        why.textContent = t.why;
        why.appendChild(document.createElement("br"));
        const todo = document.createElement("span");
        todo.className = "yc-leak-todo";
        todo.textContent = "Что делать: " + t.todo;
        why.appendChild(todo);
        const summ = document.createElement("span");
        summ.className = "yc-leak-sum";
        summ.textContent = "≈ " + (t.monthHuman || ycMoney(t.month));
        line.appendChild(why);
        line.appendChild(summ);
        box.appendChild(line);
      }
      sum.appendChild(box);
    }
  }

  // Деньги спрашиваем отдельным запросом и не блокируя полку: биллинг может
  // быть недоступен (нет роли), а ресурсы при этом видны — и молчать об этом
  // нельзя, поэтому «Баланс не видно» с причиной, а не пустое место.
  async function ycLoadHealth(force) {
    if (!isElectron || !api.ycBilling) {
      ycHealthErr = "биллинг доступен в desktop-приложении";
      ycRenderHealth();
      return;
    }
    if (ycHealthBusy) return;
    if (ycHealth && !force) {
      ycRenderHealth();
      return;
    }
    ycHealthBusy = true;
    ycRenderHealth();
    let r;
    try {
      r = await api.ycBilling({ op: "overview" });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    ycHealthBusy = false;
    if (r && r.ok) {
      ycHealth = r;
      ycHealthErr = "";
    } else {
      ycHealth = null;
      ycHealthErr = (r && r.error) || "биллинг не ответил";
    }
    ycRenderHealth();
  }

  // Список ресурсов раскрытой плитки: имя ведёт в карточку ресурса (обзор и
  // связанные объекты), справа — состояние, адрес, логи и удаление.
  function ycResourceList(s) {
    const list = document.createElement("div");
    list.className = "yc-tile-list";
    if (!s.ok) {
      // В СВЁРНУТОЙ плитке полный отказ не печатаем: длинный текст заслонял
      // полку, а та же ошибка читалась дважды (сверху и здесь). Свёрнутая плитка
      // говорит только «⚠ ошибка API», причина — в подсказке при наведении, а
      // развёрнутая показывает текст целиком и без обрезки.
      const err = document.createElement("div");
      err.className = "yc-card-err";
      err.textContent = "Ошибка API: " + (s.error || "недоступно");
      list.appendChild(err);
      return list;
    }
    if (!s.items || !s.items.length) {
      list.textContent = "Ресурсов нет — нажми «＋ Создать».";
      return list;
    }
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
          title: ycServiceName(s),
          item: it,
          folderId: (ycStatusCache && ycStatusCache.folderId) || "",
        });
      };
      row.appendChild(nm);
      const actions = document.createElement("div");
      actions.className = "yc-item-actions";
      // Действия по КОНКРЕТНОМУ ресурсу: то, ради чего список вообще нужен.
      // Сервис без набора действий кнопки не получает — пустая кнопка хуже её
      // отсутствия.
      if (window.YcActions && window.YcActions.forService(s.key).length) {
        const act = document.createElement("button");
        act.type = "button";
        act.className = "btn btn-ghost btn-small";
        act.textContent = "⚙";
        act.title = "Что можно сделать с «" + (it.name || it.id) + "» прямо здесь (не через агента)";
        act.onclick = (e) => {
          e.stopPropagation();
          ycOpenActions(s.key, it.name || it.id || "", ycServiceName(s));
        };
        actions.appendChild(act);
      }
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
          let lr;
          try {
            lr = await api.ycLogs(s.key, it.id);
          } catch (err) {
            lr = { ok: false, error: (err && err.message) || String(err) };
          }
          if (lr && lr.ok && lr.logs && lr.logs.length) {
            toast("📜 Логи: " + lr.logs.length + " записей — открыты в консоли приложения");
            termAppend("📜 Логи контейнера:\n" + lr.logs.slice(-30).join("\n"));
          } else {
            toast("❌ " + ((lr && lr.error) || "Логов нет за последние 3 часа"));
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
    return list;
  }

  function ycRenderDash() {
    const box = $("yc-dash");
    if (!box) return;
    ycMountBrand();
    ycMountCredit();
    box.innerHTML = "";
    ycRenderHealth();
    if (!ycServicesCache) {
      box.appendChild(ycSkeleton(6));
      return;
    }
    const svcs = ycTiles();
    if (!svcs.length) {
      const empty = document.createElement("div");
      empty.className = "yc-empty";
      empty.textContent =
        ycSearch.trim() || ycFilter !== "all"
          ? "Ничего не нашлось: сбрось поиск или выбери «Все»."
          : "Список сервисов пуст — нажми ↻, чтобы спросить облако снова.";
      box.appendChild(empty);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "yc-grid";
    for (const s of svcs) {
      const card = document.createElement("div");
      card.className = "yc-tile" + (ycDashKey === s.key ? " open" : "");
      card.title = s.ok
        ? YCL && YCL.official(s.key)
          ? "Клик — список ресурсов. Сервис Yandex Cloud: " + YCL.official(s.key)
          : "Клик — список ресурсов"
        : s.error
          ? s.error
          : "API недоступно";
      const top = document.createElement("div");
      top.className = "yc-tile-top";
      top.appendChild(ycLogoEl(s.key));
      const body = document.createElement("div");
      body.className = "yc-tile-body";
      const title = document.createElement("div");
      title.className = "yc-tile-name";
      title.textContent = ycServiceName(s);
      const count = document.createElement("div");
      count.className = "yc-tile-count" + (s.ok ? "" : " err");
      count.textContent = s.ok ? ycNounPlural(s.key, s.count) : "⚠ ошибка API";
      body.appendChild(title);
      body.appendChild(count);
      top.appendChild(body);
      const dot = document.createElement("span");
      dot.className = "yc-tile-dot" + (s.ok ? (s.count > 0 ? " on" : "") : " err");
      top.appendChild(dot);
      card.appendChild(top);
      const canCreate = s.ok && YC_CREATABLE.includes(s.key);
      const canAct = !!(window.YcActions && window.YcActions.forService(s.key).length);
      if (canCreate || canAct) {
        const btns = document.createElement("div");
        btns.className = "yc-tile-btns";
        if (canCreate) {
          const add = document.createElement("button");
          add.type = "button";
          add.className = "yc-tile-add";
          add.textContent = "＋ Создать";
          add.title = "Создать новый ресурс («" + ycServiceName(s) + "»). Может быть платным.";
          add.onclick = (e) => {
            e.stopPropagation();
            ycCreateFlow(s.key, s.title);
          };
          btns.appendChild(add);
        }
        if (canAct) {
          const act = document.createElement("button");
          act.type = "button";
          act.className = "yc-tile-add";
          act.textContent = "⚙ Действия";
          act.title = "Создать машину, выдать роль, выкатить версию, выпустить сертификат — в этом окне, без агента.";
          act.onclick = (e) => {
            e.stopPropagation();
            ycOpenActions(s.key, "", ycServiceName(s));
          };
          btns.appendChild(act);
        }
        card.appendChild(btns);
      }
      if (ycDashKey === s.key) card.appendChild(ycResourceList(s));
      card.onclick = () => {
        // Возврат к полке закрывает карточку ресурса — иначе она перекрывала бы
        // список, который пользователь только что открыл.
        if (window.YcConsole && window.YcConsole.isOpen()) window.YcConsole.close();
        ycDashKey = ycDashKey === s.key ? "" : s.key;
        ycRenderDash();
      };
      grid.appendChild(card);
    }
    box.appendChild(grid);
  }

  // Общее окно действий облака (src/renderer/yc-actions.js): список действий
  // сервиса, формы, цена и подтверждение. Панель передаёт только то, чего модуль
  // не знает, — какой сервис открыт и что перечитать после успеха.
  function ycOpenActions(serviceKey, target, title) {
    const A = window.YcActions;
    if (!A) {
      toast("❌ Действия облака работают в приложении на ПК (desktop).");
      return;
    }
    if (window.YcConsole && window.YcConsole.isOpen()) window.YcConsole.close();
    A.open({
      service: serviceKey,
      target: target || "",
      targetLabel: title || "",
      onDone: () => {
        // Действие изменило облако — полка обязана перечитаться, иначе покажет
        // то, чего уже нет (или не покажет того, что появилось).
        ycServicesCache = null;
        ycLoadDashboard(true);
      },
    });
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
  // Одна точка сохранения разрешений: чекбоксов четыре, а вызов один — иначе
  // легко забыть передать последнее поле и молча сбросить его в false.
  // ВАЖНО: сразу правим и локальное зеркало настроек (getSettings()). Иначе кнопка
  // «Сохранить» в панели настроек пишет ЦЕЛИКОМ старое зеркало (persistSettings →
  // api.setSettings) и только что включённый чекбокс возвращается в false.
  function saveYcPerms() {
    const create = $("s-yc-allow-create").checked;
    const del = $("s-yc-allow-delete").checked;
    const upd = $("s-yc-allow-update").checked;
    const pub = $("s-yc-allow-public").checked;
    api.ycSetPermissions(create, del, upd, pub);
    const s = getSettings();
    s.ycAllowAgentCreate = create;
    s.ycAllowAgentDelete = del;
    s.ycAllowAgentUpdate = upd;
    s.ycAllowAgentPublic = pub;
    return { create, del, upd, pub };
  }
  $("s-yc-allow-create").onchange = () => {
    toast(saveYcPerms().create ? "Агенту разрешено создавать ресурсы, ключи и функции" : "Создание агентом выключено");
  };
  $("s-yc-allow-delete").onchange = () => {
    toast(saveYcPerms().del ? "Агенту разрешено удалять ресурсы, машины, снимки, аккаунты и функции" : "Удаление агентом выключено");
  };
  $("s-yc-allow-update").onchange = () => {
    const p = saveYcPerms();
    toast(p.upd ? "Агенту разрешено менять контейнеры, правила сети, машины, роли и функции" : "Правка контейнеров, правил сети, машин, ролей и функций агентом выключена");
  };
  $("s-yc-allow-public").onchange = () => {
    toast(saveYcPerms().pub ? "Агенту разрешено открывать бакет для чтения из интернета" : "Публичный доступ к бакету агентом выключен");
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
    ycHealth = null; // баланс и хвосты меняются без нас — перечитываем
    ycLoadDashboard(true);
  };
  $("btn-yc-dash-settings").onclick = () => openSettings("yandex");
  // Поиск и фильтр правят полку на месте, без обращения к облаку: данные уже
  // загружены, а ждать сеть ради перерисовки списка незачем.
  if ($("yc-search")) {
    $("yc-search").oninput = () => {
      ycSearch = $("yc-search").value;
      ycRenderDash();
    };
  }
  const ycFilterBox = $("yc-filter");
  if (ycFilterBox && ycFilterBox.querySelectorAll) {
    for (const b of ycFilterBox.querySelectorAll(".yc-filter-btn")) {
      b.onclick = () => {
        ycFilter = b.dataset ? b.dataset.flt || "all" : "all";
        for (const x of ycFilterBox.querySelectorAll(".yc-filter-btn")) x.classList.toggle("active", x === b);
        ycRenderDash();
      };
    }
  }
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

"use strict";

/* ─── Секреты: пароли сайтов, почта и переменные окружения ─────────────────────
   Вынесено из app.js (этап 3 разбора гигантов). Всё, что относится к трём вкладкам
   секретов: менеджер паролей (список, добавление, правка, удаление), панель почты
   (пресеты серверов, проверка входа, тестовое письмо, последние письма) и переменные
   окружения агента (добавление, удаление, импорт текстом и из файла, выдача переменной
   группам инструментов по таблице прав главного процесса).

   Пароли здесь только собираются и никогда не показываются: в списке — маска, а при
   правке поле пароля намеренно пустое (пароль вводится заново). Шифрование делает
   главный процесс (secrets.json + safeStorage/DPAPI) — сюда значения приходят из
   настроек, а уходят обратно вместе с ними.

   Зависимости приходят одним объектом: DOM ($), IPC (api), признак desktop-приложения
   (isElectron), всплывашки (toast), сохранение настроек (persistSettings) и живые
   настройки (getSettings) — объект настроек перезаписывают, копия устарела бы молча.
   Обработчики кнопок вешаются вызовом фабрики на прежнем месте app.js. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.SecretsPanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (SecretsPanelDeps) {
  const { $, api, isElectron, toast, persistSettings, getSettings } = SecretsPanelDeps || {};

  // ─────────────── Пароли сайтов (Настройки → Секреты) ───────────────
  // Записи живут в getSettings().sitePasswords и уходят в main.js вместе с настройками —
  // там они шифруются (secrets.json + safeStorage/DPAPI). В интерфейсе пароль
  // никогда не показывается: только пометка «пароль: ••••••«.
  function vaultArr() {
    return Array.isArray(getSettings().sitePasswords) ? getSettings().sitePasswords : [];
  }

  let vaultEditingId = ""; // id записи, которую правим (пусто — добавляем новую)

  function renderVault() {
    const box = $("vault-list");
    if (!box) return;
    const list = vaultArr();
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML =
        '<div class="env-note">Записей пока нет. Добавь сайт ниже — агент сможет входить на него сам (vaultFill), не спрашивая пароль в чате.</div>';
      return;
    }
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const row = document.createElement("div");
      row.className = "env-row";
      const name = document.createElement("span");
      name.className = "env-key";
      name.textContent = e.name || e.url || "Сайт";
      name.title = e.name || "";
      const val = document.createElement("span");
      val.className = "env-val";
      const bits = [];
      if (e.url) bits.push(e.url);
      bits.push(e.login ? "логин: " + e.login : "логин не задан");
      bits.push(e.password ? "пароль: ••••••" : "пароль не задан");
      if (e.note) bits.push("📝 " + e.note);
      val.textContent = bits.join(" · ");
      val.title = e.note ? "Заметка: " + e.note : "";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn-ghost btn-small";
      edit.textContent = "✏️";
      edit.title = "Загрузить запись в форму для правки";
      edit.onclick = () => vaultLoadToForm(e);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-small env-del";
      del.textContent = "🗑";
      del.title = "Удалить запись " + (e.name || e.url || "");
      del.onclick = () => vaultDelete(e.id);
      row.appendChild(name);
      row.appendChild(val);
      row.appendChild(edit);
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  function vaultLoadToForm(e) {
    vaultEditingId = e.id || "";
    $("s-vault-name").value = e.name || "";
    $("s-vault-url").value = e.url || "";
    $("s-vault-login").value = e.login || "";
    $("s-vault-pass").value = "";
    $("s-vault-note").value = e.note || "";
    toast("Запись загружена. Пароль введи заново — в форме он не показывается.");
  }

  function vaultClearForm() {
    vaultEditingId = "";
    for (const id of ["s-vault-name", "s-vault-url", "s-vault-login", "s-vault-pass", "s-vault-note"]) {
      if ($(id)) $(id).value = "";
    }
  }

  function vaultAdd() {
    const entry = {
      id: vaultEditingId || "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: $("s-vault-name").value.trim(),
      url: $("s-vault-url").value.trim(),
      login: $("s-vault-login").value.trim(),
      password: $("s-vault-pass").value,
      note: $("s-vault-note").value.trim(),
    };
    if (!entry.name && !entry.url) {
      toast("Укажи название или адрес сайта");
      return;
    }
    if (!entry.login && !entry.password) {
      toast("Заполни хотя бы логин или пароль");
      return;
    }
    if (!Array.isArray(getSettings().sitePasswords)) getSettings().sitePasswords = [];
    const i = getSettings().sitePasswords.findIndex((x) => x && x.id === entry.id);
    if (i >= 0) getSettings().sitePasswords[i] = entry;
    else getSettings().sitePasswords.push(entry);
    persistSettings();
    vaultClearForm();
    renderVault();
    toast(i >= 0 ? "Запись обновлена" : "Запись сохранена зашифрованно");
  }

  function vaultDelete(id) {
    const list = vaultArr();
    const e = list.find((x) => x && x.id === id);
    if (!e) return;
    if (!confirm("Удалить запись «" + (e.name || e.url || "сайт") + "»?")) return;
    getSettings().sitePasswords = list.filter((x) => x && x.id !== id);
    persistSettings();
    renderVault();
    toast("Запись удалена");
  }

  // ─────────────── Почта (Настройки → ✉️ Почта) ───────────────
  function renderMailStatus(text, isError) {
    const box = $("mail-msg");
    if (!box) return;
    box.textContent = text || "";
    box.classList.toggle("error", !!isError);
  }

  // Пресеты провайдеров (та же логика, что в src/mail.js) — чтобы кнопка
  // «Определить по адресу» работала и без запроса к main-процессу.
  function mailGuessed() {
    const a = String($("s-mail-address") ? $("s-mail-address").value : "").trim().toLowerCase();
    if (/@(gmail|googlemail)\.com$/.test(a)) return { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465, starttls: false, note: "Gmail: нужен «пароль приложения» (включается при двухфакторной аутентификации)." };
    if (/@(yandex|ya)\.(ru|com|kz|by|ua)$/.test(a)) return { imapHost: "imap.yandex.ru", imapPort: 993, smtpHost: "smtp.yandex.ru", smtpPort: 465, starttls: false, note: "Яндекс: включи IMAP в «Все настройки → Почтовые программы» и создай пароль приложения." };
    if (/@mail\.ru$/.test(a)) return { imapHost: "imap.mail.ru", imapPort: 993, smtpHost: "smtp.mail.ru", smtpPort: 465, starttls: false, note: "Mail.ru: нужен пароль для внешнего приложения." };
    if (/@(outlook|hotmail|live|msn)\./.test(a)) return { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587, starttls: true, note: "Outlook: SMTP через STARTTLS (587)." };
    if (/@rambler\.ru$/.test(a)) return { imapHost: "imap.rambler.ru", imapPort: 993, smtpHost: "smtp.rambler.ru", smtpPort: 465, starttls: false, note: "" };
    const d = a.includes("@") ? a.split("@").pop() : "";
    return {
      imapHost: d ? "imap." + d : "",
      imapPort: 993,
      smtpHost: d ? "smtp." + d : "",
      smtpPort: 465,
      starttls: false,
      note: d ? "Провайдер не опознан — проверь адреса серверов и порты." : "",
    };
  }

  function mailFillServers() {
    const g = mailGuessed();
    if (g.imapHost) $("s-mail-imap-host").value = g.imapHost;
    if (g.imapPort) $("s-mail-imap-port").value = String(g.imapPort);
    if (g.smtpHost) $("s-mail-smtp-host").value = g.smtpHost;
    if (g.smtpPort) $("s-mail-smtp-port").value = String(g.smtpPort);
    $("s-mail-starttls").checked = !!g.starttls;
    renderMailStatus(g.note || "Серверы заполнены — проверь и нажми «Сохранить настройки».", false);
  }

  function mailRenderList(res) {
    const box = $("mail-list");
    if (!box) return;
    box.innerHTML = "";
    if (!res || !res.ok) { renderMailStatus((res && res.error) || "Не удалось прочитать почту.", true); return; }
    if (!res.messages || !res.messages.length) { renderMailStatus("Входящих писем нет.", false); return; }
    for (const m of res.messages) {
      const row = document.createElement("div");
      row.className = "env-row";
      const subj = document.createElement("div");
      subj.className = "env-key";
      subj.textContent = (m.code ? "🔑 " + m.code + " · " : "") + (m.subject || "(без темы)");
      const meta = document.createElement("div");
      meta.className = "env-val";
      meta.textContent = (m.from || "") + " · " + (m.date || "");
      row.appendChild(subj);
      row.appendChild(meta);
      box.appendChild(row);
    }
    renderMailStatus("Последние письма: " + res.messages.length + " из " + (res.total || res.messages.length) + ".", false);
  }

  async function mailDoTest() {
    if (!isElectron) { renderMailStatus("Проверка почты доступна в desktop-приложении.", true); return; }
    renderMailStatus("Проверяю вход в ящик…", false);
    try {
      const r = await api.mailTest();
      if (r && r.ok) {
        const s = r.servers || {};
        renderMailStatus(
          "✓ Вход выполнен. Писем в ящике: " + (r.total || 0) +
          " · IMAP " + (s.imapHost || "") + ":" + (s.imapPort || "") +
          " · SMTP " + (s.smtpHost || "") + ":" + (s.smtpPort || ""),
          false
        );
      } else {
        const note = r && r.servers && r.servers.note ? "\n" + r.servers.note : "";
        renderMailStatus("✗ " + ((r && r.error) || "Не удалось войти.") + note, true);
      }
    } catch (e) {
      renderMailStatus("✗ Ошибка: " + ((e && e.message) || e), true);
    }
  }

  async function mailDoTestSend() {
    if (!isElectron) { renderMailStatus("Отправка доступна в desktop-приложении.", true); return; }
    renderMailStatus("Отправляю тестовое письмо…", false);
    try {
      const r = await api.mailTestSend();
      const addr = $("s-mail-address") ? $("s-mail-address").value.trim() : "";
      renderMailStatus(r && r.ok ? "✓ Тестовое письмо отправлено на " + addr + ". Проверь входящие." : "✗ " + ((r && r.error) || "Не удалось отправить."), !(r && r.ok));
    } catch (e) {
      renderMailStatus("✗ Ошибка: " + ((e && e.message) || e), true);
    }
  }

  async function mailDoRecent() {
    if (!isElectron) { renderMailStatus("Чтение почты доступно в desktop-приложении.", true); return; }
    renderMailStatus("Читаю последние письма…", false);
    try {
      mailRenderList(await api.mailRecent(5));
    } catch (e) {
      renderMailStatus("✗ Ошибка: " + ((e && e.message) || e), true);
    }
  }


  // ─────────────── Секреты: переменные окружения (Настройки) ───────────────
  // ── Выдача секретов: кому подставлять переменную ───────────────────────────
  // Названия групп приходят из таблицы прав главного процесса (policy:groups):
  // список у интерфейса свой, но собирается он из политики — разойтись не могут.
  let envScopeGroupList = null;
  const ENV_SCOPE_LABELS = {
    agent: "ожидание", api: "внешние API", app: "окно приложения", browser: "браузер",
    clipboard: "буфер обмена", cloud: "облако", db: "базы данных", files: "файлы проекта",
    git: "git и GitHub", mail: "почта", media: "картинки", notes: "заметки и чекпоинты",
    preview: "превью и ссылки", project: "сборка, тесты, зависимости", screen: "экран",
    secrets: "переменные агента", self: "обновление приложения", system: "система",
    tasks: "дела", terminal: "терминал и команды", vault: "пароли сайтов", web: "поиск в сети",
  };
  function envScopeLabel(g) {
    return ENV_SCOPE_LABELS[g] || g;
  }
  function envScopeGroups() {
    if (envScopeGroupList) return envScopeGroupList;
    if (!isElectron || !api.policyGroups) return [];
    api.policyGroups().then((list) => {
      envScopeGroupList = Array.isArray(list) ? list : [];
      renderEnvVars(); // группы пришли после первой отрисовки — перерисовываем один раз
    }).catch(() => {
      envScopeGroupList = [];
    });
    return [];
  }
  // Выдача переменной: "*" — всем, "none" — никому, группа/имя — ей, "__multi" — несколько.
  function envScopeValue(k) {
    const sc = getSettings().agentEnvScopes || {};
    if (!(k in sc)) return "*";
    const list = Array.isArray(sc[k]) ? sc[k] : [];
    if (!list.length) return "none";
    if (list.indexOf("*") !== -1) return "*";
    return list.length === 1 ? list[0] : "__multi";
  }
  function setEnvScope(k, v) {
    if (!getSettings().agentEnvScopes) getSettings().agentEnvScopes = {};
    // «Всем» — это отсутствие записи: так файл настроек остаётся чистым, а поведение
    // по умолчанию (как раньше) видно по самому отсутствию ограничения.
    if (v === "*") delete getSettings().agentEnvScopes[k];
    else if (v === "none") getSettings().agentEnvScopes[k] = [];
    else if (v !== "__multi") getSettings().agentEnvScopes[k] = [v];
    persistSettings();
    renderEnvVars();
  }

  function renderEnvVars() {
    const box = $("env-list");
    if (!box) return;
    const vars = getSettings().agentEnv || {};
    const keys = Object.keys(vars);
    box.innerHTML = "";
    if (!keys.length) {
      box.innerHTML = '<div class="env-note">Переменных пока нет. Добавь вручную ниже или импортируй из файла .env.</div>';
      return;
    }
    const groups = envScopeGroups();
    for (const k of keys) {
      const v = String(vars[k] || "");
      const row = document.createElement("div");
      row.className = "env-row";
      const kEl = document.createElement("span");
      kEl.className = "env-key";
      kEl.textContent = k;
      kEl.title = k;
      const vEl = document.createElement("span");
      vEl.className = "env-val";
      vEl.textContent = v ? "•••••••• (" + v.length + " симв.)" : "(пусто)";
      vEl.title = v ? "Значение скрыто — оно подставляется только тем, кому выдано" : "";
      // Выдача: кому эта переменная подставляется.
      const current = envScopeValue(k);
      const sel = document.createElement("select");
      sel.className = "env-scope" + (current === "*" ? "" : " limited");
      sel.title = "Кому подставлять «" + k + "»";
      const add = (value, text) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
      };
      add("*", "Всем командам");
      add("none", "Ни одному инструменту");
      const stored = (getSettings().agentEnvScopes || {})[k];
      if (current === "__multi") add("__multi", "Несколько: " + (Array.isArray(stored) ? stored.join(", ") : ""));
      for (const g of groups) add(g.group, envScopeLabel(g.group) + " — " + g.tools + " инстр.");
      // Точная capability (её задал envSet) в списке групп не найдётся — показываем как есть.
      if (Array.isArray(stored)) {
        for (const s of stored) {
          if (s === "*") continue;
          if (!groups.some((g) => g.group === s)) add(s, s);
        }
      }
      sel.value = current;
      sel.onchange = () => setEnvScope(k, sel.value);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-small env-del";
      del.textContent = "🗑";
      del.title = "Удалить " + k;
      del.onclick = () => envDelete(k);
      row.appendChild(kEl);
      row.appendChild(vEl);
      row.appendChild(sel);
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  function envAdd() {
    const k = $("s-env-key").value.trim();
    const v = $("s-env-value").value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      toast("Имя переменной: латиница, цифры, подчёркивание (например DATABASE_URL)");
      return;
    }
    if (!getSettings().agentEnv) getSettings().agentEnv = {};
    getSettings().agentEnv[k] = v;
    persistSettings();
    $("s-env-key").value = "";
    $("s-env-value").value = "";
    renderEnvVars();
    toast("Переменная " + k + " сохранена");
  }

  function envDelete(k) {
    if (!getSettings().agentEnv || !(k in getSettings().agentEnv)) return;
    delete getSettings().agentEnv[k];
    // Выдача живёт вместе с переменной: осиротевшее ограничение потом выдало бы
    // себя, когда переменную создадут заново.
    if (getSettings().agentEnvScopes && k in getSettings().agentEnvScopes) delete getSettings().agentEnvScopes[k];
    persistSettings();
    renderEnvVars();
    toast("Удалено: " + k);
  }

  // Парсит .env-текст: строки KEY=VALUE, комментарии # и ;, префикс export, кавычки значения.
  function parseEnvText(text) {
    const vars = {};
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      if (line.startsWith("export ")) line = line.slice(7).trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  }

  function envImportText() {
    const text = $("s-env-import").value;
    if (!text.trim()) {
      toast("Вставь список строк вида KEY=VALUE");
      return;
    }
    const vars = parseEnvText(text);
    const keys = Object.keys(vars);
    if (!keys.length) {
      toast("Не нашёл строк вида KEY=VALUE");
      return;
    }
    if (!getSettings().agentEnv) getSettings().agentEnv = {};
    for (const k of keys) getSettings().agentEnv[k] = vars[k];
    persistSettings();
    $("s-env-import").value = "";
    renderEnvVars();
    toast("Импортировано переменных: " + keys.length);
  }

  function envImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const vars = parseEnvText(String(reader.result || ""));
      const keys = Object.keys(vars);
      if (!getSettings().agentEnv) getSettings().agentEnv = {};
      for (const k of keys) getSettings().agentEnv[k] = vars[k];
      persistSettings();
      renderEnvVars();
      toast(keys.length ? "Импортировано из файла: " + keys.length + " переменных" : "В файле нет строк вида KEY=VALUE");
    };
    reader.readAsText(file);
  }

  return {
    renderVault: renderVault,
    renderEnvVars: renderEnvVars,
    envAdd: envAdd,
    envImportText: envImportText,
    envImportFile: envImportFile,
    vaultAdd: vaultAdd,
    vaultClearForm: vaultClearForm,
    mailFillServers: mailFillServers,
    mailDoTest: mailDoTest,
    mailDoTestSend: mailDoTestSend,
    mailDoRecent: mailDoRecent,
  };
});

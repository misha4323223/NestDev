"use strict";

/* ─── Консоль Yandex Cloud в правой панели ───────────────────────────────────
   Отдельный модуль: app.js только открывает/закрывает его. Данные приходят из
   главного процесса (src/yc-console.js) уже готовыми — подписи полей, значения
   и таблицы; здесь ничего не форматируется и не запрашивается напрямую.

   Как выглядит (по образцу консоли Yandex Cloud): «← Назад», заголовок ресурса,
   затем «Обзор» со всеми полями ресурса и «Связанные объекты» — плитки со
   счётчиками (подсети у сети, образы у реестра, ключи у сервисного аккаунта,
   ревизии у контейнера), по клику раскрывается таблица.

   Кроме чтения, в карточке есть действия, без которых ресурс бесполезен: у секрета
   — новая версия (без версии ревизия ссылается на несуществующий ключ), у зоны DNS
   — запись (без неё домен никуда не ведёт). Необратимая чистка — удаление записи DNS
   и образа реестра — спрашивает подтверждением у панели (window.uiConfirm), а не
   одним кликом. Удаление самих ресурсов, логи и деплой остаются на карточке сервиса
   в дашборде. Разрешения «агенту можно…» здесь не спрашиваются: они ограничивают
   МОДЕЛЬ, а не человека, который сам открыл свой ресурс в своём окне. */

(function () {
  const state = {
    open: false,
    serviceKey: "",
    serviceTitle: "",
    item: null,
    folderId: "",
    data: null,
    relation: "",
    relationData: null,
    bucketAccess: null,
    busy: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function apiCall(name, args) {
    const api = window.api;
    if (!api || typeof api[name] !== "function") return Promise.resolve({ ok: false, error: "Доступно в приложении на ПК." });
    return api[name](args).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
  }

  // Контейнер консоли живёт внутри панели облака: дашборд не переписывается,
  // просто уступает место карточке.
  function ensureBox() {
    const panel = $("sp-cloud");
    if (!panel) return null;
    let b = $("yc-console");
    if (!b) {
      b = el("div", "yc-console hidden");
      b.id = "yc-console";
      panel.appendChild(b);
    }
    return b;
  }

  function setVisible(on) {
    const b = ensureBox();
    const dash = $("yc-dash");
    const sum = $("yc-summary");
    const onboard = $("yc-onboard");
    if (b) b.classList.toggle("hidden", !on);
    if (dash) dash.classList.toggle("hidden", on);
    if (sum) sum.classList.toggle("hidden", on);
    if (on && onboard) onboard.classList.add("hidden");
  }

  function isOpen() {
    return state.open;
  }

  async function open(opts) {
    const o = opts || {};
    const box = ensureBox();
    if (!box) return;
    state.open = true;
    state.serviceKey = String(o.serviceKey || "");
    state.serviceTitle = String(o.title || "");
    state.item = o.item || {};
    state.folderId = String(o.folderId || "");
    state.data = null;
    state.relation = "";
    state.relationData = null;
    state.bucketAccess = null;
    setVisible(true);
    render();
    const r = await apiCall("ycConsoleOverview", {
      serviceKey: state.serviceKey,
      id: state.item.id || "",
      item: state.item,
      folderId: state.folderId,
    });
    if (!state.open) return;
    state.data = r && r.ok ? r : null;
    state.error = r && !r.ok ? r.error : "";
    // Публичность бакета — не поле карточки, а отдельный запрос: показывать её
    // надо ДО того, как человек нажмёт кнопку, иначе переключатель был бы вслепую.
    if (state.open && state.serviceKey === "storage" && state.item && state.item.name) {
      const acc = await apiCall("ycConsoleBucketAccess", { op: "get", bucket: state.item.name });
      if (!state.open) return;
      state.bucketAccess = acc && acc.ok ? acc : { ok: false, error: (acc && acc.error) || "не удалось прочитать" };
    }
    render();
  }

  function close() {
    state.open = false;
    state.relation = "";
    state.relationData = null;
    setVisible(false);
  }

  // ── Отрисовка ─────────────────────────────────────────────────────────────
  function render() {
    const box = ensureBox();
    if (!box) return;
    box.innerHTML = "";
    const item = state.item || {};
    const data = state.data;

    // Шапка: назад, сервис, имя ресурса.
    const head = el("div", "ykc-head");
    const back = el("button", "btn btn-ghost btn-small ykc-back", "← Назад");
    back.title = "К списку сервисов";
    back.onclick = close;
    head.appendChild(back);
    const titles = el("div", "ykc-titles");
    const sub = el("div", "ykc-sub", (data && data.subtitle) || state.serviceTitle || "Yandex Cloud");
    const title = el("div", "ykc-title", (data && data.title) || item.name || item.id || "ресурс");
    titles.appendChild(sub);
    titles.appendChild(title);
    head.appendChild(titles);
    const refresh = el("button", "btn btn-ghost btn-small", "↻");
    refresh.title = "Обновить карточку";
    refresh.onclick = () => open({ serviceKey: state.serviceKey, title: state.serviceTitle, item: state.item, folderId: state.folderId });
    head.appendChild(refresh);
    box.appendChild(head);

    if (state.error) {
      box.appendChild(el("div", "ykc-err", state.error));
      return;
    }
    if (!data) {
      box.appendChild(el("div", "ykc-loading", "Читаю ресурс…"));
      return;
    }
    if (data.detailError) {
      box.appendChild(el("div", "ykc-warn", "Часть данных не удалось уточнить: " + data.detailError));
    }
    if (item.url) {
      const go = el("button", "btn btn-small ykc-open", "↗ Открыть адрес");
      go.onclick = () => {
        if (window.api && window.api.openExternal) window.api.openExternal(item.url);
      };
      box.appendChild(go);
    }

    // Обзор: все поля ресурса.
    box.appendChild(sectionTitle("Обзор"));
    if (!data.fields.length && !data.extra.length) {
      box.appendChild(el("div", "ykc-empty", "API не вернул полей для этого ресурса."));
    } else {
      const dl = el("div", "ykc-fields");
      for (const f of data.fields) {
        const row = el("div", "ykc-field");
        row.appendChild(el("span", "ykc-flabel", f.label));
        const val = el("span", "ykc-fvalue" + (f.kind === "str" ? "" : " mono"), f.value);
        val.title = f.value;
        row.appendChild(val);
        dl.appendChild(row);
      }
      box.appendChild(dl);
    }
    for (const x of data.extra) {
      const det = document.createElement("details");
      det.className = "ykc-extra";
      const s = document.createElement("summary");
      s.textContent = x.label;
      det.appendChild(s);
      const pre = el("pre", "ykc-json", JSON.stringify(x.value, null, 2));
      det.appendChild(pre);
      box.appendChild(det);
    }

    // Секрет Lockbox: добавить версию. Секрет без версии бесполезен — ревизия
    // ссылается на ключ, которого нет, а до сих пор версию умел только деплой.
    if (state.serviceKey === "lockbox" && item.id) {
      box.appendChild(sectionTitle("Новая версия"));
      box.appendChild(secretVersionForm());
    }

    // Зона DNS: поставить запись. Зону создать было можно, а запись — нет:
    // без этого домен подключить нечем.
    if (state.serviceKey === "dns" && item.id) {
      box.appendChild(sectionTitle("Новая запись"));
      box.appendChild(dnsRecordForm());
    }

    // Бакет: публичный доступ. Ссылки на объекты закрытого бакета отдают 403, и
    // без этого переключателя причина отказа была видна только в консоли Yandex
    // Cloud. Открытый бакет виден ПОИСКОВИКАМ — поэтому с вопросом, как у удаления.
    if (state.serviceKey === "storage" && item.name) {
      box.appendChild(sectionTitle("Публичный доступ"));
      box.appendChild(bucketAccessBox());
    }

    // Публичный доступ к бакету: показать состояние и переключить его. Переключение
  // необратимо для пользователя (файлы уезжают в общий доступ), поэтому спрашиваем
  // тем же модальным окном, что удаление, и говорим прямым текстом, что именно
  // станет видно.
  function bucketAccessBox() {
    const wrap = el("div", "ykc-access");
    const acc = state.bucketAccess;
    if (!acc || acc.ok === false) {
      const err = el("div", "ykc-warn", "Не удалось прочитать публичный доступ: " + ((acc && acc.error) || "нет данных"));
      const retry = el("button", "btn btn-ghost btn-small", "↻ Повторить");
      retry.onclick = async () => {
        retry.disabled = true;
        const r = await apiCall("ycConsoleBucketAccess", { op: "get", bucket: (state.item && state.item.name) || "" });
        retry.disabled = false;
        state.bucketAccess = r && r.ok ? r : { ok: false, error: (r && r.error) || "нет данных" };
        render();
      };
      wrap.appendChild(err);
      wrap.appendChild(retry);
      return wrap;
    }
    const isPublic = !!(acc.flags && acc.flags.read);
    const line = el("div", "ykc-hint",
      isPublic
        ? "Бакет открыт: объекты читает любой, кто знает ссылку, и содержимое видно поисковикам."
        : "Бакет закрыт: по ссылке storage.yandexcloud.net/<бакет>/<файл> придёт отказ 403 — это нормально для закрытого бакета.");
    const btn = el("button", "btn btn-small ykc-bucket-access", isPublic ? "🔒 Закрыть бакет" : "🌐 Открыть бакет");
    btn.title = isPublic
      ? "Снять анонимное чтение: объекты перестанут открываться по ссылке"
      : "Разрешить анонимное чтение: объекты будут открываться по ссылке у всех, кто её знает";
    const name = (state.item && state.item.name) || "";
    btn.onclick = () => {
      const go = async () => {
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = "…";
        const r = await apiCall("ycConsoleBucketAccess", { op: "set", bucket: name, public: !isPublic });
        btn.disabled = false;
        btn.textContent = prev;
        const say = window.uiToast || function () {};
        say(r && r.ok
          ? (r.public ? "🌐 Бакет открыт для чтения из интернета" : "🔒 Бакет закрыт")
          : "❌ " + ((r && r.error) || "не удалось сменить публичный доступ"));
        state.bucketAccess = r && r.ok ? r : acc;
        render();
      };
      const title = isPublic ? "🔒 Закрыть бакет?" : "🌐 Открыть бакет для всех?";
      const text = isPublic
        ? "Объекты бакета «" + name + "» перестанут открываться по ссылке — придёт отказ 403. Сами файлы останутся на месте, доступ вернуть можно этой же кнопкой."
        : "ЛЮБОЙ, кто узнает ссылку на файл, сможет его прочитать, а содержимое станет видно поисковикам. Не открывай бакет с паролями, ключами и личными файлами — для закрытого хранения есть Lockbox.";
      if (typeof window.uiConfirm === "function") window.uiConfirm(title, text, go, !isPublic);
      else if (window.confirm(title + " " + text)) go();
    };
    wrap.appendChild(line);
    wrap.appendChild(btn);
    return wrap;
  }

  // Связанные объекты: плитки со счётчиками.
    const rels = data.relations || [];
    if (rels.length) {
      box.appendChild(sectionTitle("Связанные объекты"));
      const chips = el("div", "ykc-rels");
      box.appendChild(chips);
      const tableBox = el("div", "ykc-tablebox");
      box.appendChild(tableBox);
      const paint = (r) => {
        chips.innerHTML = "";
        for (const rel of rels) {
          const c = el("button", "tk-chip ykc-rel" + (state.relation === rel.key ? " active" : "") + (rel.ok ? "" : " bad"));
          c.title = rel.ok ? "Показать: " + rel.title : rel.error;
          const label = el("span", null, (rel.icon ? rel.icon + " " : "") + rel.title);
          const num = el("span", "tk-n", rel.ok ? String(rel.count) : "!");
          c.appendChild(label);
          c.appendChild(num);
          c.onclick = () => loadRelation(rel);
          chips.appendChild(c);
        }
      };
      paint();
      if (state.relation) renderRelation(tableBox);
      else tableBox.appendChild(el("div", "ykc-hint", "Клик по плитке — покажу содержимое."));
    }
  }

  // ── Карточка секрета: новая версия ────────────────────────────────────────
  // Пары «ключ → значение» уходят в Lockbox напрямую и в приложении не
  // сохраняются: значения не читаются обратно и в подтверждении показываются
  // только имена ключей.
  function secretVersionForm() {
    const wrap = el("div", "ykc-secret");
    wrap.appendChild(el("div", "ykc-hint", "Значения уходят в Yandex Cloud и в приложении не сохраняются. Ключ — латиница, цифры и знаки - _ . / \\ @."));
    const rows = el("div", "ykc-secret-rows");
    wrap.appendChild(rows);
    const addRow = () => {
      const row = el("div", "ykc-secret-row");
      const k = document.createElement("input");
      k.className = "ykc-secret-key";
      k.placeholder = "КЛЮЧ";
      k.spellcheck = false;
      const v = document.createElement("input");
      v.type = "password";
      v.className = "ykc-secret-val";
      v.placeholder = "значение";
      v.spellcheck = false;
      const eye = el("button", "btn btn-ghost btn-small", "👁");
      eye.type = "button";
      eye.title = "Показать значение";
      eye.onclick = () => { v.type = v.type === "password" ? "text" : "password"; };
      const del = el("button", "btn btn-ghost btn-small", "✕");
      del.type = "button";
      del.title = "Убрать пару";
      del.onclick = () => {
        rows.removeChild(row);
        if (!rows.children.length) addRow(); // без единой строки форму не заполнить
      };
      row.appendChild(k);
      row.appendChild(v);
      row.appendChild(eye);
      row.appendChild(del);
      rows.appendChild(row);
    };
    addRow();
    const btns = el("div", "ykc-secret-btns");
    const more = el("button", "btn btn-ghost btn-small", "＋ Ещё ключ");
    more.type = "button";
    more.onclick = () => addRow();
    const save = el("button", "btn btn-primary btn-small", "Сохранить версию");
    save.type = "button";
    save.onclick = async () => {
      const entries = [];
      for (const row of rows.children) {
        const k = row.querySelector(".ykc-secret-key");
        const v = row.querySelector(".ykc-secret-val");
        const key = String((k && k.value) || "").trim();
        if (!key) continue;
        entries.push({ key: key, value: (v && v.value) || "" });
      }
      const say = window.uiToast || function () {};
      if (!entries.length) {
        say("❌ Нужна хотя бы одна пара «ключ → значение»");
        return;
      }
      save.disabled = true;
      save.textContent = "Сохраняю…";
      const r = await apiCall("ycConsoleSecretVersion", {
        secretId: (state.item && state.item.id) || "",
        entries: entries,
      });
      save.disabled = false;
      save.textContent = "Сохранить версию";
      if (r && r.ok) {
        // Значения не называем даже здесь: в подтверждении только ключи.
        say("🔒 Версия создана: " + (r.versionId || "—") + " · ключи: " + ((r.keys || []).join(", ") || "—"));
        open({ serviceKey: state.serviceKey, title: state.serviceTitle, item: state.item, folderId: state.folderId });
      } else {
        say("❌ " + ((r && r.error) || "не удалось создать версию"));
      }
    };
    btns.appendChild(more);
    btns.appendChild(save);
    wrap.appendChild(btns);
    return wrap;
  }

  // ── Карточка DNS-зоны: новая запись ──────────────────────────────────────
  // В Cloud DNS имя — FQDN с точкой в конце, а вершина зоны — само её имя.
  // Пара «имя+тип» — это один набор значений, поэтому кнопка и добавляет, и
  // заменяет: что именно случилось, скажет подтверждение.
  function dnsRecordForm() {
    const wrap = el("div", "ykc-record");
    wrap.appendChild(el("div", "ykc-hint", "Имя — FQDN с точкой: вершина зоны — само имя зоны (example.com.), поддомен — www.example.com. Значения — через запятую (для MX: 10 mx.example.com.)."));
    const line = el("div", "ykc-record-line");
    const name = document.createElement("input");
    name.className = "ykc-rec-name";
    name.placeholder = "www.example.com.";
    name.spellcheck = false;
    const type = document.createElement("select");
    type.className = "ykc-rec-type";
    for (const t of ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV"]) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      type.appendChild(o);
    }
    const ttl = document.createElement("input");
    ttl.className = "ykc-rec-ttl";
    ttl.placeholder = "TTL";
    ttl.value = "600";
    line.appendChild(name);
    line.appendChild(type);
    line.appendChild(ttl);
    wrap.appendChild(line);
    const value = document.createElement("input");
    value.className = "ykc-rec-value";
    value.placeholder = "значения через запятую, например 203.0.113.10";
    value.spellcheck = false;
    wrap.appendChild(value);
    const btns = el("div", "ykc-record-btns");
    const save = el("button", "btn btn-primary btn-small", "Сохранить запись");
    save.type = "button";
    save.onclick = async () => {
      const say = window.uiToast || function () {};
      const vals = String(value.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!String(name.value || "").trim() || !vals.length) {
        say("❌ Нужны имя записи и хотя бы одно значение");
        return;
      }
      save.disabled = true;
      save.textContent = "Сохраняю…";
      const r = await apiCall("ycConsoleDnsRecord", {
        zoneId: (state.item && state.item.id) || "",
        op: "upsert",
        name: name.value,
        type: type.value,
        ttl: ttl.value,
        values: vals,
      });
      save.disabled = false;
      save.textContent = "Сохранить запись";
      if (r && r.ok) {
        say((r.replaced ? "♻ Запись обновлена: " : "✅ Запись добавлена: ") + r.name + " " + r.type + " — значений " + r.values);
        open({ serviceKey: state.serviceKey, title: state.serviceTitle, item: state.item, folderId: state.folderId });
      } else {
        say("❌ " + ((r && r.error) || "не удалось сохранить запись"));
      }
    };
    btns.appendChild(save);
    wrap.appendChild(btns);
    return wrap;
  }

  function sectionTitle(text) {
    const h = el("div", "ykc-section");
    h.appendChild(el("span", null, text));
    return h;
  }

  async function loadRelation(rel) {
    const box = $("yc-console");
    if (!box) return;
    if (state.relation === rel.key && state.relationData) {
      // Повторный клик по открытой плитке закрывает таблицу.
      state.relation = "";
      state.relationData = null;
      render();
      return;
    }
    state.relation = rel.key;
    state.relationData = { ok: true, loading: true, title: rel.title, rows: [], columns: [] };
    render();
    const r = await apiCall("ycConsoleList", {
      serviceKey: state.serviceKey,
      relationKey: rel.key,
      id: (state.item && state.item.id) || "",
      name: (state.item && state.item.name) || "",
      folderId: state.folderId,
    });
    if (!state.open) return;
    state.relationData = r && typeof r === "object" ? r : { ok: false, error: "Нет ответа" };
    render();
  }

  function renderRelation(box) {
    const d = state.relationData;
    if (!d) return;
    if (d.loading) {
      box.appendChild(el("div", "ykc-loading", "Читаю…"));
      return;
    }
    if (!d.ok) {
      box.appendChild(el("div", "ykc-err", d.error || "Не удалось прочитать список."));
      return;
    }
    if (!d.rows || !d.rows.length) {
      box.appendChild(el("div", "ykc-empty", "Здесь пусто — связанных объектов нет."));
      return;
    }
    const wrap = el("div", "ykc-table-wrap");
    const table = el("table", "ykc-table");
    const thead = el("thead");
    const htr = el("tr");
    for (const c of d.columns || []) htr.appendChild(el("th", null, c.label));
    const canRollback = state.serviceKey === "serverlessContainers" && d.key === "revisions";
    // Записи DNS-зоны можно удалять прямо из таблицы: без этого добавленную по
    // ошибке запись пришлось бы убирать в консоли Yandex Cloud.
    const canDeleteRecord = state.serviceKey === "dns" && d.key === "recordSets";
    // Образы реестра копятся с каждой выкаткой и занимают платное хранилище —
    // удаляем их прямо из таблицы, как записи DNS.
    const canDeleteImage = state.serviceKey === "containerRegistry" && d.key === "images";
    // Файлы в бакете убираются прямо из таблицы: без этого удалить залитый по
    // ошибке файл можно было бы только в консоли Yandex Cloud.
    const canDeleteObject = state.serviceKey === "storage" && d.key === "objects";
    if (canRollback || canDeleteRecord || canDeleteImage || canDeleteObject) htr.appendChild(el("th", null, ""));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (let i = 0; i < d.rows.length; i++) {
      const tr = el("tr");
      for (const cell of d.rows[i]) {
        const td = el("td", null, cell);
        td.title = cell;
        tr.appendChild(td);
      }
      if (canDeleteImage) {
        const raw = (d.items || [])[i] || {};
        const tags = Array.isArray(raw.tags) ? raw.tags : [];
        const td = el("td", "ykc-actions");
        const btn = el("button", "btn btn-danger btn-small ykc-rec-del", "🗑 Удалить");
        btn.title = "Удалить образ из реестра вместе с тегами: " + (tags.join(", ") || raw.id || "");
        btn.onclick = () => {
          // Образ удаляется необратимо, поэтому спрашиваем так же, как панель
          // облака спрашивает об удалении ресурса, — подтверждением, а не кликом.
          const go = async () => {
            btn.disabled = true;
            btn.textContent = "…";
            const r = await apiCall("ycConsoleRegistryImage", {
              registryId: (state.item && state.item.id) || "",
              op: "delete",
              imageId: raw.id || "",
              tag: tags[0] || "",
            });
            btn.disabled = false;
            btn.textContent = "🗑 Удалить";
            const say = window.uiToast || function () {};
            say(r && r.ok
              ? "🗑 Образ удалён" + (r.tags && r.tags.length ? " (теги: " + r.tags.join(", ") + ")" : "")
              : "❌ " + ((r && r.error) || "не удалось удалить образ"));
            if (r && r.ok) {
              // Перечитываем таблицу: образов стало меньше.
              state.relationData = null;
              loadRelation({ key: "images", title: "Образы" });
            }
          };
          const text = "Теги этого образа (" + (tags.join(", ") || "—") + ") исчезнут вместе с ним, и вернуть образ будет нельзя. Если на тег ссылается контейнер, выкатка его больше не соберёт.";
          // Подтверждение берём у панели (тот же модальный диалог, что у удаления
          // ресурса в облаке) — своё окно расходилось бы с остальным интерфейсом.
          if (typeof window.uiConfirm === "function") window.uiConfirm("🗑 Удалить образ из реестра?", text, go, true);
          else if (window.confirm("Удалить образ и его теги? Вернуть нельзя.")) go();
        };
        td.appendChild(btn);
        tr.appendChild(td);
      }
      if (canDeleteRecord) {
        const raw = (d.items || [])[i] || {};
        const td = el("td", "ykc-actions");
        const btn = el("button", "btn btn-small", "✕ Удалить");
        btn.title = "Удалить все значения этой записи: " + (raw.name || "") + " " + (raw.type || "");
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = "…";
          const r = await apiCall("ycConsoleDnsRecord", {
            zoneId: (state.item && state.item.id) || "",
            op: "delete",
            name: raw.name,
            type: raw.type,
          });
          btn.disabled = false;
          btn.textContent = "✕ Удалить";
          const say = window.uiToast || function () {};
          say(r && r.ok ? "🗑 Запись удалена: " + (raw.name || "") + " " + (raw.type || "") : "❌ " + ((r && r.error) || "не удалось"));
          if (r && r.ok) {
            // Перечитываем таблицу: сбрасываем данные, иначе повторный клик по
            // той же плитке просто закрыл бы её.
            state.relationData = null;
            loadRelation({ key: "recordSets", title: "Записи зоны" });
          }
        };
        td.appendChild(btn);
        tr.appendChild(td);
      }
      if (canDeleteObject) {
        const raw = (d.items || [])[i] || {};
        const td = el("td", "ykc-actions");
        const btn = el("button", "btn btn-danger btn-small ykc-obj-del", "🗑 Удалить");
        btn.title = "Удалить объект из бакета: " + (raw.key || "");
        btn.onclick = () => {
          // Объект удаляется необратимо, поэтому спрашиваем так же, как панель
          // спрашивает об удалении ресурса, — подтверждением, а не одним кликом.
          const go = async () => {
            btn.disabled = true;
            btn.textContent = "…";
            const r = await apiCall("ycConsoleStorageObject", {
              bucket: (state.item && state.item.name) || "",
              op: "delete",
              key: raw.key || "",
            });
            btn.disabled = false;
            btn.textContent = "🗑 Удалить";
            const say = window.uiToast || function () {};
            say(r && r.ok ? "🗑 Объект удалён: " + (r.key || "") : "❌ " + ((r && r.error) || "не удалось удалить объект"));
            if (r && r.ok) {
              // Перечитываем таблицу: объектов стало меньше.
              state.relationData = null;
              loadRelation({ key: "objects", title: "Объекты" });
            }
          };
          const text = "Объект «" + (raw.key || "") + "» исчезнет из бакета, и вернуть его будет нельзя — копия останется только у тебя на ПК.";
          // Подтверждение берём у панели (тот же модальный диалог, что у удаления
          // ресурса в облаке) — своё окно расходилось бы с остальным интерфейсом.
          if (typeof window.uiConfirm === "function") window.uiConfirm("🗑 Удалить объект из бакета?", text, go, true);
          else if (window.confirm("Удалить объект из бакета? Вернуть нельзя.")) go();
        };
        td.appendChild(btn);
        tr.appendChild(td);
      }
      if (canRollback) {
        const raw = (d.items || [])[i] || {};
        const active = String(raw.status || "").toUpperCase() === "ACTIVE";
        const td = el("td", "ykc-actions");
        if (active) {
          td.appendChild(el("span", "yc-status active", "активная"));
        } else {
          const btn = el("button", "btn btn-small", "↺ Сделать активной");
          btn.title = "Откатить контейнер на эту ревизию (как в консоли)";
          btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = "…";
            const r = await apiCall("ycConsoleRollback", {
              serviceKey: state.serviceKey,
              containerId: (state.item && state.item.id) || "",
              revisionId: raw.id || "",
            });
            btn.disabled = false;
            btn.textContent = "↺ Сделать активной";
            const say = window.uiToast || function () {};
            say(r && r.ok ? "↺ Контейнер переведён на ревизию " + (raw.id || "") : "❌ " + ((r && r.error) || "не удалось"));
            if (r && r.ok) open({ serviceKey: state.serviceKey, title: state.serviceTitle, item: state.item, folderId: state.folderId });
          };
          td.appendChild(btn);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
    if (d.truncated) {
      box.appendChild(el("div", "ykc-hint", "Показаны первые " + (d.rows.length) + " из " + d.count + "."));
    }
    if (d.path) box.appendChild(el("div", "ykc-path", d.path));
  }

  window.YcConsole = { open: open, close: close, isOpen: isOpen };
})();

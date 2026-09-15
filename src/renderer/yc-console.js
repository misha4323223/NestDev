"use strict";

/* ─── Консоль Yandex Cloud в правой панели ───────────────────────────────────
   Отдельный модуль: app.js только открывает/закрывает его. Данные приходят из
   главного процесса (src/yc-console.js) уже готовыми — подписи полей, значения
   и таблицы; здесь ничего не форматируется и не запрашивается напрямую.

   Как выглядит (по образцу консоли Yandex Cloud): «← Назад», заголовок ресурса,
   затем «Обзор» со всеми полями ресурса и «Связанные объекты» — плитки со
   счётчиками (подсети у сети, образы у реестра, ключи у сервисного аккаунта,
   ревизии у контейнера), по клику раскрывается таблица.

   Модуль умышленно только читает: удаление, логи и деплой остаются на карточке
   сервиса в дашборде, а единственное действие здесь — откат контейнера на
   ревизию («сделать активной»), и то по разрешению из настроек. */

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
    if (canRollback) htr.appendChild(el("th", null, ""));
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

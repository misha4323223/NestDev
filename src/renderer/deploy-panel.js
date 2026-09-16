"use strict";

/* ─── Панель «Деплой» в правой панели ───────────────────────────────────────
   Отдельный модуль: app.js только открывает панель и передаёт события деплоя.
   Данные приходят из главного процесса готовыми (src/cloud-state.js и
   src/deploy-engine.js): здесь ничего не решается — только показывается.

   Что видно без консоли Yandex Cloud:
     • что за проект и как он собирается (рецепт: тип, порт, замечания);
     • текущий выкат: номер, статус, адрес, образ, ревизия, время;
     • стадии последнего деплоя с отметками ✓ / ✗ / …
     • история: #17 ✓ 2 мин назад · открыть · откатить · логи.
   Действия: задеплоить, откатить на прошлую рабочую версию, проверить адрес. */

(function () {
  const state = {
    dir: "",
    dirHint: "",
    data: null,
    running: false,
    inFlight: false, // кнопка уже ждёт результат — события не должны перетирать сообщение
    stages: [],
    logsFor: "",
    logsText: "",
    shotFor: "",
    shotUrl: "",
    shotError: "",
    message: "",
    messageKind: "",
    // Выкат остановлен на упавших тестах: предлагаем продолжить явным выбором.
    canOverrideTests: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hasApi() {
    return typeof window !== "undefined" && window.api && typeof window.api.deployState === "function";
  }

  // «2 мин назад» — понятнее, чем отметка времени в истории деплоев.
  function ago(ts) {
    if (!ts) return "";
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return sec + " с назад";
    const min = Math.round(sec / 60);
    if (min < 60) return min + " мин назад";
    const h = Math.round(min / 60);
    if (h < 24) return h + " ч назад";
    return Math.round(h / 24) + " дн назад";
  }

  function duration(ms) {
    if (!ms) return "";
    if (ms < 1000) return ms + " мс";
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + " с";
    return Math.floor(s / 60) + " мин " + Math.round(s % 60) + " с";
  }

  const STATUS_TEXT = {
    ok: "работает",
    failed: "провал",
    "rolled-back": "откатили",
    running: "идёт",
  };

  function statusChip(rec) {
    const st = (rec && rec.status) || "";
    const cls = st === "ok" ? "ok" : st === "failed" ? "bad" : st === "running" ? "run" : "warn";
    return '<span class="dp-chip ' + cls + '"><i></i>' + esc(STATUS_TEXT[st] || st || "нет данных") + "</span>";
  }

  // ── отрисовка ──
  // Рубли в читаемом виде: «210,21 ₽», «4 712,65 ₽».
  function money(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    const parts = v.toFixed(2).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return parts.join(",") + " ₽";
  }

  function render() {
    // Статус в шапке — производная от тех же данных, поэтому обновляем его здесь:
    // иначе после прогона чип остаётся старым, хотя история уже новая.
    setHeader();
    const host = $("dp-body");
    if (!host) return;
    host.innerHTML = "";
    if (!hasApi()) {
      host.appendChild(el("div", "dp-empty", "Деплой доступен в desktop-приложении."));
      return;
    }

    const d = state.data || {};
    if (!d.connected) {
      const box = el("div", "dp-onboard");
      box.appendChild(el("div", "dp-onboard-ic", "☁️"));
      box.appendChild(el("div", "dp-onboard-title", "Yandex Cloud не подключён"));
      box.appendChild(
        el("div", "dp-onboard-text", "Деплой собирает проект в контейнер и выкладывает его в Serverless Containers. Нужны токен и каталог.")
      );
      const row = el("div", "dp-row");
      const b = el("button", "btn btn-primary btn-small", "⚙️ Настройки Yandex Cloud");
      b.onclick = () => {
        const btn = $("btn-yc-dash-settings");
        if (btn) btn.click();
        else if ($("btn-settings")) $("btn-settings").click();
      };
      row.appendChild(b);
      box.appendChild(row);
      host.appendChild(box);
      return;
    }

    // Что за проект и как его собирать
    if (d.recipe) {
      const head = el("div", "dp-recipe");
      head.innerHTML =
        '<span class="dp-recipe-kind">' +
        esc(d.recipe.label || d.recipe.kind) +
        '</span><span class="dp-recipe-meta">порт ' +
        esc(String(d.recipe.port || "")) +
        (d.recipe.hasDockerfile ? " · свой Dockerfile" : " · Dockerfile сгенерируем") +
        "</span>";
      host.appendChild(head);
      for (const w of d.recipe.warnings || []) host.appendChild(el("div", "dp-warn", "⚠ " + w));
    }

    // Стоимость выката: считается по параметрам ревизии и показывается ДО запуска.
    if (d.cost) {
      const c = d.cost;
      const scenarios = c.scenarios || [];
      const busy = scenarios.find((s) => /живой сайт/.test(s.title));
      const quiet = scenarios.find((s) => /тихий сайт/.test(s.title));
      const idle = scenarios.find((s) => /круглосуточно/.test(s.title));
      const box = el("div", "dp-cost");
      box.appendChild(
        el(
          "div",
          "dp-cost-top",
          "Стоимость ревизии · " + (c.levelLabel || "") + (busy ? " · ≈ " + money(busy.cost.total) + " в месяц при живом сайте" : "")
        )
      );
      if (quiet) box.appendChild(el("div", "dp-cost-row", "тихий сайт (100 тыс. вызовов × 150 мс): " + money(quiet.cost.total) + (quiet.cost.total ? "" : " — в бесплатном пакете")));
      if (busy) box.appendChild(el("div", "dp-cost-row", "живой сайт (1 млн вызовов × 150 мс): " + money(busy.cost.total)));
      if (idle && idle.cost.total > 1000) box.appendChild(el("div", "dp-cost-row dp-cost-warn", "круглосуточно (" + c.memoryMb + " МБ, " + c.cores + " vCPU): " + money(idle.cost.total) + " — держать сайт включённым всегда не стоит"));
      const links = el("div", "dp-cost-links");
      const calc = el("a", "dp-cost-link", "калькулятор ↗");
      calc.href = "#";
      calc.onclick = (e) => { e.preventDefault(); if (c.calculator && window.api && window.api.openExternal) window.api.openExternal(c.calculator); };
      links.appendChild(calc);
      links.appendChild(el("span", "dp-cost-note", "ориентир, тарифы на " + (c.pricedAt || "")));
      box.appendChild(links);
      host.appendChild(box);
    }

    // Переменные и секреты. Значения вводит ЧЕЛОВЕК здесь, а не модель в чате:
    // обычные переменные уезжают в контейнер как есть, секреты — в Lockbox, и в
    // ревизию попадает только ссылка на секрет (значения не возвращаются).
    {
      const box = el("div", "dp-block");
      box.appendChild(el("div", "dp-block-title", "Переменные и секреты"));

      const envTa = el("textarea", "dp-ta");
      envTa.id = "dp-env";
      envTa.rows = 3;
      envTa.placeholder = "NODE_ENV=production\nPORT=8080";
      envTa.value = state.envText || "";
      envTa.oninput = () => {
        state.envText = envTa.value;
      };
      box.appendChild(el("div", "dp-hint", "Настройки без секретов — уезжают в контейнер как есть, по строке KEY=value."));
      box.appendChild(envTa);

      const secTa = el("textarea", "dp-ta");
      secTa.id = "dp-secrets";
      secTa.rows = 3;
      secTa.placeholder = "DATABASE_URL=postgres://...\nAPI_KEY=...";
      secTa.value = state.secretsText || "";
      secTa.oninput = () => {
        state.secretsText = secTa.value;
      };
      box.appendChild(
        el("div", "dp-hint", "Секреты — уходят в Yandex Lockbox, в ревизию попадает только ссылка. Значения не показываются ни в чате, ни в истории деплоев.")
      );
      box.appendChild(secTa);

      const lockbox = (d.infrastructure || {}).lockbox;
      if (lockbox && lockbox.id) {
        const keys = ((d.infrastructure || {}).secretKeys || []).join(", ");
        box.appendChild(el("div", "dp-note", "Lockbox проекта: " + lockbox.id + (keys ? " · ключи: " + keys : "")));
        box.appendChild(
          btn("↺ Использовать тот же секрет", "btn-ghost", () => {
            state.secretsText = "";
            state.useSecretId = lockbox.id;
            state.useSecretKeys = (d.infrastructure || {}).secretKeys || [];
            state.message = "Секрет " + lockbox.id + " будет использован как есть — значения остаются в Lockbox.";
            state.messageKind = "";
            render();
          })
        );
      }
      host.appendChild(box);
    }

    // Текущий выкат
    const cur = d.current;
    const curBox = el("div", "dp-current");
    if (cur) {
      const line1 = el("div", "dp-current-top");
      line1.innerHTML = "<b>#" + esc(String(cur.number || "")) + "</b>" + statusChip(cur) + (cur.url ? "" : "");
      curBox.appendChild(line1);
      if (cur.url) {
        const a = el("a", "dp-url", cur.url);
        a.href = "#";
        a.title = "Открыть в браузере";
        a.onclick = (e) => {
          e.preventDefault();
          if (window.api && window.api.openExternal) window.api.openExternal(cur.url);
        };
        curBox.appendChild(a);
      }
      const meta = [];
      if (cur.image) meta.push("образ " + cur.image);
      if (cur.revisionId) meta.push("ревизия " + cur.revisionId);
      if (cur.startedAt) meta.push(ago(cur.startedAt));
      if (cur.health && cur.health.ok) meta.push("HTTP " + cur.health.status + " по " + cur.health.path);
      if (cur.secretKeys && cur.secretKeys.length) meta.push("секретов: " + cur.secretKeys.length + " (Lockbox)");
      if (meta.length) curBox.appendChild(el("div", "dp-current-meta", meta.join(" · ")));
      if (cur.rolledBackTo) curBox.appendChild(el("div", "dp-note", "Откатились на рабочую версию #" + cur.rolledBackTo + " — она сейчас в проде."));
      if (cur.error) curBox.appendChild(el("div", "dp-error", String(cur.error).split("\n")[0]));
      const acts = el("div", "dp-row");
      if (cur.url) acts.appendChild(btn("↗ Открыть", "btn-ghost", () => window.api.openExternal(cur.url)));
      if (cur.containerId) acts.appendChild(btn("📜 Логи", "btn-ghost", () => loadLogs(cur.containerId)));
      curBox.appendChild(acts);
    } else {
      curBox.appendChild(el("div", "dp-empty", "Пока ни одного деплоя. Соберём проект в контейнер и дадим ссылку."));
    }
    host.appendChild(curBox);

    // Что увидел браузер на выкаченной странице
    const bc = cur && cur.browserCheck;
    if (bc) {
      const box = el("div", "dp-block");
      box.appendChild(el("div", "dp-block-title", "Страница в браузере"));
      const line = el("div", "dp-browser " + (!bc.ok ? "bad" : bc.level === "warn" ? "warn" : "ok"));
      line.textContent = (!bc.ok ? "✗ " : "🩺 ") + browserLine(bc);
      box.appendChild(line);
      for (const w of (bc.warnings || []).slice(0, 4)) box.appendChild(el("div", "dp-warn", "⚠ " + w));
      if (cur.browserShot) {
        const row = el("div", "dp-row");
        row.appendChild(btn(state.shotFor === cur.browserShot ? "Скрыть скриншот" : "🖼 Скриншот", "btn-ghost", () => toggleShot(cur.browserShot)));
        box.appendChild(row);
        if (state.shotFor === cur.browserShot) {
          if (state.shotUrl) {
            const img = el("img", "dp-shot");
            img.src = state.shotUrl;
            img.alt = "Скриншот выкаченной страницы";
            box.appendChild(img);
          } else {
            box.appendChild(el("div", "dp-empty", state.shotError || "Читаю скриншот…"));
          }
        }
      }
      host.appendChild(box);
    }

    // Стадии текущего прогона или последнего деплоя
    const stages = state.running && state.stages.length ? state.stages : (cur && cur.stages) || [];
    if (stages.length) {
      const box = el("div", "dp-block");
      box.appendChild(el("div", "dp-block-title", state.running ? "Идёт деплой" : "Стадии последнего деплоя"));
      const list = el("div", "dp-stages");
      for (const s of stages) list.appendChild(stageRow(s));
      box.appendChild(list);
      host.appendChild(box);
    }

    // История
    const items = (d.deployments || []).slice(0, 12);
    if (items.length) {
      const box = el("div", "dp-block");
      box.appendChild(el("div", "dp-block-title", "История"));
      const list = el("div", "dp-history");
      for (const it of items) {
        const row = el("div", "dp-hist" + (it.status === "failed" ? " bad" : "") + (it.status === "rolled-back" ? " warn" : ""));
        const mark = it.status === "ok" ? "✓" : it.status === "failed" ? "✗" : it.status === "rolled-back" ? "↩" : "…";
        row.appendChild(el("span", "dp-hist-mark", mark));
        row.appendChild(el("span", "dp-hist-num", "#" + (it.number || "?")));
        const why = it.kind === "rollback" ? " · откат" : it.rolledBackTo ? " · откатились на #" + it.rolledBackTo : "";
        row.appendChild(el("span", "dp-hist-time", ago(it.startedAt) + why));
        const acts = el("div", "dp-hist-acts");
        if (it.url && it.status === "ok") acts.appendChild(btn("↗", "dp-mini", () => window.api.openExternal(it.url)));
        if (it.revisionId && it.status === "ok" && (!d.current || d.current.id !== it.id)) {
          acts.appendChild(btn("↩", "dp-mini", () => doRollback(it)));
        }
        if (it.error) acts.appendChild(btn("!", "dp-mini bad", () => showError(it.error)));
        row.appendChild(acts);
        list.appendChild(row);
      }
      box.appendChild(list);
      host.appendChild(box);
    }

    if (state.logsText) {
      const box = el("div", "dp-block");
      const title = el("div", "dp-block-title", "Логи контейнера");
      box.appendChild(title);
      const pre = el("pre", "dp-logs", state.logsText);
      box.appendChild(pre);
      box.appendChild(btn("Скрыть логи", "btn-ghost", () => {
        state.logsText = "";
        render();
      }));
      host.appendChild(box);
    }

    if (state.message) {
      host.appendChild(el("div", "dp-msg " + (state.messageKind || ""), state.message));
    }

    // Продолжить после упавших тестов — только осознанным нажатием: молча
    // выкатывать сломанное нельзя, но и решать за человека тоже нельзя.
    if (state.canOverrideTests) {
      host.appendChild(
        btn("⚠ Всё равно задеплоить: тесты упали", "dp-override", () => {
          state.canOverrideTests = false;
          render();
          doDeploy({ allowFailingTests: true });
        })
      );
    }
  }

  // Разбор «KEY=value» по строкам. Строка без «=» — это ошибка, а не повод молча
  // её выбросить: иначе человек будет думать, что переменная уехала.
  function parseKv(text) {
    const out = {};
    const bad = [];
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) {
        bad.push(line);
        continue;
      }
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (!key) bad.push(line);
      else out[key] = value;
    }
    return { values: out, bad };
  }

  // Пользователю важно не только «откатили», но и почему — иначе непонятно, что чинить.
  function rolledBackText(r) {
    const why = String((r && r.error) || "").split("\n")[0].slice(0, 140);
    const to = r && r.rolledBackTo ? " на версию #" + r.rolledBackTo : " на прошлую рабочую версию";
    return "⚠️ Деплой не прошёл" + (why ? ": " + why : "") + ". Я откатил" + to + " — сайт работает.";
  }

  // Короткая строка про проверку страницы — по тем же данным, что пишет движок.
  function browserLine(bc) {
    if (!bc || !bc.ok) return (bc && bc.reason) || "страница не проверялась";
    const m = bc.metrics || {};
    const bits = ["HTTP " + (m.status || "—"), "текста " + (m.textLen || 0) + " символов"];
    if (m.title) bits.push("«" + m.title + "»");
    if (m.consoleErrors) bits.push("ошибок консоли: " + m.consoleErrors);
    return bits.join(", ");
  }

  // Скриншот лежит файлом рядом с состоянием — читаем его только по просьбе.
  async function toggleShot(path) {
    if (state.shotFor === path) {
      state.shotFor = "";
      state.shotUrl = "";
      render();
      return;
    }
    state.shotFor = path;
    state.shotUrl = "";
    state.shotError = "";
    render();
    try {
      const r = await window.api.fsReadImage(path);
      if (r && r.ok) state.shotUrl = r.dataUrl;
      else state.shotError = (r && r.error) || "не удалось прочитать";
    } catch (e) {
      state.shotError = "Ошибка: " + ((e && e.message) || String(e));
    }
    render();
  }

  function stageRow(s) {
    const row = el("div", "dp-stage " + (s.status || ""));
    const mark = s.status === "ok" ? "✓" : s.status === "fail" ? "✗" : "…";
    row.appendChild(el("span", "dp-stage-mark", mark));
    row.appendChild(el("span", "dp-stage-name", s.label || s.id || ""));
    if (s.detail) row.appendChild(el("span", "dp-stage-detail", String(s.detail).split("\n")[0]));
    if (s.ms) row.appendChild(el("span", "dp-stage-ms", duration(s.ms)));
    return row;
  }

  function btn(text, cls, onClick) {
    const b = el("button", "btn btn-small " + (cls || "btn-ghost"), text);
    b.onclick = onClick;
    return b;
  }

  function showError(text) {
    state.message = String(text).split("\n").slice(0, 4).join("\n");
    state.messageKind = "bad";
    render();
  }

  // ── данные ──
  async function refresh() {
    if (!hasApi()) return;
    // Каталог всегда спрашиваем у приложения: настройки в окне могут быть
    // устаревшими, если их поменяли не из интерфейса (или только что переключили проект).
    const dir = (state.dir = (await resolveDir()) || state.dirHint || "");
    try {
      const st = await window.api.ycStatus();
      // Подключено = есть токен и выбран каталог: без каталога деплой некуда класть.
      const connected = !!(st && st.loggedIn && st.folderId);
      state.folderName = (st && st.folderName) || "";
      let data = {};
      if (dir) {
        data = (await window.api.deployState(dir)) || {};
      }
      state.data = Object.assign({ connected }, data);
    } catch (e) {
      state.data = { connected: false, error: (e && e.message) || String(e) };
    }
    render();
  }


  // ── действия ──
  async function doDeploy(over) {
    const ov = over && typeof over === "object" ? over : {};
    if (state.running) return;
    const dir = (await resolveDir()) || state.dirHint || "";
    if (!dir) {
      state.message = "Сначала выбери рабочую директорию: Настройки → 📁 Проект и GitHub.";
      state.messageKind = "warn";
      render();
      return;
    }
    state.dir = dir;
    const nameInput = $("dp-name");
    const name = (nameInput && nameInput.value.trim()) || "";

    // Переменные и секреты берём из полей панели: секреты не проходят через чат.
    const envField = $("dp-env");
    const secField = $("dp-secrets");
    const envParsed = parseKv(envField ? envField.value : state.envText);
    const secParsed = parseKv(secField ? secField.value : state.secretsText);
    state.envText = envField ? envField.value : state.envText || "";
    state.secretsText = secField ? secField.value : state.secretsText || "";
    const broken = envParsed.bad.concat(secParsed.bad);
    if (broken.length) {
      state.message = "Строка без «=»: " + broken.slice(0, 3).join(", ") + " — напиши как KEY=значение.";
      state.messageKind = "bad";
      render();
      return;
    }
    const deployOpts = { name, env: envParsed.values, secrets: secParsed.values };
    // «Тесты упали, но выкладывай» — явное нажатие кнопки, не тихий обход: движок
    // запишет это замечанием и в историю деплоя.
    if (ov.allowFailingTests) deployOpts.allowFailingTests = true;
    // Повторный выкат без повторного ввода: берём готовый секрет Lockbox по ссылке.
    if (state.useSecretId && !Object.keys(secParsed.values).length) {
      deployOpts.secretId = state.useSecretId;
      deployOpts.secretKeys = state.useSecretKeys || [];
    }

    state.running = true;
    state.inFlight = true;
    state.stages = [];
    state.canOverrideTests = false;
    state.message = ov.allowFailingTests
      ? "⚠ Тесты упали — выкладываю по твоему выбору. Это несколько минут: сборка образа и первый холодный старт."
      : "Собираю и выкладываю. Это несколько минут: сборка образа и первый холодный старт.";
    state.messageKind = ov.allowFailingTests ? "warn" : "";
    render();
    try {
      const r = await window.api.deployRun(dir, deployOpts);
      state.running = false;
      state.inFlight = false;
      state.stages = (r && r.stages) || [];
      state.message = r && r.ok
        ? "✅ Задеплоено. Адрес: " + (r.url || "—") + (r.secretKeys && r.secretKeys.length ? " · секретов в Lockbox: " + r.secretKeys.length : "")
        : "❌ " + ((r && r.error) || "деплой не завершился");
      // Значения в Lockbox: в поле им делать нечего, а повторный выкат
      // воспользуется ссылкой на секрет.
      if (r && r.ok && r.secretId) {
        state.secretsText = "";
        state.useSecretId = r.secretId;
        state.useSecretKeys = r.secretKeys || [];
      }
      state.messageKind = r && r.ok ? "ok" : "bad";
      // Остановка на тестах — не тупик: в engine это отдельный признак, поэтому
      // предлагаем выбор, а не заставляем читать многострочную ошибку сборки.
      state.canOverrideTests = !!(r && !r.ok && r.testsFailed);
      if (state.canOverrideTests) {
        state.message =
          "🛑 Тесты проекта упали — выкат в production остановлен. " +
          String((r && r.error) || "")
            .split("\n")
            .slice(0, 3)
            .join(" ");
        state.messageKind = "bad";
      }
      if (r && r.rolledBack) {
        state.message = rolledBackText(r);
        state.messageKind = "warn";
      }
    } catch (e) {
      state.running = false;
      state.inFlight = false;
      state.message = "Ошибка: " + ((e && e.message) || String(e));
      state.messageKind = "bad";
    }
    await refresh();
    render();
  }

  async function doRollback(rec) {
    const dir = state.dir || (await resolveDir()) || state.dirHint || "";
    if (!dir) return;
    let ask = "Откатить прод на прошлую рабочую версию?";
    if (rec && rec.number) ask = "Сделать активной версию #" + rec.number + "?";
    if (typeof window.confirm === "function" && !window.confirm(ask)) return;
    state.message = "Откатываю…";
    state.messageKind = "";
    render();
    try {
      const r = await window.api.deployRollback(dir, {});
      state.message = r && r.ok ? "↩ Откатили на #" + (r.rolledBackTo || "?") + ", версия отвечает." : "Откат не прошёл: " + ((r && r.error) || "неизвестно");
      state.messageKind = r && r.ok ? "warn" : "bad";
    } catch (e) {
      state.message = "Ошибка отката: " + ((e && e.message) || String(e));
      state.messageKind = "bad";
    }
    await refresh();
  }

  async function doHealth() {
    const url = state.data && state.data.current && state.data.current.url;
    if (!url) {
      state.message = "Адрес пока неизвестен — сделай деплой.";
      state.messageKind = "warn";
      render();
      return;
    }
    state.message = "Проверяю адрес…";
    render();
    try {
      const r = await window.api.deployHealth(url, []);
      state.message = r && r.ok
        ? "🩺 Отвечает: HTTP " + r.status + " по " + r.path + " за " + duration(r.ms) + "."
        : "🩺 Не отвечает: " + ((r && r.reason) || "нет ответа");
      state.messageKind = r && r.ok ? "ok" : "bad";
    } catch (e) {
      state.message = "Проверка не прошла: " + ((e && e.message) || String(e));
      state.messageKind = "bad";
    }
    render();
  }

  async function loadLogs(containerId) {
    if (!containerId || !window.api || typeof window.api.ycLogs !== "function") return;
    state.logsText = "Читаю логи…";
    render();
    try {
      const r = await window.api.ycLogs("serverlessContainers", containerId);
      const lines = (r && r.logs) || [];
      state.logsText = lines.length ? lines.slice(-60).join("\n") : (r && r.error) || "Записей нет.";
    } catch (e) {
      state.logsText = "Логи не прочитались: " + ((e && e.message) || String(e));
    }
    render();
  }

  // Каталог проекта: всегда свежий из настроек приложения (рабочая директория).
  async function resolveDir() {
    try {
      const s = (window.api && typeof window.api.getSettings === "function" && (await window.api.getSettings())) || {};
      if (s.workingDir) {
        const nameInput = $("dp-name");
        if (nameInput && !nameInput.value) {
          const base = String(s.workingDir).split(/[\\/]/).filter(Boolean).pop() || "";
          nameInput.value = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        }
        return String(s.workingDir);
      }
    } catch {}
    return "";
  }

  // ── события деплоя из главного процесса ──
  function onStage(stage) {
    if (!stage) return;
    const i = state.stages.findIndex((s) => s.id === stage.id);
    if (i >= 0) state.stages[i] = stage;
    else state.stages.push(stage);
    state.running = true;
    if (isOpen()) render();
  }

  // Событие о конце прогона. Когда деплой запущен кнопкой, сообщение пишет сама
  // кнопка (у неё есть полный результат) — здесь не перетираем его.
  function onDone(res) {
    state.running = false;
    if (!state.inFlight) {
      if (res && res.rolledBack) {
        state.message = rolledBackText(res);
        state.messageKind = "warn";
      } else if (res && res.error) {
        state.message = "❌ " + res.error;
        state.messageKind = "bad";
      }
    }
    if (isOpen()) render();
  }

  function setHeader() {
    const st = $("dp-status");
    if (!st) return;
    const cur = state.data && state.data.current;
    if (state.running) st.textContent = "идёт деплой…";
    else if (cur && cur.status === "ok") st.textContent = "🟢 Production";
    else if (cur && cur.status === "rolled-back") st.textContent = "🟠 Откатили";
    else if (cur && cur.status === "failed") st.textContent = "🔴 Провал";
    else st.textContent = "—";
  }

  function isOpen() {
    const p = $("sp-deploy");
    return !!(p && !p.classList.contains("hidden"));
  }

  function bind() {
    const pairs = [
      ["btn-dp-deploy", () => doDeploy()],
      ["btn-dp-rollback", () => doRollback(null)],
      ["btn-dp-health", doHealth],
      ["btn-dp-refresh", refresh],
    ];
    for (const [id, fn] of pairs) {
      const b = $(id);
      if (b) b.onclick = fn;
    }
  }

  function mount() {
    if (!$("sp-deploy") || $("sp-deploy").dataset.mounted === "1") return;
    $("sp-deploy").dataset.mounted = "1";
    bind();
  }

  window.DeployPanel = {
    mount,
    // app.js отдаёт каталог проекта при открытии панели — не спрашиваем его заново.
    open: async (dir) => {
      mount();
      if (dir) state.dirHint = String(dir);
      await refresh();
      render();
    },
    refresh: async () => {
      mount();
      await refresh();
      render();
    },
    onStage: (stage) => {
      onStage(stage);
      setHeader();
    },
    onDone: async (res) => {
      onDone(res);
      setHeader();
      await refresh();
      render();
    },
    isOpen,
  };
})();

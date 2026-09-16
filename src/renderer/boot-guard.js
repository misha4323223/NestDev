"use strict";

/* ─── Дозор запуска окна (boot-guard) ────────────────────────────────────────
   Жалоба: «написал агенту — в чате пусто: ни размышлений, ни действий, ни плана;
   ответ вижу только в уведомлении». Причина оказалась в коде окна: перерисовка
   ленты падала на первой же непустой истории, падение вылетало из загрузки и
   обрывало весь остаток запуска — вместе с подпиской на события агента. Окно
   при этом выглядело живым, и человеку не с чем было сверить: ошибка уходила в
   консоль, которой в собранном приложении никто не видит.

   Отсюда правило: **окно обязано само рассказать, что с ним не так.** Дозор
   встаёт первым скриптом разметки (раньше всех остальных) и помнит три рода
   поломок:

     1) падение при загрузке — `error` на самом окне (исключение из модуля или
        из app.js) и `unhandledrejection` из обещания;
     2) файл не загрузился — ошибка загрузки ресурса (обычно чужой или неполный
        набор обновления: `chat-feed.js` нет на диске);
     3) окно собралось, но чат работать не может — нет узлов (`#messages`,
        `#input`, `#btn-send`) или нет собранных модулей (`ChatFeed` и соседи).

   И то, и другое, и третье показывается плашкой поверх окна: причина, файл и
   строка, версия исполняемого кода (из OTA-статуса) и стек. Плашка сделана
   встроенными стилями — если сломана таблица стилей, она всё равно читаема.
   Текст дозора целиком доступен функцией `window.bootReport()`.

   Разбор разведён на чистые решения (problemsText / scriptFailure / missingFrom /
   bannerModel) и подписку (install): решения проверяются тестами на игрушечном
   DOM, без живого окна. */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.BootGuard = factory(root);
  }
})(typeof self !== "undefined" ? self : this, function (root) {
  // Узлы, без которых чат видеть нечего: лента и место кнопки «↓», поле ввода,
  // кнопка отправки, панель плана и панель строк действий.
  const REQUIRED_IDS = ["messages", "messages-wrap", "input", "btn-send", "plan-panel", "work-panel"];

  // Модули, без которых чат не нарисуется. Проверяем именно те, что нужны на
  // пути «сообщение → ответ»: если набор обновления приехал неполным, человек
  // увидит не пустую ленту, а имя пропавшего файла.
  const REQUIRED_MODULES = [
    ["ProviderConfig", "настройки провайдера"],
    ["ProviderTransport", "транспорт провайдера"],
    ["Prompts", "правила агента"],
    ["ToolSchemas", "схемы инструментов"],
    ["AgentCore", "ядро агента"],
    ["ContextWindow", "окно контекста"],
    ["ChatThinking", "размышления в ленте"],
    ["ChatSegments", "сегменты ответа"],
    ["ChatRender", "разметка сообщений"],
    ["ChatFeed", "лента чата"],
    ["ChatWork", "строки действий"],
    ["ChatActions", "кнопки сообщений"],
  ];

  const MAX_PROBLEMS = 6;

  function str(v) {
    return v === null || v === undefined ? "" : String(v);
  }

  // ── 1. Файл не загрузился (ошибка ресурса) ─────────────────────────────────
  // Имя файла берём из адреса тега: по нему сразу видно, какой именно файл набора
  // обновления не доехал.
  function scriptFailure(target) {
    if (!target) return null;
    const tag = str(target.tagName || target.nodeName).toLowerCase();
    const url = str(target.src || target.href || "");
    if (!tag && !url) return null;
    let file = url;
    try {
      const parts = url.split(/[?#]/)[0].split("/");
      file = parts[parts.length - 1] || url;
    } catch {}
    if (!file) return null;
    return {
      kind: "resource",
      title: "не загрузился файл " + file,
      where: url || file,
      file: file,
      hint: tag === "link" ? "это стиль" : "",
    };
  }

  // ── 2. Падение при загрузке ────────────────────────────────────────────────
  // `where` — файл и строка, из которых прилетело падение: по этой строке
  // правку и делают.
  function scriptError(error, fallback) {
    const err = error || {};
    const msg = str(err.message || err) || "неизвестная ошибка";
    const at = [];
    if (str(err.filename)) at.push(str(err.filename));
    if (err.lineno) at.push("строка " + err.lineno + (err.colno ? ":" + err.colno : ""));
    return {
      kind: "error",
      title: msg,
      where: at.join(", ") || str(fallback) || "окно",
      stack: stackFrames(err.stack),
    };
  }

  // Короткий стек: первые кадры, где видно файл и строку. Свои кадры не держим —
  // они сбивают с толку.
  function stackFrames(stack, limit) {
    const out = [];
    const lines = str(stack).split("\n").slice(1);
    for (const raw of lines) {
      const line = raw.trim().replace(/^at\s+/, "");
      if (!line) continue;
      if (line.indexOf("boot-guard.js") !== -1) continue;
      out.push(line);
      if (out.length >= (limit || 4)) break;
    }
    return out;
  }

  // Что из обязательного окно не собрало: имена модулей (с пояснением) и узлы.
  function missingFrom(list, exists) {
    const out = [];
    for (const item of list || []) {
      const name = Array.isArray(item) ? item[0] : item;
      const why = Array.isArray(item) ? item[1] : "";
      let ok = false;
      try {
        ok = !!exists(name);
      } catch {
        ok = false;
      }
      if (!ok) out.push(why ? name + " (" + why + ")" : name);
    }
    return out;
  }

  function missingModel(missingModules, missingNodes) {
    const lines = [];
    if (missingModules.length) lines.push("нет собранных модулей: " + missingModules.join(", "));
    if (missingNodes.length) lines.push("нет узлов окна: " + missingNodes.join(", "));
    return {
      kind: "incomplete",
      title: "чат работать не может — окно собрано не полностью",
      where: "проверка дозора при загрузке",
      hint: lines.join("; "),
    };
  }

  // ── Разбор для человека ────────────────────────────────────────────────────
  // Текст собирается ОДИН раз и используется и плашкой, и `window.bootReport()`,
  // и кнопкой «Скопировать разбор»: человеку нужно уметь переслать разбор, не
  // перепечатывая его с экрана.
  function problemsText(problems, opts) {
    opts = opts || {};
    const list = problems || [];
    if (!list.length) return "Дозор запуска: поломок не записано.";
    const head = [];
    head.push("⚠ Окно не работает: " + str(list[0].title));
    if (list[0].hint) head.push("Что именно: " + list[0].hint);
    head.push("Где: " + str(list[0].where));
    if (typeof opts.version === "function") {
      try {
        const v = opts.version();
        if (v) head.push("Версия кода: " + v);
      } catch {}
    }
    if (list[0].stack && list[0].stack.length) head.push("Стек:\n  " + list[0].stack.join("\n  "));
    if (list.length > 1) {
      head.push("Дальше: " + list.slice(1).map((p) => p.title).join(" · "));
    }
    return head.join("\n");
  }

  // ── Плашка поверх окна ─────────────────────────────────────────────────────
  // Стили встроенные: если таблица стилей не доехала или сломана, разбор всё
  // равно читаем — иначе дозор был бы бесполезен ровно в том случае, ради
  // которого он и заведён.
  function makeBanner(doc, onClose) {
    const wrap = doc.createElement("div");
    wrap.id = "boot-banner";
    wrap.setAttribute("role", "alert");
    wrap.style.cssText = [
      "position:fixed",
      "left:12px",
      "right:12px",
      "top:12px",
      "z-index:2147483000",
      "max-height:60vh",
      "overflow:auto",
      "background:#3a1114",
      "color:#ffe9ea",
      "border:1px solid #a1333a",
      "border-radius:10px",
      "box-shadow:0 10px 30px rgba(0,0,0,.5)",
      "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "padding:10px 12px",
    ].join(";");
    const title = doc.createElement("div");
    title.style.cssText = "font-weight:700;margin-bottom:6px";
    const body = doc.createElement("pre");
    body.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word;font:inherit";
    const actions = doc.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px";
    const copyBtn = makeButton(doc, "Скопировать разбор", () => {
      const text = typeof root.bootReport === "function" ? root.bootReport() : body.textContent;
      copyText(doc, text, (ok) => {
        copyBtn.textContent = ok ? "Скопировано" : "Не удалось скопировать";
        setTimeout(() => (copyBtn.textContent = "Скопировать разбор"), 1600);
      });
    }, "btn");
    actions.appendChild(copyBtn);
    // «Закрыть» убирает плашку и запрещает показывать её снова: если человек
    // закрыл разбор, он уже прочитал причину, и мешать ему нечем.
    actions.appendChild(
      makeButton(doc, "Закрыть", () => {
        try {
          wrap.remove();
        } catch {}
        if (typeof onClose === "function") onClose();
      })
    );
    wrap.appendChild(title);
    wrap.appendChild(body);
    wrap.appendChild(actions);
    return {
      el: wrap,
      setText(text) {
        title.textContent = str(text).split("\n")[0];
        body.textContent = str(text).split("\n").slice(1).join("\n");
      },
    };

    function makeButton(doc2, label, on, id) {
      const b = doc2.createElement("button");
      b.textContent = label;
      if (id) b.id = id;
      b.style.cssText =
        "background:#a1333a;color:#fff;border:0;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer";
      b.addEventListener("click", on);
      return b;
    }
  }

  // Копирование: сперва системный буфер, иначе — выделение текста разбора, чтобы
  // человек мог скопировать руками.
  function copyText(doc, text, done) {
    const finish = (ok) => {
      if (typeof done === "function") done(ok);
    };
    try {
      const clip = root.navigator && root.navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        clip.writeText(str(text)).then(() => finish(true), () => finish(selectFallback(doc, text)));
        return;
      }
    } catch {}
    finish(selectFallback(doc, text));
  }

  function selectFallback(doc, text) {
    try {
      const ta = doc.createElement("textarea");
      ta.value = str(text);
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand ? !!doc.execCommand("copy") : false;
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  // ── Подписка ───────────────────────────────────────────────────────────────
  function install(doc, opts) {
    opts = opts || {};
    if (!doc || typeof doc.addEventListener !== "function") return function () {};
    const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
    const problems = [];
    const seen = new Set();
    let banner = null;
    let hidden = false;

    // Итоговый текст разбора — им пользуются и плашка, и `window.bootReport()`.
    function report() {
      return problemsText(problems, { version: versionText });
    }

    function versionText() {
      try {
        const v = root.__bootCodeVersion;
        return v ? str(v) : "";
      } catch {
        return "";
      }
    }

    function render() {
      const text = report();
      try {
        if (!banner) {
          if (hidden || !doc.body) return;
          banner = makeBanner(doc, () => {
            hidden = true;
          });
          doc.body.appendChild(banner.el);
        }
        banner.setText(text);
      } catch {}
    }

    function add(problem) {
      if (!problem) return null;
      const key = problem.kind + "|" + problem.title + "|" + problem.where;
      if (seen.has(key)) return null;
      seen.add(key);
      problems.push(problem);
      if (problems.length > MAX_PROBLEMS) problems.splice(0, problems.length - MAX_PROBLEMS);
      try {
        console.error("[boot-guard] " + problemsText([problem]));
      } catch {}
      render();
      if (typeof opts.onProblem === "function") {
        try {
          opts.onProblem(problem);
        } catch {}
      }
      return problem;
    }

    // Падение при загрузке: `error` на самом окне. Слушаем в фазе перехвата —
    // ошибка загрузки скрипта всплывает не как обычное событие.
    const onError = (e) => {
      if (!e) return;
      const res = scriptFailure(e.target);
      if (res) return void add(res);
      add(scriptError(e.error || { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error && e.error.stack }));
    };
    const onRejection = (e) => {
      const reason = e && e.reason;
      add(scriptError(reason && reason.message ? reason : { message: str(reason), stack: reason && reason.stack }));
    };

    // Проверка сборки окна: узлы на месте и модули собраны. Идёт после загрузки
    // разметки — раньше узлов ещё нет, и проверка была бы ложной.
    function check() {
      const nodes = missingFrom(REQUIRED_IDS, (id) => !!doc.getElementById(id));
      const mods = missingFrom(REQUIRED_MODULES, (name) => !!root[name]);
      if (!nodes.length && !mods.length) return null;
      return add(missingModel(mods, nodes));
    }

    // Ресурсные ошибки (файл не доехал) приходят на элемент и на документ; ошибки
    // работы окна — исключение в таймере или в обработчике — прилетают НА САМО
    // ОКНО, и до слушателя документа не доходят: путь события у них короткий
    // (окно → цель). Поэтому подписка на окно обязательна: без неё дозор молчал бы
    // ровно про те падения, ради которых он и заведён.
    const winAdd = win && typeof win.addEventListener === "function" ? win : null;
    doc.addEventListener("error", onError, true);
    if (winAdd) {
      winAdd.addEventListener("error", onError, true);
      winAdd.addEventListener("unhandledrejection", onRejection);
    }
    if (doc.readyState === "loading" && typeof doc.addEventListener === "function") {
      doc.addEventListener("DOMContentLoaded", check);
    } else {
      check();
    }

    // Версия исполняемого кода — по ней видно, работает окно на своём коде или на
    // наборе обновления. Спрашиваем тихо: нет моста (веб-режим) — молчим.
    try {
      const api = root.api;
      if (api && typeof api.otaStatus === "function") {
        Promise.resolve(api.otaStatus()).then(
          (st) => {
            const dir = st && (st.dir || st.root);
            const v = (st && st.installed) || "базовая";
            root.__bootCodeVersion = dir ? v + " (" + dir + ")" : v;
          },
          () => {}
        );
      } else {
        root.__bootCodeVersion = "веб-режим";
      }
    } catch {}

    // Текст разбора наружу: человеку нужно уметь переслать его как есть.
    root.bootReport = report;

    return function uninstall() {
      try {
        doc.removeEventListener("error", onError, true);
      } catch {}
      try {
        if (winAdd) winAdd.removeEventListener("error", onError, true);
        if (winAdd) winAdd.removeEventListener("unhandledrejection", onRejection);
      } catch {}
      try {
        doc.removeEventListener("DOMContentLoaded", check);
      } catch {}
      try {
        if (banner) banner.el.remove();
      } catch {}
      banner = null;
    };
  }

  // Самоподключение: дозор встаёт сразу при загрузке модуля, а не по просьбе
  // страницы — иначе он пропустил бы падение тех скриптов, что идут после него.
  // Повторная загрузка (набор обновления, двойной тег) ставит дозор ровно раз.
  function autoInstall() {
    if (typeof document === "undefined" || !document) return null;
    if (root.__bootGuardInstalled) return null;
    root.__bootGuardInstalled = true;
    return install(document);
  }

  const api = {
    install,
    autoInstall,
    problemsText,
    scriptFailure,
    scriptError,
    stackFrames,
    missingFrom,
    missingModel,
    copyText,
    REQUIRED_IDS,
    REQUIRED_MODULES,
  };

  if (typeof document !== "undefined" && document) autoInstall();

  return api;
});

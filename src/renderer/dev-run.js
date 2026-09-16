"use strict";

/* ─── Быстрый запуск проекта: dev-сервер, освобождение порта, его логи ────────
   Вынесено из app.js (этап 3 разбора гигантов). Здесь всё, что связано с запуском
   и остановкой dev-сервера проекта: определение занятого порта, старт, стоп, поток
   событий дев-процесса, дополнение команд в консоли (Tab) и вывод сервера в консоль.
   Статус запуска (previewRunning) наружу отдаётся живым свойством: оболочка окна
   читает его в строке состояния, и копия значения там устарела бы сразу.

   Зависимости приходят одним объектом — доступ к DOM ($), IPC (api), открытие
   превью, вывод в консоль, текущий проект, всплывашки и обновление строки
   состояния. Настройки — через getSettings(): их перезаписывают при смене профиля.
   Обработчики кнопок вешаются вызовом фабрики на прежнем месте app.js. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.DevRun = factory;
  }
})(typeof self !== "undefined" ? self : this, function (DevRunDeps) {
  const {
    $, api, isElectron, esc, previewOpen, projectDir,
    termAppend, toast, updateStatusBar, getSettings,
  } = DevRunDeps || {};
  // ── Быстрый запуск проекта в превью: старт/стоп dev-сервера, освобождение порта ──
  let previewLogLines = [];
  let previewRunning = false;

  function previewLogAppend(html) {
    previewLogLines.push(html);
    if (previewLogLines.length > 500) previewLogLines.splice(0, previewLogLines.length - 500);
    const log = $("preview-log");
    const wrap = $("preview-log-wrap");
    if (log) {
      log.innerHTML = previewLogLines.join("");
      wrap.classList.remove("hidden");
      wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function setPreviewStatus(running, err) {
    previewRunning = !!running;
    $("btn-preview-start").classList.toggle("hidden", running);
    $("btn-preview-stop").classList.toggle("hidden", !running);
    const st = $("preview-status");
    if (!st) return;
    const dot = st.querySelector(".ps-dot");
    const txt = st.querySelector("span");
    if (dot) dot.className = "ps-dot" + (running ? " on" : err ? " err" : " off");
    if (txt) txt.textContent = running ? "Запущен" : err ? "Ошибка" : "Остановлено";
    updateStatusBar();
  }

  function refreshDevControls() {
    if (!isElectron || !api.devStatus) return;
    api.devStatus(projectDir()).then((st) => {
      if (!st || !st.ok) return;
      const cmdInp = $("preview-cmd");
      if (cmdInp) {
        if (st.command && !cmdInp.value.trim()) cmdInp.value = st.command;
        if (!st.command && !cmdInp.value.trim() && st.detected) {
          cmdInp.value = st.detected;
          cmdInp.placeholder = st.detected;
        }
      }
      setPreviewStatus(st.running, false);
    });
  }

  async function devStartClick() {
    if (!isElectron || !api.devStart) return;
    if (previewRunning) return; // уже запускаем/запущен
    const cmd = $("preview-cmd").value.trim();
    setPreviewStatus(true, false);
    previewLogAppend('<div class="pl-cmd">▶ ' + esc(cmd || "…") + "</div>");
    const r = await api.devStart(projectDir(), cmd);
    if (!r || !r.ok) {
      setPreviewStatus(false, true);
      previewLogAppend('<div class="pl-err">✕ ' + esc((r && r.error) || "Не удалось запустить") + "</div>");
      toast((r && r.error) || "Не удалось запустить проект");
      return;
    }
    toast("Проект запущен: " + r.command);
    // Сразу открываем превью на настроенном адресе (по умолчанию http://localhost:5000).
    previewOpen(getSettings().previewUrl || "http://localhost:5000");
    refreshDevControls();
  }

  async function devStopClick() {
    if (!isElectron || !api.devStop) return;
    await api.devStop();
    previewLogAppend('<div class="pl-exit">⏹ процесс остановлен, порт освобождён</div>');
    setPreviewStatus(false, false);
    refreshDevControls();
  }

  // Логи запущенного сервера дублируются в консоль (вкладка «Консоль»)
  function termServerAppend(html) {
    termAppend('<div class="term-server">' + html + "</div>");
  }

  function onDevEvent(ev) {
    if (!ev) return;
    if (ev.type === "start") {
      previewLogAppend('<div class="pl-exit">— запуск: ' + esc(ev.command || "") + " в " + esc(ev.cwd || "") + " —</div>");
      termServerAppend('<span class="ts-info">— сервер запущен: ' + esc(ev.command || "") + " в " + esc(ev.cwd || "") + " —</span>");
      setPreviewStatus(true, false);
    } else if (ev.type === "out") {
      previewLogAppend("<span>" + esc(ev.text || "") + "</span>");
      termServerAppend("<span>" + esc(ev.text || "") + "</span>");
    } else if (ev.type === "exit") {
      const tail =
        "— сервер завершён (код " +
        esc(String(ev.code ?? "?")) +
        (ev.error ? ", " + esc(ev.error) : "") +
        ") —";
      previewLogAppend('<div class="pl-exit">' + tail + "</div>");
      termServerAppend('<span class="ts-err">' + tail + "</span>");
      setPreviewStatus(false, !!(ev.error || (ev.code != null && ev.code !== 0)));
    } else if (ev.type === "stopped") {
      previewLogAppend('<div class="pl-exit">— остановлено пользователем —</div>');
      termServerAppend('<span class="ts-info">— сервер остановлен —</span>');
      setPreviewStatus(false, false);
    }
  }

  // Tab-дополнение команды в терминале: один вариант — дополняем, несколько — показываем список
  function termTabComplete() {
    if (!isElectron || !api.termComplete) return;
    const inp = $("term-input");
    const line = inp.value;
    api.termComplete(line).then((r) => {
      if (!r) return;
      const matches = r.matches || [];
      if (matches.length === 1) {
        inp.value = (r.base || "") + matches[0];
      } else if (matches.length > 1) {
        termAppend('<div class="term-exit">' + matches.slice(0, 12).map((m) => esc(m)).join("  ") + (matches.length > 12 ? "  …" : "") + "</div>");
      }
    });
  }
  // previewRunning — живое состояние: оболочка читает его в строке состояния.
  return {
    get previewRunning() {
      return previewRunning;
    },
    refreshDevControls: refreshDevControls,
    devStartClick: devStartClick,
    devStopClick: devStopClick,
    termServerAppend: termServerAppend,
    onDevEvent: onDevEvent,
    termTabComplete: termTabComplete,
  };
});

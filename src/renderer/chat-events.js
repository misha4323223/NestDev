"use strict";

/* ─── События агента: разбор ai:event и оверлеи картинки/диффа/предпросмотра ──
   Вынесено из app.js (этап A, часть 1). Здесь всё, что окно делает по событию
   агента: текст в сегменты ответа, размышления, план (панель-чеклист), действия
   и их итоги, вопрос агента, плашки памяти/сжатия/зрения, переключение профилей,
   миссии и стадии деплоя. Рядом — три оверлея поверх окна: картинка из showImage,
   дифф из diffView, предпросмотр страницы из previewUI.

   Зависимости приходят одним объектом. ЖИВЫЕ функции, а не копии: настройки,
   история чатов, сессия запуска, счётчик откатов, состояние панели плана и отметка
   «прогон с телефона» переписываются по ходу работы — копия устарела бы молча.
   Модули панелей (правая панель, дела с миссией, панель проекта) объявлены в
   оболочке НИЖЕ точки сбора, поэтому берутся отложенными стрелками: прямое чтение
   биндинга упало бы с «Cannot access before initialization» и оборвало загрузку окна.
   Остальное — DOM ($), api, признак desktop-режима, uid, тосты, сборка и обновление
   сообщений, план работы, лента и сегменты ответа — передано значениями. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatEvents = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatEventsDeps) {
  const {
    $, api, isElectron, uid, toast, normalize, AgentCore,
    getSettings, setSettings, getChatsData, getSession, getReasoning,
    setLastUndoCount, setPlanCollapsed, getRemoteRunNotified, setRemoteRunNotified,
    msgEls, autoQueue, flushAutoQueue, persistChatsSoon, buildMessageEl, refreshMessage,
    openAskModal, closeAskModal, renderContext, planFromModel, planTextAdvance,
    planTextFinish, planToolOutcome, tryPlanFromRunText, renderPlanPanel,
    ChatSegments, ChatFeed, ChatThinking, ChatWork,
    getSidePanel, getTasksMission, getProjectPanel, getChatRun,
  } = ChatEventsDeps || {};
  function onAiEvent(ev) {
    // Служебная заметка прогона (например, ожидание лимита провайдера). Показываем тостом:
    // в «Консоль» за этим никто не следит, а ждать приходится молча и помногу.
    if (ev && ev.type === "notice") {
      if (ev.text) toast(ev.text);
      return;
    }
    // Напоминание о деле приходит вне прогона агента: тост + обновление панели.
    if (ev && ev.type === "task-reminder") {
      const list = Array.isArray(ev.tasks) ? ev.tasks : [];
      if (list.length) {
        const late = list.filter((t) => t.late).length;
        const text = list.length === 1
          ? (late ? "⚠ Просрочено: " : "⏰ Срок: ") + list[0].title
          : late ? "⚠ Просроченных дел: " + late : "⏰ Подошёл срок: " + list.length + " дел";
        toast(text);
      }
      getTasksMission().renderTasks();
      return;
    }
    // Срок автозадачи: приложение будит агента само (чат «Автозадачи»).
    if (ev && ev.type === "task-due") {
      if (!isElectron) return;
      const list = Array.isArray(ev.tasks) ? ev.tasks : [];
      for (const t of list) {
        // Планировщик повторяет попытку, пока прогон не подтвердится, — в очередь
        // одно и то же дело попадает один раз.
        if (t && t.id && !autoQueue.some((q) => q.id === t.id)) autoQueue.push(t);
      }
      flushAutoQueue();
      return;
    }
    // Автозадача так и не запустилась — об этом надо сказать вслух, а не молчать.
    if (ev && ev.type === "task-auto-failed") {
      const list = Array.isArray(ev.tasks) ? ev.tasks : [];
      if (list.length === 1) {
        const one = list[0];
        toast("⚠ Автозадача «" + one.title + "» не запустилась" + (one.error ? ": " + one.error : ""));
      } else if (list.length > 1) {
        toast("⚠ Автозадач не запустилось: " + list.length);
      }
      getTasksMission().renderTasks();
      return;
    }
    // Прогон запущен другим клиентом (обычно телефоном): у событий нет привязки к
    // переписке, поэтому в свой чат их не подмешиваем — иначе ответ с телефона
    // дописывался бы в открытую на ПК переписку. Результат придёт целиком через
    // chats:reload, когда телефон сохранит историю.
    if (ev && ev.from === "mobile" && !getSession()) {
      if (!getRemoteRunNotified()) {
        setRemoteRunNotified(true);
        toast("📱 Задача выполняется с телефона — результат появится здесь сам");
      }
      return;
    }
    const chat = getSession() ? getChatsData().chats.find((c) => c.id === getSession().chatId) : null;
    const aMsg = chat ? chat.messages.find((m) => m.id === getSession().assistantId) : null;
    switch (ev.type) {
      case "chunk": {
        const seg = ChatSegments.ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.content += ev.text;
          persistChatsSoon();
          ChatFeed.queueBubbleRender(chat, seg);
        }
        // План, написанный в ответе, показываем сразу, как только он сложился.
        tryPlanFromRunText(chat, aMsg);
        break;
      }
      case "thinking": {
        const seg = ChatSegments.ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.thinking = (seg.thinking || "") + ev.text;
          persistChatsSoon();
          const el = msgEls.get(seg.id);
          if (el) {
            ChatThinking.ensureThinkBox(el, seg.thinking);
            ChatFeed.scrollBottomSoon();
          }
        }
        // План в размышлениях: локальные модели формулируют его именно там.
        tryPlanFromRunText(chat, aMsg);
        break;
      }
      case "plan": {
        // Модель вызвала todoWrite — показываем её план панелью-чеклистом.
        if (planFromModel(chat, ev)) {
          setPlanCollapsed(false);
          renderPlanPanel();
          persistChatsSoon();
        }
        break;
      }
      case "tool_start":
        if (!chat) break;
        chat.messages.push({ id: uid(), role: "tool", toolName: ev.name, toolArgs: ev.args, toolResult: null, pending: true, createdAt: Date.now() });
        const toolEl = buildMessageEl(chat.messages[chat.messages.length - 1]);
        if (toolEl && toolEl.classList) toolEl.classList.add("in-work");
        ChatWork.addRow(toolEl);
        ChatWork.planAdd(ev);
        // Модель могла написать план текстом (или в размышлениях) вместо todoWrite —
        // разбираем его, чтобы панель-чеклист всё равно появилась.
        tryPlanFromRunText(chat, aMsg);
        // Работа пошла: текущий пункт текстового плана сразу становится «в работе»,
        // а не висит «ожидает» до конца раунда (иначе не видно, какой этап выполняется).
        if (
          chat &&
          chat.plan &&
          chat.plan.source === "text" &&
          Array.isArray(chat.plan.items) &&
          !chat.plan.items.some((i) => i.status === "in_progress")
        ) {
          if (planTextAdvance(chat, true)) renderPlanPanel();
        }
        ChatFeed.scrollBottom();
        persistChatsSoon();
        break;
      case "tool_result":
        if (!chat) break;
        let toolOk = true;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          const m = chat.messages[i];
          if (m.role === "tool" && m.toolName === ev.name && m.pending) {
            toolOk = !/^(Ошибка|⚠|Ошибка git|Ошибка:)/.test(ev.result || "");
            m.pending = false;
            m.toolResult = ev.result;
            m.toolOk = toolOk;
            refreshMessage(m);
            break;
          }
        }
        if (planToolOutcome(chat, ev, toolOk)) renderPlanPanel();
        ChatWork.planSet(ev, toolOk);
        persistChatsSoon();
        // Агент изменил файлы или git — обновляем панель проекта
        if (["writeFile", "editFile", "runCommand", "createFolder", "gitClone", "gitCommit", "gitRevert", "gitPush", "gitPull"].includes(ev.name)) {
          if (!$("project-panel").classList.contains("hidden")) setTimeout(getProjectPanel().refreshProject, 400);
        }
        break;
      case "text_override": {
        const seg = ChatSegments.ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.content = ev.text;
          persistChatsSoon();
          ChatFeed.queueBubbleRender(chat, seg);
        }
        break;
      }
      case "ask": {
        // Агент задал вопрос (askUser) — показываем модалку и ждём ответа
        openAskModal(ev.question || "Уточни, пожалуйста", ev.options, (t) => {
          if (isElectron && api.answerQuestion) api.answerQuestion(t);
        });
        break;
      }
      case "role_suggest": {
        // Агент ПРЕДЛАГАЕТ сменить роль чата (suggestRole). Роль меняет человек —
        // кнопкой; окно то же, что и у askUser, поэтому разметку не дублируем.
        // Смена вступит в силу со следующего сообщения: текущий прогон идёт в своей
        // роли (набор инструментов на ходу не меняется — ради кэша провайдера).
        const rsId = String(ev.role || "");
        const rsInfo = (AgentCore && AgentCore.roleById && AgentCore.roleById(rsId)) || { icon: "", title: rsId };
        const rsSwitch = "Переключиться на " + (rsInfo.icon ? rsInfo.icon + " " : "") + (rsInfo.title || rsId);
        const rsStay = "Остаться как есть";
        const rsWhy = String(ev.reason || "").trim();
        openAskModal((rsWhy ? rsWhy + "\n\n" : "") + "Переключить роль чата?", [rsSwitch, rsStay], (t) => {
          const switched = String(t || "").trim() === rsSwitch;
          if (switched) getTasksMission().setChatRole(rsId);
          if (isElectron && api.answerQuestion) api.answerQuestion(switched ? rsId : "");
        });
        break;
      }
      case "vision": {
        if (ev.text) {
          const note = document.createElement("div");
          note.className = "vision-note";
          note.textContent = ev.text;
          $("messages").appendChild(note);
          ChatFeed.scrollBottom();
        }
        break;
      }
      case "context": {
        renderContext(ev);
        break;
      }
      case "memory": {
        // Памятка контекста сохранена в локальный дневник (память диалогов) — плашка
        if (ev.text) {
          const mnote = document.createElement("div");
          mnote.className = "vision-note";
          mnote.textContent = ev.text;
          $("messages").appendChild(mnote);
          ChatFeed.scrollBottom();
        }
        break;
      }
      case "compact": {
        // Контекст сжат в памятку (экономия токенов) — показываем плашку
        if (ev.text) {
          const note = document.createElement("div");
          note.className = "vision-note";
          note.textContent = ev.text;
          $("messages").appendChild(note);
          ChatFeed.scrollBottom();
        }
        break;
      }
      case "image":
        showImageOverlay(ev.path || "", ev.dataUrl || "");
        break;
      case "diff":
        showPatchOverlay((ev.a || "") + "  ↔  " + (ev.b || ""), ev.patch || "");
        break;
      case "preview":
        // инструмент previewUI открывает постоянную правую панель (как в Replit),
        // а не разовый оверлей
        getSidePanel().openSidePanel("preview");
        getSidePanel().previewOpen(ev.url || "");
        break;
      case "undo_available": {
        setLastUndoCount(ev.count || 0);
        break;
      }
      case "mission": {
        // Движок миссии: батч, пауза, лимит, смена шага — панель обновляется сразу.
        getTasksMission().missionFromEvent(ev);
        break;
      }
      case "checkpoint": {
        // Авто-чекпоинт: агент закончил задачу и создал локальный коммит
        if (ev.message) toast(ev.message);
        break;
      }
      case "retry": {
        // Авто-повтор после сбоя: агент упал и продолжает с сохранённым контекстом
        const rErr = String(ev.error || "").slice(0, 200);
        toast("🔄 Попытка " + (ev.attempt || 2) + " из " + (ev.total || 3) + " после сбоя" + (rErr ? ": " + rErr : ""));
        break;
      }
      case "reasoning_unsupported": {
        // Провайдер сам сказал, что поля рассуждений (reasoning_effort / think) не знает.
        // Запоминаем это по модели: плашка 🧠 у неё пропадёт, и следующий запуск не будет
        // тратить раунд на ту же ошибку. Молча — объяснение уже ушло в «Консоль» строкой
        // метрик от самого прогона, человеку здесь делать нечего.
        const rMod = getReasoning && getReasoning();
        if (rMod && rMod.markUnsupported) rMod.markUnsupported(ev.key);
        break;
      }
      case "profile_switched": {
        // Авто-переключение между сохранёнными подключениями при ошибке ключа/баланса/лимита
        const pName = ev.name || "?";
        const pErr = String(ev.error || "").slice(0, 160);
        const ch = getSession() ? getChatsData().chats.find((c) => c.id === getSession().chatId) : null;
        if (ch) {
          ch.messages.push({
            id: uid(),
            role: "system",
            content: "🔄 Запрос упал" + (pErr ? ": " + pErr : "") + ".\nАвтоматически переключено на подключение «" + pName + "» — повторяю запрос с новым ключом.",
            createdAt: Date.now(),
          });
          const el = buildMessageEl(ch.messages[ch.messages.length - 1]);
          ChatWork.addRow(el);
          ChatFeed.scrollBottom();
          persistChatsSoon();
        }
        // Синхронизируем локальную копию настроек с main (активный профиль сменился)
        getSettings().openaiActiveProfile = ev.id || getSettings().openaiActiveProfile;
        if (isElectron) api.getSettings().then((s) => { if (s) setSettings(normalize(s)); });
        toast("🔄 Переключено на подключение «" + pName + "»");
        break;
      }
      case "resume":
        // Остановка с сохранённой работой (лимит раундов, «Стоп», пауза миссии) —
        // в окне загорается «▶ Продолжить»: раньше человек писал «продолжай» руками.
        // Признак приходит СВОИМ событием, а не разбором текста ответа: кнопка не
        // должна гореть после любой реплики со словом «продолжай».
        getChatRun().showResume(ev.reason);
        break;
      case "done":
        // План, написанный моделью текстом (или в размышлениях), разбираем и на финише,
        // а его текущий пункт закрываем: запуск завершён.
        tryPlanFromRunText(chat, aMsg);
        if (planTextFinish(chat)) {
          renderPlanPanel();
          persistChatsSoon();
        }
        // После завершения запуска обновляем панель git: авто-коммит мог очистить «Изменения»
        setTimeout(() => {
          if (!$("project-panel").classList.contains("hidden")) getProjectPanel().refreshProject();
        }, 300);
        break;
      case "error": {
        closeAskModal();
        const segs = ChatSegments.runSegments(chat, aMsg);
        for (const s of segs) s.pending = false;
        const lastSeg = segs[segs.length - 1] || aMsg;
        if (lastSeg) {
          lastSeg.error = ev.message;
          refreshMessage(lastSeg);
        }
        break;
      }
      case "deploy_stage": {
        if (window.DeployPanel && ev.stage) window.DeployPanel.onStage(ev.stage);
        break;
      }
      case "deploy_done": {
        if (window.DeployPanel) window.DeployPanel.onDone(ev);
        break;
      }
      case "yc_step": {
        const box = $("yc-deploy-box");
        const stepsEl = $("yc-deploy-steps");
        if (box && !box.classList.contains("hidden") && stepsEl) {
          const loading = stepsEl.querySelector(".yc-loading");
          if (loading) loading.remove();
          const d = document.createElement("div");
          d.className = "yc-step";
          d.textContent = ev.text || "";
          stepsEl.appendChild(d);
          const sp = $("sp-cloud");
          if (sp) sp.scrollTop = sp.scrollHeight;
        }
        break;
      }
    }
  }

  // Показ изображения, присланного инструментом showImage / screenshotCapture (событие image)
  function showImageOverlay(filePath, dataUrl) {
    const overlay = $("file-overlay");
    $("file-path").textContent = filePath || "Изображение";
    getProjectPanel().setFileViewPath("");
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const img = document.createElement("img");
    img.className = "image-view";
    img.src = dataUrl || "";
    img.alt = filePath || "изображение";
    content.appendChild(img);
    overlay.classList.remove("hidden");
  }

  // Визуальный дифф двух файлов (инструмент diffView, событие diff)
  function showPatchOverlay(title, patch) {
    const overlay = $("file-overlay");
    $("file-path").textContent = title || "Сравнение файлов";
    getProjectPanel().setFileViewPath("");
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "code-view";
    for (const ln of String(patch || "").split("\n")) {
      const line = document.createElement("div");
      let cls = "";
      if (/^(@@|diff --git|index |--- |\+\+\+ )/.test(ln)) cls = "meta";
      else if (/^\+/.test(ln)) cls = "add";
      else if (/^-/.test(ln)) cls = "del";
      line.className = "diff-line" + (cls ? " " + cls : "");
      line.textContent = ln || " ";
      pre.appendChild(line);
    }
    content.appendChild(pre);
    overlay.classList.remove("hidden");
  }

  // Встроенный предпросмотр сайта (инструмент previewUI, событие preview)
  function showPreviewOverlay(url) {
    const overlay = $("file-overlay");
    $("file-path").textContent = "Предпросмотр: " + url;
    getProjectPanel().setFileViewPath("");
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.src = url;
    content.appendChild(frame);
    overlay.classList.remove("hidden");
  }

  return {
    onAiEvent: onAiEvent,
    showImageOverlay: showImageOverlay,
    showPatchOverlay: showPatchOverlay,
    showPreviewOverlay: showPreviewOverlay,
  };
});

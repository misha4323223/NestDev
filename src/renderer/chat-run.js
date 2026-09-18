"use strict";

/* ─── Прогон ответа: состояние, завершение, остановка, откат изменений агента ──
   Вынесено из app.js (этап A, часть 8). Здесь всё, что происходит ВОКРУГ прогона:
   признак «идёт ответ» и его отрисовка в шапке (крутилка вместо кнопки отправки),
   остановка прогона, завершение ответа (готовые сегменты, кнопки под ответом) и
   откат правок агента по чекпоинту.

   Сама отправка (`sendMessage`/`runTurn`) живёт в оболочке: она связывает воедино
   панели, план и автозадачи. Здесь — то, что вызывается ПО ХОДУ и ПО КОНЦУ ответа.

   Живые доступы (функциями, а не значениями) — потому что эти значения меняются
   в течение хода, а копия застыла бы:
     • идёт ли прогон (streaming) — читается здесь и пишется через setStreamingFlag;
     • счётчик отката (lastUndoCount) — его ставят и разбор событий агента, и откат;
     • признак «кнопка отката уже показана» (undoRestoreShown) — сбрасывается при
       загрузке истории с другого устройства;
     • webAbort — нужен, чтобы остановить прогон в браузере (в Electron остановку
       делает главный процесс).

   Значениями приходят только неизменные: признак Electron, мост api, элементы
   сообщений, панели и модули интерфейса. */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatRun = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatRunDeps) {
  const {
    $, isElectron, api, toast, msgEls,
    getStreaming, setStreamingFlag,
    getLastUndoCount, setLastUndoCount,
    getUndoRestoreShown, setUndoRestoreShown,
    getWebAbort,
    getActiveChat, renderSidebar, autoResize, sendMessage,
    getProjectPanel,
    ChatStore, ChatSegments, ChatWork, ChatThinking, ChatRender,
  } = ChatRunDeps || {};

  async function finishStream(chat, aMsg) {
    // Все сегменты текущего запуска: помечаем готовыми, пустые промежуточные убираем.
    const segs = ChatSegments.runSegments(chat, aMsg);
    const anyText = segs.some((s) => s.content && !s.error);
    const kept = [];
    for (const s of segs) {
      s.pending = false;
      if (!s.content && !s.error) {
        if (!anyText && segs.indexOf(s) === segs.length - 1) s.content = "…";
        else {
          ChatSegments.removeSegment(chat, s);
          continue;
        }
      }
      kept.push(s);
    }
    const lastSeg = kept[kept.length - 1] || aMsg;
    // Именно setStreaming, а НЕ setStreamingFlag: одно только состояние оставило бы
    // в шапке крутилку и кнопку «Стоп» вместо «Отправить» — человек не смог бы
    // отправить следующую команду (кнопка скрыта), хотя прогон давно кончился.
    setStreaming(false);
    ChatStore.persistChatsNow();
    renderSidebar();
    const el = msgEls.get(lastSeg.id);
    if (el) {
      const b = el.querySelector(".bubble");
      if (b) {
        if (lastSeg.error) {
          b.textContent = lastSeg.error;
        } else {
          b.classList.add("md");
          b.innerHTML = ChatRender.msgHtml(lastSeg.content) || "…";
        }
        b.classList.remove("pending");
      }
    }
    ChatWork.finishGroup();
    // Ответ готов: сворачиваем блок «Размышление», если пользователь сам его не трогал
    for (const s of kept) {
      const sEl = msgEls.get(s.id);
      if (!sEl) continue;
      ChatThinking.collapseThinkBox(sEl);
    }
    // Кнопки действий под ответом: выполнить план / отменить изменения агента
    if (el && !lastSeg.error) {
      if (lastSeg.plan && lastSeg.content) {
        let actRow = el.querySelector(".ai-actions");
        if (!actRow) {
          actRow = document.createElement("div");
          actRow.className = "ai-actions";
          el.appendChild(actRow);
        }
        const bGo = document.createElement("button");
        bGo.className = "btn btn-primary btn-small";
        bGo.textContent = "▶ Выполнить план";
        bGo.onclick = () => {
          if (getStreaming()) return;
          lastSeg.plan = false;
          const cur = getActiveChat();
          if (!cur) return;
          // Отправляем короткую команду — модель видит предыдущий план в истории
          const inp = $("input");
          inp.value = "Выполни план, который ты составил. Не пересказывай план — сразу действуй.";
          autoResize();
          sendMessage();
        };
        actRow.appendChild(bGo);
      }
      if (isElectron) {
        let n = getLastUndoCount();
        if (!n) {
          try {
            const st = await api.undoStatus();
            n = st && st.ok ? st.count : 0;
          } catch {}
        }
        if (n > 0) addUndoButton(el);
      }
    }
    ChatWork.resetGroup();
  }

  // Кнопка «Отменить изменения агента» под ответом (чекпоинт последнего запуска).
  // Используется и сразу после ответа, и после перезапуска приложения (чекпоинт на диске).
  function addUndoButton(el) {
    if (!el) return;
    let actRow = el.querySelector(".ai-actions");
    if (!actRow) {
      actRow = document.createElement("div");
      actRow.className = "ai-actions";
      el.appendChild(actRow);
    }
    const bUndo = document.createElement("button");
    bUndo.className = "btn btn-ghost btn-small";
    bUndo.textContent = "↩ Отменить изменения агента (" + (getLastUndoCount() || 0) + ")";
    bUndo.title = "Вернуть файлы к состоянию до этого ответа";
    bUndo.onclick = async () => {
      if (getStreaming()) return;
      const r = await api.undoRollback();
      setLastUndoCount(0);
      if (r && r.ok) {
        getProjectPanel().toastShort("✅ Отменено: " + (r.count || 0) + " файлов");
        bUndo.remove();
        if (!$("project-panel").classList.contains("hidden")) getProjectPanel().refreshProject();
      } else {
        toast("Не удалось отменить изменения");
      }
    };
    actRow.appendChild(bUndo);
  }

  // После перезапуска приложения чекпоинт изменений агента (undo.json) ещё жив —
  // показываем кнопку отката под последним ответом. Вызывается из renderMessages
  // (первый рендер), дальше — один раз, чтобы не дублировать кнопку при смене чатов.
  function maybeRestoreUndoButton() {
    if (getUndoRestoreShown() || !isElectron) return;
    setUndoRestoreShown(true);
    api.undoStatus().then((st) => {
      if (!(st && st.ok && st.count > 0)) return;
      setLastUndoCount(st.count);
      const chat = getActiveChat();
      const lastAssistant =
        chat && [...chat.messages].reverse().find((m) => m.role === "assistant" && !m.error);
      if (lastAssistant) addUndoButton(msgEls.get(lastAssistant.id));
    });
  }

  // Признак идущего прогона: он же — вид шапки (крутилка вместо «Отправить» и кнопка «Стоп»).
  function setStreaming(v) {
    setStreamingFlag(v);
    $("typing").classList.toggle("hidden", !v);
    $("btn-stop").classList.toggle("hidden", !v);
    $("btn-send").classList.toggle("hidden", v);
  }

  function stop() {
    if (isElectron) api.stopMessage();
    else if (getWebAbort()) getWebAbort().abort();
  }

  return {
    finishStream,
    addUndoButton,
    maybeRestoreUndoButton,
    setStreaming,
    stop,
  };
});

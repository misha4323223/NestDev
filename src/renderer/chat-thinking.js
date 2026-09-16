"use strict";

/* ─── Блок размышлений модели над ответом ─────────────────────────────────────
   Вынесено из app.js (этап 3.7, часть 1). Здесь вся жизнь блока «Размышление»:
   сборка самой плашки (значок, заголовок, стрелка, тело), автопрокрутка вниз по
   мере роста текста (но не против человека, который отлистал вверх читать ранее
   написанное), ручное сворачивание кликом по заголовку, автосворачивание по
   завершении ответа и возврат сохранённых размышлений после перезагрузки.

   Своих зависимостей у модуля нет: он работает только с тем элементом сообщения,
   который ему дали, и с обычным DOM. Поэтому фабрику можно звать без аргументов. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatThinking = factory;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ─── Размышления модели (как в Replit) — блок над ответом, свёртывается по клику ───
  // При стриминге раскрыт и обновляется вживую; по завершении автоматически
  // сворачивается в одну строку (если пользователь сам не открыл его кликом).
  // Автопрокрутка размышлений: текст растёт — блок сам едет вниз, читать
  // конец вручную не нужно. Если пользователь отлистал вверх (читает ранее
  // написанное) — не выдёргиваем его и возвращаемся к автопрокрутке, когда он
  // снова окажется у конца.
  function thinkAutoScroll(body, force) {
    if (!body) return;
    if (!force && body.dataset && body.dataset.pinned === "0") return;
    if (body.dataset) body.dataset.pinned = "1";
    body.scrollTop = body.scrollHeight;
  }

  function ensureThinkBox(el, text) {
    let box = el.querySelector(".think");
    if (!box) {
      box = document.createElement("div");
      box.className = "think";
      const head = document.createElement("div");
      head.className = "think-head";
      const ic = document.createElement("span");
      ic.className = "think-ic";
      ic.textContent = "💭";
      const tt = document.createElement("span");
      tt.className = "think-t";
      tt.textContent = "Размышление";
      const chev = document.createElement("span");
      chev.className = "think-chev";
      chev.textContent = "▾";
      head.appendChild(ic);
      head.appendChild(tt);
      head.appendChild(chev);
      const body = document.createElement("div");
      body.className = "think-body";
      body.textContent = text || "";
      // Следим, у конца ли пользователь: ушёл вверх — автопрокрутку не навязываем.
      body.addEventListener("scroll", () => {
        const nearEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.dataset.pinned = nearEnd ? "1" : "0";
      });
      head.onclick = (e) => {
        e.stopPropagation();
        box.classList.add("user"); // управление вручную — автосворачивание больше не трогает блок
        const collapsed = box.classList.toggle("collapsed");
        chev.textContent = collapsed ? "▸" : "▾";
        if (!collapsed) thinkAutoScroll(body, true); // развернули — сразу показываем конец
      };
      thinkAutoScroll(body, true);
      box.appendChild(head);
      box.appendChild(body);
      const bubble = el.querySelector(".bubble");
      if (bubble) el.insertBefore(box, bubble);
      else el.appendChild(box);
    } else {
      const body = box.querySelector(".think-body");
      if (body && body.textContent !== (text || "")) {
        body.textContent = text || "";
        thinkAutoScroll(body); // текст вырос — едем вниз вместе с ним
      }
    }
    return box;
  }

  // Ответ готов: сворачиваем блок, если человек сам его не открывал кликом.
  // Класс «user» ставится при ручном открытии — такой блок автосворачивание не трогает.
  // Проверки на пустой элемент здесь свои: в цикле оболочки их держал вызывающий, а
  // модуль — общая граница, и «свернуть то, чего нет» обязано быть тихим бездействием.
  function collapseThinkBox(el) {
    const th = el && el.querySelector(".think");
    if (th && !th.classList.contains("user")) {
      th.classList.add("collapsed");
      const ch = th.querySelector(".think-chev");
      if (ch) ch.textContent = "▸";
    }
  }

  // Сохранённые размышления (после перезагрузки или переключения чата) — свёрнуты,
  // кроме случая, когда ответ ещё идёт: тогда блок должен быть раскрыт и расти вживую.
  function restoreThinkBox(el, text, pending) {
    const box = ensureThinkBox(el, text);
    if (!pending) {
      box.classList.add("collapsed");
      const ch = box.querySelector(".think-chev");
      if (ch) ch.textContent = "▸";
    }
    return box;
  }

  return {
    ensureThinkBox: ensureThinkBox,
    collapseThinkBox: collapseThinkBox,
    restoreThinkBox: restoreThinkBox,
  };
});

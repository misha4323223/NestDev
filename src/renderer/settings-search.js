"use strict";

/* ─── Поиск по настройкам: одна строка вместо десяти вкладок ─────────────────
   Вынесено из app.js (этап 3.8, часть 1). Пока в поле поиска что-то есть, вкладки
   не переключаются, а поля фильтруются по всем вкладкам сразу: совпадение внутри
   свёрнутой карточки провайдера раскрывается (иначе результат не видно), пустая
   вкладка скрывается, результаты подписываются категорией, а когда не нашлось
   ничего — показывается честное сообщение вместо пустого экрана.

   Прячем поля ТОЛЬКО своим классом sfilter-hide: служебный .hidden приложение
   ставит само (например #mobile-fields или #yandex-project-field), снимать его
   нельзя — поэтому очистка поиска возвращает ровно вкладку, где человек был.

   Зависимости приходят одним объектом: DOM ($) и ЖИВАЯ последняя вкладка
   (getLastTab — переменную переписывает переключение вкладок, копия устарела бы
   молча). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.SettingsSearch = factory;
  }
})(typeof self !== "undefined" ? self : this, function (SettingsSearchDeps) {
  const { $, getLastTab } = SettingsSearchDeps || {};
  // ── Поиск по настройкам ──
  // Прячем поля ТОЛЬКО своим классом sfilter-hide: служебный .hidden приложение
  // ставит само (например #mobile-fields или #yandex-project-field), снимать его нельзя.
  function settingsSearchInput() {
    return $("settings-search");
  }
  function settingsSearchActive() {
    const el = settingsSearchInput();
    return !!(el && el.value.trim());
  }
  function settingsSearchReset() {
    const el = settingsSearchInput();
    if (el) el.value = "";
    settingsSearchApply("");
  }
  // Текст поля для поиска: подпись + подсказки + placeholder/title самих контролов,
  // чтобы «sk-», «пароль», «токен» находились, даже если их нет в подписи.
  function settingsFieldText(f) {
    let t = f.textContent || "";
    f.querySelectorAll("input, textarea, select").forEach((el) => {
      t += " " + (el.placeholder || "") + " " + (el.title || "");
    });
    // Кнопка внутри поля тоже объясняет, что здесь делается: «Замерить скорость»
    // находится поиском по слову «замерить», хотя в подписи поля его нет.
    f.querySelectorAll("button").forEach((el) => {
      t += " " + (el.textContent || "") + " " + (el.title || "");
    });
    return t.toLowerCase();
  }
  function settingsSearchApply(raw) {
    const q = String(raw || "").trim().toLowerCase();
    const clearBtn = $("settings-search-clear");
    if (clearBtn) clearBtn.classList.toggle("hidden", !q);
    const bodies = Array.prototype.slice.call(document.querySelectorAll(".settings-tab-body"));
    const empty = $("settings-empty");
    const content = document.querySelector(".settings-content");
    if (content) content.classList.toggle("search-mode", !!q);
    // Карточки, раскрытые поиском, при выходе из поиска снова сворачиваем.
    document.querySelectorAll(".sfilter-open").forEach((acc) => acc.classList.remove("open", "sfilter-open"));
    if (!q) {
      document.querySelectorAll(".sfilter-hide").forEach((el) => el.classList.remove("sfilter-hide"));
      bodies.forEach((b) => b.classList.toggle("hidden", b.dataset.tabBody !== getLastTab()));
      if (empty) empty.classList.add("hidden");
      return;
    }
    let hits = 0;
    bodies.forEach((body) => {
      let bodyHits = 0;
      Array.prototype.forEach.call(body.children, (child) => {
        if (!child.classList) return;
        // Искать можно и в секциях, и в карточках провайдеров (.acc): в «Модели»
        // ключ и модель живут именно в карточках, а не в секции.
        const searchable = child.classList.contains("settings-section") || child.classList.contains("acc");
        if (searchable) {
          let blockHits = 0;
          child.querySelectorAll(".field").forEach((f) => {
            const on = settingsFieldText(f).indexOf(q) !== -1;
            f.classList.toggle("sfilter-hide", !on);
            if (on) blockHits++;
          });
          child.classList.toggle("sfilter-hide", blockHits === 0);
          bodyHits += blockHits;
        } else {
          // Всё остальное (подсказки моделей, панель провайдеров G4F) в результатах скрыто.
          child.classList.add("sfilter-hide");
        }
      });
      body.classList.toggle("hidden", bodyHits === 0);
      if (bodyHits) {
        // Совпадение внутри свёрнутой карточки — раскрываем её, иначе результата не видно.
        // Помечаем только те, что раскрыли мы: открытые до поиска не трогаем.
        body.querySelectorAll(".acc").forEach((acc) => {
          if (acc.querySelector(".field:not(.sfilter-hide)") && !acc.classList.contains("open")) {
            acc.classList.add("open", "sfilter-open");
          }
        });
        // Подписываем результаты категорией, иначе непонятно, из какой вкладки поле.
        const navBtn = document.querySelector('.stab[data-tab="' + body.dataset.tabBody + '"]');
        const labelEl = navBtn && navBtn.querySelector(".stab-text b");
        body.setAttribute("data-search-label", (labelEl && labelEl.textContent) || "");
      }
      hits += bodyHits;
    });
    if (empty) empty.classList.toggle("hidden", hits > 0);
  }

  return {
    input: settingsSearchInput,
    active: settingsSearchActive,
    reset: settingsSearchReset,
    fieldText: settingsFieldText,
    apply: settingsSearchApply,
  };
});

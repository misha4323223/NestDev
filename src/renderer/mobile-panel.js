"use strict";

/* ─── Мобильный доступ с телефона: QR-код, статус моста, PIN и адреса ─────────
   Вынесено из app.js (этап 3.6 разбора гигантов). Здесь всё, что относится к
   подключению телефона по локальной сети: QR-код «наведи камеру», PIN, список
   реальных адресов ПК, предупреждение о недостижимом адресе, предупреждение о
   незапустившемся мосте, смена PIN и чтение/запись этих полей в настройках.

   Зависимости приходят одним объектом: DOM ($), IPC (api), признак
   desktop-приложения (isElectron), живые настройки (getSettings — объект настроек
   перезаписывают, копия устарела бы молча) и сообщение под заголовком настроек
   (setSettingsMsg). QR-код рисует отдельный модуль (window.QR): здесь только вызов,
   а если его нет или он споткнулся — показываем адрес и PIN текстом, не пустое место. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.MobilePanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (MobilePanelDeps) {
  const { $, api, isElectron, getSettings, setSettingsMsg } = MobilePanelDeps || {};

  // ── Мобильный доступ: QR-код «наведи камеру телефона» ──
  // В коде — адрес моста и ОДНОРАЗОВЫЙ токен пары: телефон подключается одним
  // наведением камеры, без ручного ввода адреса и шести цифр. Токен (а не PIN)
  // нужен потому, что код на экране легко переснять или переслать: гаснет после
  // первого использования, и скриншот больше никого не пустит. Если токена нет
  // (старый мост), ссылка строится как раньше — с PIN, чтобы подключение не
  // пропало вовсе. Код остаётся светлым даже в тёмной теме (QR.toSvg рисует
  // белое поле): на тёмном фоне камера его не видит.
  function renderMobileQr(st) {
    const block = $("mobile-qr-block");
    const host = $("mobile-qr");
    if (!block || !host) return;
    const urls = (st && st.urls) || [];
    const pin = String((st && st.pin) || "");
    const pair = String((st && st.pair) || "");
    if (!(st && st.enabled && st.running) || !urls.length || !(pair || pin) || !window.QR) {
      block.classList.add("hidden");
      host.innerHTML = "";
      return;
    }
    try {
      host.innerHTML = window.QR.toSvg(
        pair ? urls[0].url + "/#pair=" + pair : urls[0].url + "/#pin=" + pin,
        { ecc: "M" }
      );
      block.classList.remove("hidden");
    } catch (e) {
      // Лучше показать адреса и PIN текстом, чем пустое место с чужой ошибкой.
      block.classList.add("hidden");
      host.innerHTML = "";
      console.warn("QR-код не построен:", (e && e.message) || e);
    }
  }

  // ── Мобильный доступ: статус моста, PIN, адреса для телефона ──
  async function renderMobileStatus() {
    const box = $("mobile-fields");
    const urls = $("mobile-urls");
    if (!isElectron || !api.mobileStatus) {
      if (box) box.classList.add("hidden");
      return;
    }
    box.classList.toggle("hidden", !$("s-mobile-enabled").checked);
    try {
      const st = await api.mobileStatus();
      if (!st) return;
      if ($("s-mobile-pin")) $("s-mobile-pin").value = st.pin || "";
      renderMobileQr(st);
      urls.innerHTML = "";
      const list = (st.urls && st.urls.length) ? st.urls : [{ url: st.url || "—" }];
      for (const u of list) {
        const a = document.createElement("a");
        a.className = "mobile-url-chip";
        a.href = u.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = u.url;
        urls.appendChild(a);
      }
      if (!st.urls || !st.urls.length) {
        const span = document.createElement("span");
        span.className = "mobile-url-none";
        span.textContent = "Нет доступных адресов — проверь подключение ПК к сети.";
        urls.appendChild(span);
      }
      // Адрес задан вручную, но такого IP на этом ПК нет: телефон по нему не дойдёт.
      if (st.host && !st.hostActive) {
        const warn = document.createElement("div");
        warn.className = "mobile-url-none";
        warn.textContent = "⚠ Адрес " + st.host + " на этом ПК не найден — показываю реальные. Поправь «Адрес для телефона».";
        urls.appendChild(warn);
      }
      if (st.enabled && !st.running) {
        const err = document.createElement("div");
        err.className = "mobile-url-none";
        err.textContent = "⚠ Мост не запустился (порт занят?). Попробуй другой порт.";
        urls.appendChild(err);
      }
      // Токен пары одноразовый: если им уже воспользовались, старый QR-код
      // больше не работает — об этом надо сказать, а не оставлять мёртвый код
      // на экране (человек будет водить камерой и не понимать, почему тишина).
      if (st.enabled && st.running && st.pairUsed) {
        const note = document.createElement("div");
        note.className = "mobile-url-none";
        note.textContent = "ℹ Код подключения использован. Для нового телефона нажми «Сменить PIN» — появится свежий QR-код.";
        urls.appendChild(note);
      }
    } catch (e) {
      urls.innerHTML = "";
      const span = document.createElement("span");
      span.className = "mobile-url-none";
      span.textContent = "Статус недоступен: " + (e.message || "");
      urls.appendChild(span);
    }
  }

  async function regenerateMobilePin() {
    if (!isElectron || !api.mobilePinRegen) return;
    try {
      const st = await api.mobilePinRegen();
      if (st && st.pin) {
        getSettings().mobilePin = st.pin;
        $("s-mobile-pin").value = st.pin;
        setSettingsMsg("Новый PIN: " + st.pin + " — покажи его на телефоне.", false);
      }
    } catch (e) {
      setSettingsMsg("Не удалось сменить PIN: " + (e.message || ""), true);
    }
  }

  // ── Панель в настройках: показать сохранённые значения ──
  // Возвращает обещание чтения статуса: оболочке оно не нужно, а тестам и панели — да
  // (иначе проверка «адрес показан» успела бы пройти до ответа главного процесса).
  function applyMobileFields() {
    const s = getSettings();
    $("s-mobile-enabled").checked = !!s.mobileEnabled;
    $("s-mobile-port").value = s.mobilePort || 9090;
    $("s-mobile-host").value = s.mobileHost || "";
    return renderMobileStatus();
  }

  // ── Панель в настройках: забрать значения в живые настройки ──
  function readMobileFields() {
    getSettings().mobileEnabled = !!$("s-mobile-enabled").checked;
    getSettings().mobilePort = parseInt($("s-mobile-port").value, 10) || 9090;
    getSettings().mobileHost = $("s-mobile-host").value.trim();
  }

  // ── Обработчики панели: галочка включает поля, кнопка меняет PIN ──
  // Поля прячутся и показываются сразу при переключении, а статус моста
  // перечитывается только при включении — выключенному мосту адреса не нужны.
  function initMobilePanel() {
    $("s-mobile-enabled").addEventListener("change", () => {
      $("mobile-fields").classList.toggle("hidden", !$("s-mobile-enabled").checked);
      if ($("s-mobile-enabled").checked) renderMobileStatus();
    });
    $("btn-mobile-pin-regen").onclick = regenerateMobilePin;
  }

  return {
    applyMobileFields: applyMobileFields,
    readMobileFields: readMobileFields,
    initMobilePanel: initMobilePanel,
  };
});

"use strict";

/* ─── Сохранённые OpenAI-совместимые подключения ──────────────────────────────
   Вынесено из app.js (этап 3.8, часть 2). Один и тот же ключ не нужно вставлять
   заново при смене провайдера: подключения лежат списком, переключаются одним
   выбором в списке, сохраняются кнопкой (новое или обновление выбранного) и
   удаляются с подтверждением. Имя новому подключению даётся по адресу, а если
   такой уже есть — с номером, чтобы два ключа одного сервиса не слились.

   Зависимости приходят одним объектом: DOM ($), новый идентификатор (uid),
   ЖИВЫЕ настройки (getSettings — объект переписывается целиком при загрузке и
   сохранении, копия устарела бы молча), словарь пресетов (PRESETS), сохранение
   (persistSettings) и сообщение под панелью (setSettingsMsg). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.OpenaiProfiles = factory;
  }
})(typeof self !== "undefined" ? self : this, function (OpenaiProfilesDeps) {
  const { $, uid, getSettings, PRESETS, persistSettings, setSettingsMsg } = OpenaiProfilesDeps || {};
  // ── Сохранённые OpenAI-подключения (несколько ключей) ──
  function profileNameFromUrl(url) {
    try {
      const m = String(url || "").match(/^https?:\/\/([^\/:?#]+)/i);
      return m ? m[1].replace(/^www\./, "") : "OpenAI";
    } catch {
      return "OpenAI";
    }
  }

  function openaiProfilesArr() {
    return Array.isArray(getSettings().openaiProfiles) ? getSettings().openaiProfiles : [];
  }

  // Перерисовывает выпадающий список сохранённых подключений
  function renderOpenaiProfiles() {
    const sel = $("s-openai-profile");
    if (!sel) return;
    const profs = openaiProfilesArr();
    sel.innerHTML = "";
    const optNew = document.createElement("option");
    optNew.value = "__new__";
    optNew.textContent = "➕ Новое подключение…";
    sel.appendChild(optNew);
    for (const p of profs) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name + (p.model ? " · " + p.model : "") + (String(p.apiKey || "").trim() ? "" : " (без ключа)");
      sel.appendChild(o);
    }
    sel.value =
      getSettings().openaiActiveProfile && profs.some((p) => p.id === getSettings().openaiActiveProfile)
        ? getSettings().openaiActiveProfile
        : "__new__";
  }

  // Применяет выбранное подключение к полям URL/ключ/модель/проект
  function applyOpenaiProfile(id) {
    const p = openaiProfilesArr().find((x) => x.id === id);
    if (!p) return;
    getSettings().openaiActiveProfile = p.id;
    $("s-openai-url").value = p.url || "";
    $("s-openai-key").value = p.apiKey || "";
    $("s-openai-model").value = p.model || "";
    $("s-openai-project").value = p.project || "";
    // Подсвечиваем пресет-чип по URL (не трогая поля — у подключения свои значения)
    const url = String(p.url || "").toLowerCase();
    let found = "";
    for (const [k, v] of Object.entries(PRESETS)) {
      if (v && v.url && url.includes(String(v.url).replace(/\/+$/, "").toLowerCase())) { found = k; break; }
    }
    document.querySelectorAll(".chip[data-preset]").forEach((c) => c.classList.toggle("active", c.dataset.preset === (found || "custom")));
    setSettingsMsg("Подключение «" + (p.name || p.id) + "» выбрано. Нажми «Сохранить настройки».", false);
  }

  // Сохраняет текущие URL/ключ/модель как новое подключение или обновляет выбранное
  function saveOpenaiProfileFromFields() {
    const sel = $("s-openai-profile");
    const profs = openaiProfilesArr();
    const url = $("s-openai-url").value.trim();
    if (!url) { setSettingsMsg("Сначала заполни базовый URL — без него подключение не сохранить.", true); return; }
    const key = $("s-openai-key").value.trim();
    const model = $("s-openai-model").value.trim();
    const project = $("s-openai-project").value.trim();
    const editingId = sel.value !== "__new__" ? sel.value : "";
    if (editingId) {
      const p = profs.find((x) => x.id === editingId);
      if (!p) return;
      p.url = url; p.apiKey = key; p.model = model; p.project = project;
      getSettings().openaiActiveProfile = p.id;
      setSettingsMsg("Подключение «" + (p.name || p.id) + "» обновлено.", false);
    } else {
      let name = profileNameFromUrl(url);
      const same = profs.filter((x) => x.name === name).length;
      if (same) name = name + " #" + (same + 1);
      profs.push({ id: uid(), name, url, apiKey: key, model, project });
      getSettings().openaiActiveProfile = profs[profs.length - 1].id;
      setSettingsMsg("Подключение «" + name + "» сохранено. Переключайся между ключами в один клик.", false);
    }
    persistSettings();
    renderOpenaiProfiles();
  }

  function deleteOpenaiProfile() {
    const sel = $("s-openai-profile");
    if (sel.value === "__new__") { setSettingsMsg("Выбери подключение из списка, чтобы удалить его.", true); return; }
    const profs = openaiProfilesArr();
    const p = profs.find((x) => x.id === sel.value);
    if (!p) return;
    if (!confirm("Удалить подключение «" + (p.name || p.id) + "»?")) return;
    getSettings().openaiProfiles = profs.filter((x) => x.id !== p.id);
    if (getSettings().openaiActiveProfile === p.id) getSettings().openaiActiveProfile = "";
    persistSettings();
    renderOpenaiProfiles();
    setSettingsMsg("Подключение удалено.", false);
  }

  return {
    profileNameFromUrl: profileNameFromUrl,
    arr: openaiProfilesArr,
    render: renderOpenaiProfiles,
    apply: applyOpenaiProfile,
    saveFromFields: saveOpenaiProfileFromFields,
    remove: deleteOpenaiProfile,
  };
});

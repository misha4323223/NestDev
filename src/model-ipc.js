"use strict";

/* ─── Модели, замер локальной модели и G4F: каналы окна ──────────────────────
   Вынесено из main.js (этап B, часть 2). Здесь всё, что окно спрашивает про модели
   и локальный сервер G4F:
     • g4f:probe     — найти живой инстанс (указанный URL, затем типовые порты);
     • g4f:test      — полный тест провайдера с логом в консоль приложения;
     • ai:models     — список моделей по текущим (или присланным из окна) настройкам;
     • ai:probeLocal — замер локальной модели: время загрузки, скорость чтения промпта
                       и генерации, сколько весов лежит в видеопамяти.

   Живого состояния у модуля нет: настройки читаются в момент вызова (loadSettings),
   а поля, присланные окном, накладываются сверху — как и было в main.js. Помощники
   ядра и список моделей приходят значениями: это модули и чистые функции.

   Тест провайдера делается в главном процессе нарочно: здесь нет CORS и видно сырые
   статусы и тела ответов; в окне такой тест показывал бы «ошибка сети» без причины. */

function registerModelIpc(deps) {
  const {
    ipcMain,
    loadSettings,
    normalizeSettings,
    fetchModels,
    SYSTEM_PROMPT,
    ROUTER_MAX_TOKENS,
    estimateTokens,
    contextBudget,
    windowBudget,
    modelWindow,
    ollamaNumCtx,
    isLocalEndpoint,
    probeLocalModel,
    netGuard,
  } = deps;

// ── G4F: поиск живого инстанса — указанный URL, затем типовые порты 1337 / 8080 ──
// Современный interference-API g4f живёт на 1337, старые сборки — на 8080.
// Используется кнопкой ▶ (подсказка при ошибке) и авто-подбором порта в настройках.
async function probeG4fBase(configuredBase, timeoutMs) {
  const t = timeoutMs || 2500;
  const candidates = [];
  const base = String(configuredBase || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(base)) candidates.push(base);
  for (const port of [1337, 8080]) {
    const u = "http://localhost:" + port + "/v1";
    if (!candidates.includes(u)) candidates.push(u);
  }
  for (const u of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), t);
    try {
      const res = await fetch(u + "/models", { signal: ctrl.signal });
      if (res.ok) {
        const body = await res.text().catch(() => "");
        let count = 0;
        try {
          const j = JSON.parse(body);
          const list = Array.isArray(j) ? j : (j.data || j.models || []);
          count = Array.isArray(list) ? list.length : 0;
        } catch {}
        return { base: u, count };
      }
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  return null;
}

ipcMain.handle("g4f:probe", async (_e, opts) => {
  // Адрес назвал интерфейс — цель запроса проверяем (см. src/net-guard.js).
  const want = String((opts && opts.url) || "").trim();
  if (want) {
    const target = netGuard.checkUrl(want);
    if (!target.ok) return { ok: false, error: target.error };
  }
  const found = await probeG4fBase(opts && opts.url);
  return found ? { ok: true, ...found } : { ok: false };
});

// ── G4F: тест провайдера (кнопка ▶ в настройках) — логи в консоль приложения ──
// Делается в главном процессе: здесь нет CORS и видно сырые статусы/тела ответов g4f.
ipcMain.handle("g4f:test", async (_e, opts) => {
  const log = [];
  const push = (level, text) => log.push({ level, text });
  const t0 = Date.now();
  const base = String((opts && opts.url) || "").trim().replace(/\/+$/, "");
  const provider = String((opts && opts.provider) || "").trim();
  const model = String((opts && opts.model) || "").trim();
  const fetchT = (url, init, timeoutMs) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    return fetch(url, Object.assign({ signal: ctrl.signal, redirect: "follow" }, init || {})).finally(() => clearTimeout(t));
  };
  const textT = (res) => res.text().catch(() => "");
  push("info", "Проверка G4F: провайдер «" + (provider || "?") + "» → " + (base || "URL пуст"));
  // Адрес назвал интерфейс, а запрос делает главный процесс: цель проверяем
  // ДО первой попытки — иначе через метаданные облака читался бы ответ (SSRF).
  if (base) {
    const target = netGuard.checkUrl(base);
    if (!target.ok) {
      push("err", target.error);
      return { ok: false, log };
    }
  }
  if (!/^https?:\/\//i.test(base)) {
    push("err", "Базовый URL не заполнен или не похож на http://localhost:1337/v1 — поправь поле URL.");
    return { ok: false, log };
  }
  // 1) Список моделей
  const mUrl = base + "/models";
  try {
    const res = await fetchT(mUrl, {}, 15000);
    const body = await textT(res);
    push("info", "GET " + mUrl + " → HTTP " + res.status + " (" + (Date.now() - t0) + " мс)");
    if (!res.ok) {
      push("err", "Ответ не 2xx: " + body.slice(0, 300));
    } else {
      let arr = [];
      try {
        const j = JSON.parse(body);
        const list = Array.isArray(j) ? j : (j.data || j.models || []);
        arr = list.map((m) => (typeof m === "string" ? m : (m && (m.id || m.name)) || "")).filter(Boolean);
      } catch {}
      if (arr.length) push("ok", "Моделей отдаёт: " + arr.length + ". Первые: " + arr.slice(0, 8).join(", "));
      else push("warn", "Список моделей пуст или в неожиданном формате: " + body.slice(0, 200));
    }
  } catch (e) {
    push("err", "GET /models не прошёл: " + (e.message || String(e)) + ". Проверь, что g4f запущен («g4f api»).");
    // Подсказка: а не отвечает ли живой g4f на другом порту (1337 вместо 8080 и наоборот)?
    const alt = await probeG4fBase(base, 2500);
    if (alt && alt.base !== base) {
      push("ok", "Живой g4f найден на «" + alt.base + "» (моделей: " + alt.count + ") — а в поле URL указан «" + (base || "пусто") + "». Поправь URL, сохрани настройки и повтори тест.");
    } else if (!alt) {
      push("warn", "Живой g4f не найден ни на одном порту (1337 / 8080). Проверь, что запущен: `g4f api` (или `python -m g4f api`).");
    }
  }
  // 2) Минимальный чат-запрос: что РЕАЛЬНО отвечает провайдер
  if (provider && provider !== "default" && model) {
    const cUrl = base + "/chat/completions";
    push("info", "POST " + cUrl + " — модель «" + model + "» через провайдера «" + provider + "» (max_tokens 8)");
    const t1 = Date.now();
    try {
      const res = await fetchT(cUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          provider,
          messages: [{ role: "user", content: "Ответь одним словом: пинг" }],
          max_tokens: 8,
          stream: false,
        }),
      }, 30000);
      const body = await textT(res);
      if (!res.ok) {
        push("err", "HTTP " + res.status + " (" + (Date.now() - t1) + " мс): " + body.slice(0, 400));
      } else {
        let snippet = "";
        try {
          const j = JSON.parse(body);
          const c0 = j.choices && j.choices[0];
          snippet = c0 && c0.message && c0.message.content
            ? String(c0.message.content).trim().slice(0, 140)
            : (c0 && c0.text ? String(c0.text).trim().slice(0, 140) : "");
        } catch {}
        if (snippet) push("ok", "Ответ получен (" + (Date.now() - t1) + " мс): «" + snippet + "» — провайдер отвечает.");
        else push("warn", "HTTP 200, но текста в ответе нет (" + (Date.now() - t1) + " мс). Сырой ответ: " + body.slice(0, 300));
      }
    } catch (e) {
      push("err", "POST /chat/completions не прошёл: " + (e.message || String(e)));
    }
  } else if (provider === "default") {
    push("warn", "Провайдер «default» — авто-режим: проверяется только список моделей, чат-тест пропущен.");
  } else {
    push("warn", "Модель не указана — чат-тест пропущен. Выбери модель провайдера (чипы ниже) и повтори.");
  }
  push("info", "— Проверка завершена за " + (Date.now() - t0) + " мс —");
  return { ok: true, log };
});


ipcMain.handle("ai:models", async (_e, ui) => {
  const s = normalizeSettings({ ...loadSettings(), ...(ui || {}) });
  // Адрес может прийти от интерфейса — цель запроса проверяем (см. src/net-guard.js).
  const target = netGuard.checkSettingsUrls(s);
  if (!target.ok) return { ok: false, message: target.error, models: [] };
  try {
    return { ok: true, models: await fetchModels(s) };
  } catch (e) {
    return { ok: false, message: e.message || String(e), models: [] };
  }
});
// ── Замер локальной модели: сколько она думает и на чём считает ───────────────
// Проверка подключения говорит только «сервер жив». Здесь считаем то, что важно для
// местной модели: время загрузки, скорость чтения промпта, скорость генерации и
// сколько весов лежит в видеопамяти. Размер контекста берём РОВНО тот, с которым
// работает чат, — иначе замер шёл бы про другую конфигурацию и (хуже) заставил бы
// Ollama перезагрузить модель прямо перед следующим ответом.
ipcMain.handle("ai:probeLocal", async (_e, ui) => {
  const s = normalizeSettings({ ...loadSettings(), ...(ui || {}) });
  const target = netGuard.checkSettingsUrls(s);
  if (!target.ok) return { ok: false, message: target.error };
  try {
    const provider = s.provider || "openai";
    let win = 0;
    try {
      win = await modelWindow(s, s.model);
    } catch {}
    let budget = contextBudget(provider, s.model);
    if (win > 0) budget = windowBudget(provider, budget, win, { local: isLocalEndpoint(s) });
    const numCtx = provider === "ollama" ? ollamaNumCtx(budget, win) : 0;
    // «Наш обычный запрос»: системный промпт + потолок схем инструментов + история.
    // Это верхняя оценка того, что уйдёт модели в обычном раунде.
    const promptTokens = estimateTokens(SYSTEM_PROMPT) + ROUTER_MAX_TOKENS + 3000;
    return await probeLocalModel(s, s.model, {
      window: win,
      budget: budget,
      numCtx: numCtx,
      promptTokens: promptTokens,
    });
  } catch (e) {
    const why = (e && e.message) || String(e);
    return { ok: false, error: why, lines: ["❌ Локальная модель не измерена: " + why] };
  }
});

  // Поиск живого G4F не зависит от окна, поэтому его же собирает и тест напрямую.
  return { probeG4fBase };
}

module.exports = { registerModelIpc };

"use strict";

/* Подключение к провайдеру: куда обращаться, с каким ключом и заголовками,
   сколько ждать при лимитах и как показать ошибку человеку.

   Вынесено из agent-core.js. Модуль не знает ни о сообщениях агента, ни о
   настройках приложения: реестр провайдеров берётся из аргументов функций,
   поэтому его можно проверять отдельно от агента и переиспользовать. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ProviderConfig = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT_BASES = {
    ollama: "http://localhost:11434",
    openai: "https://api.groq.com/openai/v1",
    anthropic: "https://api.anthropic.com",
  };

  // ── Реестр провайдеров G4F (маршрут «Провайдер:модель» в поле модели) ──
  // rec: ★ рекомендованные — стабильные и работающие без ключа/логина.
  // Список один на всех: его же использует транспорт buildChatRequest, чтобы
  // передать провайдера современному g4f отдельным полем provider.
  const G4F_PROVIDERS = [
    { name: "default", desc: "Авто: G4F сам выберет модель и провайдера", rec: true },
    { name: "DeepInfra", desc: "DeepSeek, Qwen, Kimi, GLM — стабильный OpenAI-совместимый API", rec: true , models: ["deepseek-ai/DeepSeek-V3.1","Qwen/Qwen2.5-72B-Instruct","Qwen/Qwen3-32B"] },
    { name: "HuggingChat", desc: "DeepSeek, Qwen, GLM — бесплатный чат Hugging Face", rec: true , models: ["deepseek-ai/DeepSeek-V3","Qwen/Qwen2.5-72B-Instruct","meta-llama/Llama-3.3-70B-Instruct","Qwen/Qwen3-235B-A22B"] },
    { name: "Together", desc: "DeepSeek, Qwen, Llama — быстрый API", rec: true , models: ["deepseek-ai/DeepSeek-V3","Qwen/Qwen2.5-72B-Instruct","meta-llama/Llama-3.3-70B-Instruct"] },
    { name: "Pollinations", desc: "GPT-OSS, DeepSeek, Qwen — бесплатно", rec: true , models: ["openai/gpt-oss-120b","openai/gpt-oss-20b","deepseek/deepseek-v3.1"] },
    { name: "OpenRouterFree", desc: "Бесплатные :free-модели OpenRouter", rec: true , models: ["deepseek/deepseek-r1:free","qwen/qwen3-235b-a22b:free","meta-llama/llama-3.3-70b-instruct:free"] },
    { name: "Groq", desc: "Очень быстрые Llama / DeepSeek", rec: true , models: ["llama-3.3-70b-versatile","deepseek-r1-distill-llama-70b","llama-3.1-8b-instant"] },
    { name: "Airforce", desc: "gpt-oss, kimi-k3, glm-5.3 — огромный каталог", rec: true , models: ["gpt-oss-120b","gpt-4o","kimi-k2","glm-4.5"] },
    { name: "HuggingFace", desc: "Inference API Hugging Face" , models: ["Qwen/Qwen2.5-72B-Instruct","meta-llama/Llama-3.3-70B-Instruct"] },
    { name: "HuggingSpace", desc: "Модели с HF Spaces: Command R, Qwen" , models: ["CohereForAI/c4ai-command-r-plus","Qwen/Qwen2.5-72B-Instruct"] },
    { name: "OpenRouter", desc: "1000+ моделей (многие с суффиксом :free)" , models: ["openai/gpt-4o-mini","anthropic/claude-3.5-sonnet","deepseek/deepseek-chat"] },
    { name: "Yqcloud", desc: "gpt-4 — работает без всего" , models: ["gpt-4"] },
    { name: "KiloCode", desc: "Nemotron, MiniMax — для кода" , models: ["nvidia/Llama-3.1-Nemotron-70B-Instruct","minimax/MiniMax-M2"] },
    { name: "ThebApi", desc: "Агрегатор TheB.AI" , models: ["gpt-4o","claude-3.5-sonnet","deepseek-chat"] },
    { name: "Perplexity", desc: "Claude Opus / Sonnet через поиск (может просить вход)" , models: ["sonar-pro","sonar"] },
    { name: "Copilot", desc: "Microsoft Copilot — GPT-4o, o1" , models: ["gpt-4o","o1"] },
    { name: "OpenaiChat", desc: "ChatGPT бесплатно — gpt-4.1, o3" , models: ["gpt-4.1","gpt-4o-mini","o3-mini"] },
    { name: "Gemini", desc: "Google Gemini 2.5/3 (иногда нужны куки)" , models: ["gemini-2.5-flash","gemini-2.0-flash"] },
    { name: "Antigravity", desc: "Google Antigravity — Gemini + Claude" , models: ["gemini-2.5-flash","claude-3.5-sonnet"] },
    { name: "Qwen", desc: "Модели Qwen напрямую" , models: ["qwen-max","qwen-plus","qwen-turbo"] },
    { name: "DeepSeek", desc: "chat.deepseek.com — нужен HAR-логин" , models: ["deepseek-chat","deepseek-reasoner"] },
    { name: "Claude", desc: "Anthropic Claude (обычно нужен ключ или аккаунт)" , models: ["claude-3-5-sonnet"] },
    { name: "Anthropic", desc: "Официальный API Anthropic" , models: ["claude-sonnet-4-5","claude-opus-4-1","claude-haiku-4-5"] },
    { name: "Grok", desc: "xAI Grok — рассуждения и код" , models: ["grok-3","grok-3-mini"] },
    { name: "xAI", desc: "API xAI" , models: ["grok-3","grok-3-mini"] },
    { name: "Nvidia", desc: "NVIDIA NIM — opensource-модели" , models: ["meta/llama-3.3-70b-instruct","deepseek-ai/deepseek-r1"] },
    { name: "Cerebras", desc: "Очень быстрые Llama / Qwen" , models: ["llama-3.3-70b","llama-3.1-8b"] },
    { name: "MiniMax", desc: "MiniMax M — сильный кодер" , models: ["MiniMax-M1-80k","MiniMax-M2"] },
    { name: "GlhfChat", desc: "Модели Hugging Face через glhf.chat" , models: ["Qwen/Qwen3-235B-A22B","deepseek-ai/DeepSeek-R1"] },
    { name: "LMArena", desc: "Публичные модели LMArena" , models: ["llama-3.3-70b"] },
    { name: "MetaAI", desc: "Llama через Meta AI" , models: ["llama-3.3-70b-instruct"] },
    { name: "Puter", desc: "Llama бесплатно" , models: ["llama-3.3-70b-instruct"] },
    { name: "GigaChat", desc: "Сбер GigaChat" , models: ["GigaChat-Pro","GigaChat-Max"] },
    { name: "Replicate", desc: "Open-source модели через Replicate" , models: ["meta/meta-llama-3-70b-instruct"] },
    { name: "PhindAi", desc: "Phind — специалист по коду" , models: ["Phind-V2","Phind-V2-75B"] },
    { name: "Cloudflare", desc: "Workers AI Cloudflare" , models: ["@cf/meta/llama-3.1-8b-instruct"] },
    { name: "OperaAria", desc: "Opera Aria — GPT-4o" , models: ["gpt-4o"] },
    { name: "WhiteRabbitNeo", desc: "WhiteRabbit Neo — безопасный кодер" , models: ["WhiteRabbitNeo-33B"] },
    { name: "BlackboxPro", desc: "Blackbox AI — GPT, Claude" , models: ["blackboxai-3.5"] },
    { name: "OrcaRouter", desc: "Роутер моделей (как OpenRouter)" , models: ["qwen3-max"] },
    { name: "HailuoAI", desc: "MiniMax Hailuo" , models: ["MiniMax-M1"] },
  ];
  const G4F_PROVIDER_NAMES = new Set(G4F_PROVIDERS.map((p) => p.name));

  // G4F-маршрут «Провайдер:модель» (например HuggingChat:gpt-4o-mini).
  // Возвращает { provider, model } только если префикс — известный провайдер G4F
  // (иначе не трогаем имя: у OpenRouter и других бывают свои двоеточия, например :free).
  function splitG4fRoute(model) {
    const m = String(model || "");
    const i = m.indexOf(":");
    if (i <= 0 || i === m.length - 1) return null;
    const prefix = m.slice(0, i);
    if (!G4F_PROVIDER_NAMES.has(prefix)) return null;
    return { provider: prefix, model: m.slice(i + 1) };
  }

  function trimBase(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  // Anthropic Messages API живёт под /v1; если пользователь вписал URL уже с /v1 — не дублируем.
  function anthropicApiBase(url) {
    return trimBase(url).replace(/\/v1\/?$/i, "");
  }

  function baseFor(provider, s) {
    if (provider === "ollama") return trimBase(s.ollamaUrl || DEFAULT_BASES.ollama);
    if (provider === "anthropic") return anthropicApiBase(s.anthropicUrl || DEFAULT_BASES.anthropic);
    return trimBase(s.openaiUrl || s.externalUrl || DEFAULT_BASES.openai); // legacy externalUrl — миграция
  }

  // Веб-предпросмотр: Yandex AI Studio не отдаёт CORS-заголовки — браузер блокирует
  // прямые запросы («Failed to fetch»). В браузерном режиме база переписывается на
  // локальный прокси preview-сервера (/api/llm/...), который ходит в Яндекс сам.
  // Веб-предпросмотр: Yandex AI Studio и Ollama Cloud не отдают CORS-заголовки —
  // браузер блокирует прямые запросы («Failed to fetch»). В браузерном режиме база
  // переписывается на локальный прокси preview-сервера (/api/llm/...), который ходит
  // к провайдеру сам (server.js разрешает внешние https, внутренние сети — 403).
  // Локальный ли адрес: свой ПК или домашняя сеть. Один признак нужен в ДВУХ местах:
  // прокси веб-превью не должен заворачивать localhost, а агент по нему понимает, что
  // токены бесплатны (бюджет от окна модели, а не облачный потолок) и что модель
  // может быть неспешной. Раньше «локальность» определялась только по имени провайдера
  // («ollama»), поэтому LM Studio и vLLM на localhost считались платным облаком.
  function isLocalBase(url) {
    const s = String(url || "").trim();
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(s);
  }

  function proxiedBase(base) {
    const b = String(base || "");
    if (
      typeof location !== "undefined" && location && location.origin &&
      /^https:\/\//i.test(b) && !isLocalBase(b)
    ) {
      return location.origin + "/api/llm/" + encodeURIComponent(b);
    }
    return b;
  }

  function apiKeyFor(provider, s) {
    if (provider === "anthropic") return s.anthropicApiKey || s.apiKey || "";
    if (provider === "openai") return s.openaiApiKey || s.apiKey || "";
    return "";
  }

  function apiHeaders(provider, apiKey, fromBrowser, extra) {
    const h = { "Content-Type": "application/json" };
    if (provider === "ollama") return h;
    if (provider === "anthropic") {
      h["x-api-key"] = apiKey || "";
      h["anthropic-version"] = "2023-06-01";
      // Anthropic разрешает вызовы из браузера только с этим заголовком.
      if (fromBrowser) h["anthropic-dangerous-direct-browser-access"] = "true";
      return h;
    }
    if (apiKey) h.Authorization = "Bearer " + apiKey;
    if (extra && typeof extra === "object") Object.assign(h, extra);
    return h;
  }

  // Yandex AI Studio (OpenAI-совместимый эндпоинт): каталог (папка) передаётся заголовком OpenAI-Project.
  function projectHeader(s) {
    const f = s && s.openaiProject ? String(s.openaiProject).trim() : "";
    return f ? { "OpenAI-Project": f } : null;
  }

  function jsonArgs(args) {
    if (args && typeof args === "object") return args;
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return {};
  }

  function genCallId() {
    return "call_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  // Заголовок HTML-страницы ошибки: у шлюзовых страниц (Cloudflare) в нём лежит и
  // хост, и код («example.com | 524: A timeout occurred») — этого человеку хватает.
  const HTML_TITLE = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i;

  /** Читает тело ошибочного ответа и возвращает человекочитаемый фрагмент. */
  async function readApiError(res) {
    const body = await res.text().catch(() => "");
    let detail = (body || "").slice(0, 600);
    try {
      const j = JSON.parse(body);
      const err = (j && j.error) || j;
      detail = typeof err === "string" ? err.slice(0, 600) : JSON.stringify(err, null, 2).slice(0, 600);
      return detail;
    } catch {}
    // Не JSON? Чаще всего это HTML-СТРАНИЦА шлюза или его CDN (Cloudflare 520/524 и
    // родственные коды): запрос до модели не дошёл, а разбирать её как текст нечего.
    // Раньше эта простыня тегов уезжала в чат и журнал целиком — человек видел
    // «<!DOCTYPE html>…» вместо причины. Берём из страницы только заголовок.
    if (/<(!doctype|html|head|body|\?xml)/i.test(detail)) {
      const m = HTML_TITLE.exec(detail);
      const title = m ? m[1].replace(/\s+/g, " ").trim().slice(0, 160) : "";
      return (
        "HTML-страница вместо JSON (шлюз провайдера или его CDN)" +
        (title ? ": «" + title + "»" : "") +
        " — причины в теле нет, дело на стороне провайдера"
      );
    }
    return detail;
  }

  // Понятное объяснение лимитных ошибок провайдеров вместо сырого JSON.
  // Groq free: ~7K входных токенов/мин (ITPM) для всех моделей, а системный
  // промпт + схемы инструментов агента весят десятки тысяч токенов — обрезка
  // истории не поможет, нужен другой провайдер или платный тир.
  function friendlyRateLimitError(status, detail, settings) {
    const s = settings || {};
    const base = String(s.openaiUrl || s.externalUrl || "");
    const isGroq = /groq\.com/i.test(base);
    const d = String(detail || "");
    const isTokenMinute =
      /per minute|tokens per minute|ITPM|rate_limit_exceeded|reduce your message size/i.test(d);
    if (isGroq && (status === 413 || status === 429) && isTokenMinute) {
      return (
        "API error " + status + ": Groq (бесплатный тариф) ограничивает входные токены ~7 000/мин, "
        + "а запрос агента (системный промпт + схемы инструментов + контекст) весит десятки тысяч "
        + "токенов — лимит исчерпывается ещё до ответа, и обрезка истории здесь не поможет.\n\n"
        + "Как продолжить:\n"
        + "1) переключись в Настройках → «🌐 OpenAI-совместимые» на чип Ollama Cloud (gpt-oss:120b), "
        + "Yandex (DeepSeek V4 Flash) или Cerebras — они уже настроены и без этого лимита;\n"
        + "2) либо включи Groq Dev Tier (console.groq.com/settings/billing) — лимит вырастет.\n"
        + "Бесплатный Groq подходит только для коротких сообщений без инструментов."
      );
    }
    return null;
  }

  // Классифицирует ошибку провайдера: лечится ли она сменой ключа.
  // key=true только для «ключ/баланс/лимит»: 401/403 (неверный ключ), 402/insufficient
  // (нет баланса/квоты), 429/rate limit (лимит запросов). Ошибки запроса (400),
  // фильтра контента и сети — НЕ про ключ, менять его бессмысленно.
  // cooldownMs — на сколько «отложить» провинившийся ключ, чтобы не долбить провайдера.
  function classifyKeyError(errText) {
    const t = String(errText || "");
    if (/API error 401|API error 403|unauthorized|invalid[_ ]?api[_ ]?key|authentication|неверн\w* ключ/i.test(t)) {
      return { key: true, reason: "auth", cooldownMs: 10 * 60 * 1000 };
    }
    if (/API error 402|insufficient|quota|balance|баланс|недостаточно средств|кончил\w* деньг/i.test(t)) {
      return { key: true, reason: "quota", cooldownMs: 5 * 60 * 1000 };
    }
    if (/API error 429|rate[_ ]?limit|too many requests|per minute|ITPM|TPM|лимит/i.test(t)) {
      return { key: true, reason: "rate", cooldownMs: 60 * 1000 };
    }
    return { key: false, reason: null, cooldownMs: 0 };
  }

  // ── Лимиты провайдера: сколько ждать и как не бить в 429 вслепую ─────────
  // Провайдеры сообщают лимит по-разному: заголовком Retry-After, текстом
  // («Please retry in 12.3s», «try again in 5 seconds», retryDelay: "12s") или
  // словами о частоте («8 requests per minute»). Раньше всё это просто
  // превращалось в ошибку — раунд терялся, и агент ждал вслепую.
  function rateLimitInfo(status, headers, detail) {
    const h = headers && typeof headers.get === "function" ? headers : null;
    let retryMs = 0;
    if (h) {
      const ra = parseFloat(h.get("retry-after"));
      if (isFinite(ra) && ra > 0) retryMs = Math.min(ra * 1000, 120000);
      if (!retryMs) {
        const reset = parseFloat(h.get("x-ratelimit-reset-requests") || h.get("x-ratelimit-reset"));
        if (isFinite(reset) && reset > 0) retryMs = Math.min(reset, 120000);
      }
    }
    const d = String(detail || "");
    if (!retryMs) {
      const m = /(?:retry|try again|повтори\w*|через|retryDelay)\D{0,24}?(\d+(?:[.,]\d+)?)\s*(ms|мил\w*|сек\w*|sec\w*|s\b|мин\w*|min\w*)/i.exec(d);
      if (m) {
        const v = parseFloat(String(m[1]).replace(",", "."));
        const unit = String(m[2]).toLowerCase();
        const mult = /^ms|мил/.test(unit) ? 1 : /^мин|^min/.test(unit) ? 60000 : 1000;
        if (isFinite(v) && v > 0) retryMs = Math.min(v * mult, 120000);
      }
    }
    // Частота и ОКНО лимита: «8 requests per minute», «Maximum 8 requests within 1 minutes»,
    // «10 запросов в минуту». Раньше окно не разбиралось: провайдер писал «within 1 minutes»,
    // частота оставалась нулевой, пауза бралась наугад (5 с) — и прогон падал после трёх попыток,
    // хотя лечится простым ожиданием окна.
    let rpm = 0;
    let windowMs = 0;
    // \w не знает кириллицы, поэтому суффиксы слов разбираем явно, а флаг u — чтобы
    // регистр русских букв не ломал разбор.
    const r = /(\d+)\s*(?:requests?|queries|rpm|req|запрос[а-яё]*)\s*(?:per|\/|within|in|each|за|в)\s*(\d+(?:[.,]\d+)?)?\s*(milliseconds?|minutes?|mins?|ms|seconds?|secs?|hours?|hrs?|s\b|m\b|h\b|миллисекунд[а-яё]*|секунд[а-яё]*|сек[а-яё]*|минут[а-яё]*|мин[а-яё]*|час[а-яё]*)/iu.exec(d);
    if (r) {
      const count = parseInt(r[1], 10) || 0;
      const span = parseFloat(String(r[2] || "1").replace(",", ".")) || 1;
      const unit = String(r[3] || "minute").toLowerCase();
      const mult = /^ms|^milli|^миллисек/.test(unit)
        ? 1
        : /^h|^час/.test(unit)
          ? 3600000
          : /^min|^мин|^m$/.test(unit)
            ? 60000
            : 1000;
      windowMs = span * mult;
      if (count > 0 && windowMs > 0) rpm = (count * 60000) / windowMs;
    }
    // Время повтора провайдер не назвал, но окно лимита известно — ждём окно целиком:
    // после него счётчик запросов точно обнулится.
    if (!retryMs && windowMs > 0) retryMs = Math.min(windowMs, 120000);
    return { retryMs: Math.round(retryMs), rpm: rpm };
  }

  // Держатель темпа: узнали частоту — расставляем запросы по времени сами, чтобы
  // вообще не получать 429 (каждый 429 — потерянный раунд и ожидание вслепую).
  function createRateLimiter() {
    let minIntervalMs = 0;
    let nextAt = 0;
    return {
      pendingMs() {
        return Math.max(0, nextAt - Date.now());
      },
      // Ждёт, если предыдущий запрос был слишком недавно. Возвращает, сколько ждал.
      async take() {
        const now = Date.now();
        const wait = Math.max(0, nextAt - now);
        nextAt = Math.max(now, nextAt) + minIntervalMs;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        return wait;
      },
      // Запоминает лимит: частоту (rpm) и паузу после 429.
      note(info) {
        const i = info || {};
        if (i.rpm > 0) {
          const per = Math.min(Math.ceil(60000 / i.rpm), 30000);
          if (per > minIntervalMs) minIntervalMs = per;
        }
        if (i.retryMs > 0) nextAt = Math.max(nextAt, Date.now() + Math.min(i.retryMs, 120000));
      },
    };
  }

  // Ошибка → читаемый текст. Отдельно ловим «промис вместо ошибки» (забыт await):
  // иначе в интерфейс попадало бесполезное «[object Promise]» вместо причины сбоя.
  function fmtError(e) {
    if (e instanceof Error) return e.message || String(e);
    if (e && typeof e.then === "function") return "Promise вместо ошибки (в коде забыт await)";
    if (e == null) return String(e);
    if (typeof e === "object") {
      try {
        return JSON.stringify(e).slice(0, 500) || String(e);
      } catch {
        return String(e);
      }
    }
    return String(e);
  }

  return {
    DEFAULT_BASES,
    G4F_PROVIDERS,
    G4F_PROVIDER_NAMES,
    splitG4fRoute,
    trimBase,
    anthropicApiBase,
    baseFor,
    isLocalBase,
    proxiedBase,
    apiKeyFor,
    apiHeaders,
    projectHeader,
    jsonArgs,
    genCallId,
    readApiError,
    friendlyRateLimitError,
    classifyKeyError,
    rateLimitInfo,
    createRateLimiter,
    fmtError,
  };
});

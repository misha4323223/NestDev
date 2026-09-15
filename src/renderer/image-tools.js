"use strict";

/* Вспомогательная модель (второй ключ): разбор картинок (зрение) и генерация изображений.
   Вынесено из agent-core.js. Ядро передаёт сюда только транспортные помощники —
   apiHeaders, proxiedBase, readApiError; собственных настроек модуль не читает. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ImageTools = factory;
  }
})(typeof self !== "undefined" ? self : this, function (deps) {
  const { apiHeaders, proxiedBase, readApiError } = deps || {};
  // База вспомогательной модели. Известным провайдерам достраиваем версию пути:
  // без неё запрос уходит на несуществующий адрес и человек видит пустую ошибку
  // («https://api.openai.com/images/generations» вместо «.../v1/images/generations»).
  //   Gemini       → только /v1beta/openai (с «голым» /v1 там нет /chat/completions)
  //   OpenAI       → /v1
  //   OpenRouter   → /api/v1
  // Чужие пути (свой прокси, шлюз) не трогаем.
  function normalizeAuxBase(url) {
    const s = String(url || "").trim().replace(/\/+$/, "");
    if (!s) return "";
    const g = s.match(/^(https?:\/\/generativelanguage\.googleapis\.com)(?:\/.*)?$/i);
    if (g) return g[1] + "/v1beta/openai";
    const o = s.match(/^(https?:\/\/api\.openai\.com)(?:\/(v1))?$/i);
    if (o) return o[1] + "/v1";
    const r = s.match(/^(https?:\/\/openrouter\.ai)(?:\/(api\/v1))?$/i);
    if (r) return r[1] + "/api/v1";
    return s;
  }

  // ── Вспомогательная модель (второй ключ): зрение + генерация изображений ──
  function auxConfig(s) {
    s = s || {};
    return {
      enabled: !!s.visionEnabled,
      auto: s.visionAuto !== false,
      url: normalizeAuxBase((s.visionUrl || "").trim() || (s.openaiUrl || "").trim() || ""),
      key: (s.visionKey || "").trim() || (s.openaiApiKey || "").trim() || "",
      visionModel: (s.visionModel || "").trim(),
      imageModel: (s.imageModel || "").trim(),
      project: (s.openaiProject || "").trim(),
    };
  }

  // Чтение изображения vision-моделью: dataUrl → текстовое описание.
  async function describeImageRemote(cfg, imageDataUrl, prompt, model) {
    const res = await fetch(proxiedBase(cfg.url) + "/chat/completions", {
      method: "POST",
      headers: apiHeaders("openai", cfg.key, false, cfg.project ? { "OpenAI-Project": cfg.project } : null),
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt || "Опиши подробно, что изображено на картинке: объекты, текст, UI, цвета, расположение элементов." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(180000) : undefined,
    });
    // readApiError() асинхронная и читает тело ответа: сначала она, потом res.json().
    // Без await в текст ошибки попадал сам промис («[object Promise]»).
    if (!res.ok) throw new Error("Vision: " + (await readApiError(res)));
    const data = await res.json().catch(() => ({}));
    const c = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join("\n").trim();
    return String(c == null ? "" : c).trim();
  }

  // ── Генерация изображений: один адрес — много провайдеров ───────────────────
  // Пути у провайдеров РАЗНЫЕ, и это была главная причина «пустой ошибки»:
  //   OpenRouter              → POST {base}/images
  //   OpenAI / Gemini / Azure → POST {base}/images/generations
  //   YandexART (AI Studio)   → POST foundationModels/v1/imageGenerationAsync + опрос
  //   локальная Stable Diffusion (A1111) → POST {base}/sdapi/v1/txt2img
  // Тип подключения пользователь не выбирает: провайдер определяется по адресу,
  // «свой» путь идёт первым, при ошибке протокола пробуем следующий, а удачный
  // вариант запоминаем для этого хоста (в пределах процесса).
  const IMAGE_WRONG_PROTOCOL = new Set([400, 404, 405, 406, 415, 501]);
  const IMAGE_TIMEOUT_MS = 300000;
  const YANDEX_ART_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/imageGenerationAsync";
  const YANDEX_OPS_URL = "https://llm.api.cloud.yandex.net/operations/";
  const _imageKindByHost = new Map(); // host → kind, который уже сработал

  function imageHostOf(url) {
    try {
      return new URL(String(url || "")).host.toLowerCase();
    } catch {
      return "";
    }
  }

  function isLocalImageHost(host) {
    return (
      /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /\.local(:\d+)?$/.test(host)
    );
  }

  // Провайдер по адресу. Пусто — сервер незнакомый (свой прокси/шлюз): тогда
  // порядок попыток универсальный, а нужный путь находится по ответу.
  function imageHostKind(url) {
    const host = imageHostOf(normalizeAuxBase(url));
    if (!host) return "";
    if (/openrouter\.ai$/.test(host)) return "openrouter";
    if (/generativelanguage\.googleapis\.com$/.test(host)) return "openai_images";
    if (/(^|\.)openai\.com$/.test(host) || /\.openai\.azure\.com$/.test(host)) return "openai_images";
    if (/api\.cloud\.yandex\.net$/.test(host)) return "yandex_art";
    if (isLocalImageHost(host)) return /:7860$/.test(host) ? "sd_webui" : "";
    return "";
  }

  // Имя по сработавшему протоколу — так точнее, чем по одному хосту.
  function imageKindLabel(kind, host) {
    const h = String(host || "");
    if (kind === "openrouter") return "OpenRouter";
    if (kind === "yandex_art") return "YandexART (Яндекс AI Studio)";
    if (kind === "sd_webui") return "Stable Diffusion (локально, A1111)";
    if (kind === "openai_images") {
      if (/googleapis\.com$/.test(h)) return "Gemini (OpenAI-совместимо)";
      if (/openai\.azure\.com$/.test(h)) return "Azure OpenAI";
      if (/(^|\.)openai\.com$/.test(h)) return "OpenAI";
      return "OpenAI-совместимо (определено по ответу)";
    }
    return "неизвестный протокол";
  }

  // Человеческое имя провайдера — для настроек и для отчёта агенту.
  // До первого запроса оно предварительное (по хосту), после успеха — по факту.
  function imageProviderLabel(url) {
    const host = imageHostOf(normalizeAuxBase(url));
    if (!host) return "адрес не задан";
    const kind = imageHostKind(url);
    if (kind) return imageKindLabel(kind, host);
    if (isLocalImageHost(host)) return "локальный сервер — определю по ответу";
    return "незнакомый адрес — определю по ответу";
  }

  // Пропорции «16:9» / «16x9» / «16/9» → [16, 9]; мусор → null.
  function aspectPair(ratio) {
    const m = String(ratio || "").trim().match(/^(\d{1,3})\s*[:\/x]\s*(\d{1,3})$/i);
    if (!m) return null;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    return w && h ? [w, h] : null;
  }

  // Размер для OpenAI-семейства. У dall-e-3 и gpt-image-1 РАЗНЫЕ наборы допустимых
  // значений, поэтому подставляем только там, где значение точно принимается,
  // а у Gemini и прочих size не шлём вовсе (у них свои допустимые значения).
  function sizeForImageModel(model, ratio) {
    const p = aspectPair(ratio);
    if (!p) return "";
    const m = String(model || "").toLowerCase();
    const gpt = /gpt-image/.test(m);
    const dalle = /dall-e-3/.test(m);
    if (!gpt && !dalle) return "";
    const wide = p[0] / p[1];
    if (Math.abs(wide - 1) < 0.02) return "1024x1024";
    if (wide > 1.2) return gpt ? "1536x1024" : "1792x1024";
    if (wide < 0.83) return gpt ? "1024x1536" : "1024x1792";
    return "1024x1024";
  }

  // Список попыток по порядку: { kind, url, headers, body }.
  function imageAttempts(cfg, prompt, model, opts) {
    opts = opts || {};
    cfg = cfg || {};
    const base = normalizeAuxBase(cfg.url).replace(/\/+$/, "");
    const key = String(cfg.key || "").trim();
    const m = String(model || "");
    const ratio = String(opts.aspectRatio || "").trim();
    const size = sizeForImageModel(m, ratio);
    const plain = { "Content-Type": "application/json" };
    const bearer = Object.assign({}, plain, key ? { Authorization: "Bearer " + key } : {});
    const headers = cfg.project ? Object.assign({}, bearer, { "OpenAI-Project": String(cfg.project) }) : bearer;

    const openai = () => {
      const body = { model: m, prompt: prompt, n: 1 };
      if (size) body.size = size;
      // gpt-image-1 не принимает response_format — он всегда отдаёт base64.
      if (!/gpt-image/i.test(m)) body.response_format = "b64_json";
      return { kind: "openai_images", url: base + "/images/generations", headers: headers, body: body };
    };
    // Этот вариант нужен только если провайдер отверг сам параметр
    // (400/422 «unknown parameter»), а не когда не найден путь (404/405).
    const openaiNoFormat = () => {
      const body = { model: m, prompt: prompt, n: 1 };
      if (size) body.size = size;
      return {
        kind: "openai_images",
        url: base + "/images/generations",
        headers: headers,
        body: body,
        afterStatuses: [400, 422],
      };
    };
    const openrouter = () => {
      const body = { model: m, prompt: prompt };
      if (ratio) body.aspect_ratio = ratio;
      return { kind: "openrouter", url: base + "/images", headers: headers, body: body };
    };
    const sd = () => {
      const pair = aspectPair(ratio) || [1, 1];
      const width = pair[0] >= pair[1] ? 1024 : Math.round((1024 * pair[0]) / pair[1]);
      const height = pair[1] >= pair[0] ? 1024 : Math.round((1024 * pair[1]) / pair[0]);
      return {
        kind: "sd_webui",
        url: base + "/sdapi/v1/txt2img",
        headers: plain,
        body: { prompt: prompt, width: width, height: height, steps: 25 },
      };
    };
    const yandex = () => {
      const folder = String(cfg.project || "").trim();
      const uri = /^art:\/\//i.test(m) ? m : "art://" + folder + "/" + (m || "yandex-art/latest");
      const gen = { seed: Math.floor(Math.random() * 1000000) };
      const pair = aspectPair(ratio);
      if (pair) gen.aspectRatio = { widthRatio: String(pair[0]), heightRatio: String(pair[1]) };
      // ART принимает ключ только в формате Api-Key (IAM-токен t1.* — Bearer).
      const auth = key ? { Authorization: /^t1\./.test(key) ? "Bearer " + key : "Api-Key " + key } : {};
      return {
        kind: "yandex_art",
        url: YANDEX_ART_URL,
        headers: Object.assign({}, plain, auth),
        body: { modelUri: uri, generationOptions: gen, messages: [{ weight: "1", text: prompt }] },
      };
    };

    const makers = { openai_images: openai, openrouter: openrouter, sd_webui: sd, yandex_art: yandex };
    const kind = imageHostKind(base);
    const order =
      kind === "openrouter"
        ? ["openrouter", "openai_images"]
        : kind === "yandex_art"
          ? ["yandex_art", "openai_images", "openrouter"]
          : kind === "sd_webui"
            ? ["sd_webui", "openai_images", "openrouter"]
            : ["openai_images", "openrouter", "sd_webui"];
    const out = [];
    for (const id of order) {
      const attempt = makers[id]();
      out.push(attempt);
      // Провайдеры, не знающие response_format, отвечают 400 — даём вариант без него.
      if (id === "openai_images" && attempt.body.response_format) out.push(openaiNoFormat());
    }
    return out;
  }

  // Адрес для запроса: прокси-режим браузера кодирует только БАЗУ, а путь идёт
  // после неё отдельным сегментом (так же собирает запросы чат). Если закодировать
  // адрес целиком, server.js ответит 400 «Bad proxy path».
  function proxiedUrl(fullUrl) {
    const s = String(fullUrl || "");
    try {
      const u = new URL(s);
      return proxiedBase(u.origin) + u.pathname + u.search;
    } catch {
      return proxiedBase(s);
    }
  }

  function imageTimeout(ms) {
    return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  }

  // base64 из бинарника: в Node есть Buffer, в браузере — btoa.
  async function arrayBufferToB64(buf) {
    const bytes = new Uint8Array(buf);
    if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(bytes).toString("base64");
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function extForMediaType(mediaType) {
    const t = String(mediaType || "").split(";")[0].trim().toLowerCase();
    if (t === "image/jpeg" || t === "image/jpg") return ".jpg";
    if (t === "image/webp") return ".webp";
    if (t === "image/gif") return ".gif";
    if (t === "image/svg+xml") return ".svg";
    return ".png";
  }

  // Разбор ответа провайдера → { b64, mediaType } или null.
  async function imageFromResponse(attempt, data) {
    if (attempt.kind === "openai_images" || attempt.kind === "openrouter") {
      const d = data && data.data && data.data[0];
      if (d && d.b64_json) {
        const mediaType = String(d.media_type || "image/png").split(";")[0].trim() || "image/png";
        return { b64: String(d.b64_json), mediaType: mediaType };
      }
      if (d && d.url) {
        // Часть провайдеров отдаёт ссылку вместо base64 — скачиваем её сами.
        const r = await fetch(proxiedUrl(String(d.url)), { signal: imageTimeout(120000) });
        if (!r.ok) throw new Error("картинка по ссылке не скачалась: HTTP " + r.status);
        const ct = r.headers && r.headers.get ? r.headers.get("content-type") : "";
        const mediaType = String(ct || "image/png").split(";")[0].trim() || "image/png";
        return { b64: await arrayBufferToB64(await r.arrayBuffer()), mediaType: mediaType };
      }
      return null;
    }
    if (attempt.kind === "sd_webui") {
      const img = data && Array.isArray(data.images) ? data.images[0] : "";
      if (!img) return null;
      return { b64: String(img).replace(/^data:image\/[a-z+]+;base64,/i, ""), mediaType: "image/png" };
    }
    return null;
  }

  // YandexART работает только асинхронно: запуск → опрос операции → base64 jpeg.
  async function pollYandexArt(headers, opId) {
    const url = YANDEX_OPS_URL + encodeURIComponent(opId);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 5000));
      const res = await fetch(proxiedUrl(url), { headers: headers, signal: imageTimeout(30000) });
      if (!res.ok) throw new Error("опрос операции: HTTP " + res.status + " · " + (await readApiError(res)));
      const d = await res.json().catch(() => ({}));
      if (d && d.error) throw new Error("ART ответил ошибкой: " + String(d.error.message || JSON.stringify(d.error)).slice(0, 200));
      if (d && d.done) {
        const r = d.response || {};
        const img = r.image || (Array.isArray(r.images) ? r.images[0] : "");
        if (!img) throw new Error("ART завершил операцию без изображения");
        return String(img);
      }
    }
    throw new Error("ART не отдал картинку за 100 с — попробуй ещё раз или другую модель");
  }

  // Ошибка генерации: адрес, все попытки с кодом и телом (раньше терялись и статус,
  // и адрес — отсюда «ошибка пустая»), и что именно проверять.
  function describeImageFailures(base, failures) {
    return (
      "Не удалось сгенерировать изображение.\nАдрес: " + (base || "(пусто)") +
      "\nПопытки:\n  · " + failures.join("\n  · ") +
      "\nЧто проверить: URL и ключ вспомогательной модели, имя модели (OpenAI: gpt-image-1 / dall-e-3, Gemini: gemini-2.5-flash-image / imagen-4.0-generate-001, OpenRouter: openai/dall-e-3) и поддержку генерации у провайдера."
    );
  }

  // Генерация изображения: prompt → { b64, mediaType, ext, kind, label }.
  // Файл пишет вызывающая сторона (main.js) — ядро не зависит от Buffer
  // и одинаково работает в десктопе и в браузере (это же и позволяет проверять
  // генерацию живым тестом в настоящем Chromium).
  async function generateImageRemote(cfg, prompt, model, opts) {
    opts = opts || {};
    cfg = cfg || {};
    const base = normalizeAuxBase(cfg.url);
    const host = imageHostOf(base);
    const all = imageAttempts(cfg, prompt, model, opts);
    if (!base) throw new Error("Не задан адрес вспомогательной модели (Настройки → «Зрение и генерация»).");
    const remembered = _imageKindByHost.get(host);
    const attempts = remembered
      ? all.filter((a) => a.kind === remembered).concat(all.filter((a) => a.kind !== remembered))
      : all;
    const failures = [];
    let lastStatus = 0; // чтобы не повторять один и тот же путь дважды
    for (const a of attempts) {
      if (a.afterStatuses && a.afterStatuses.indexOf(lastStatus) === -1) continue;
      let res;
      try {
        res = await fetch(proxiedUrl(a.url), {
          method: "POST",
          headers: a.headers,
          body: JSON.stringify(a.body),
          signal: imageTimeout(IMAGE_TIMEOUT_MS),
        });
      } catch (e) {
        const why = e && e.name === "TimeoutError" ? "таймаут" : "сеть недоступна";
        failures.push(why + " · " + a.url + " · " + String((e && e.message) || e).slice(0, 120));
        continue;
      }
      if (!res.ok) {
        lastStatus = res.status;
        const detail = String(await readApiError(res)).replace(/\s+/g, " ").slice(0, 200);
        failures.push("HTTP " + res.status + " · " + a.url + " · " + (detail || "(пустой ответ)"));
        // 401/403/429/5xx — это не «не тот протокол»: другой путь не поможет, не спамим.
        if (!IMAGE_WRONG_PROTOCOL.has(res.status)) break;
        continue;
      }
      const data = await res.json().catch(() => ({}));
      let img = null;
      try {
        if (a.kind === "yandex_art") {
          const opId = data && (data.id || (data.metadata && data.metadata.id));
          if (!opId) {
            failures.push("ЯндексART · не получил id операции · " + a.url);
            continue;
          }
          img = { b64: await pollYandexArt(a.headers, opId), mediaType: "image/jpeg" };
        } else {
          img = await imageFromResponse(a, data);
        }
      } catch (e) {
        failures.push(a.kind + " · " + String((e && e.message) || e).slice(0, 200));
        continue;
      }
      if (!img) {
        const why = data && data.error ? String(data.error.message || JSON.stringify(data.error)).slice(0, 200) : "в ответе нет изображения";
        failures.push(a.kind + " · " + why);
        continue;
      }
      _imageKindByHost.set(host, a.kind);
      return { b64: img.b64, mediaType: img.mediaType, ext: extForMediaType(img.mediaType), kind: a.kind, label: imageKindLabel(a.kind, host) };
    }
    throw new Error(describeImageFailures(base, failures));
  }

  return {
    normalizeAuxBase,
    auxConfig,
    describeImageRemote,
    generateImageRemote,
    imageAttempts,
    imageProviderLabel,
    imageKindLabel,
    imageHostKind,
    sizeForImageModel,
    proxiedUrl,
    IMAGE_TIMEOUT_MS,
    YANDEX_ART_URL,
    YANDEX_OPS_URL,
  };
});

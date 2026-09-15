"use strict";

/* Веб: поиск и чтение страниц (без API-ключей).
   Вынесено из agent-core.js: раньше эти функции жили внутри фабрики ядра и были
   доступны только через общий объект AgentCore. Теперь это самостоятельный модуль
   без зависимостей — его можно подключать и проверять отдельно от агента.
   Общий для Electron main, веб-режима и preview-сервера (server.js). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.WebTools = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ═══════════════════ Веб: поиск и чтение страниц (без API-ключей) ═══════════════════
  // Общие для Electron main, веб-режима и preview-сервера (server.js).

  function stripHtml(s) {
    return String(s || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .trim();
  }

  // Скачивает HTML-страницу с таймаутом; { ok, text } или { ok:false, error }.
  async function downloadHtml(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AI-Developer-Agent/1.0",
          "Accept-Language": "ru,en;q=0.8",
        },
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      const text = await res.text();
      return { ok: true, text: text.slice(0, 2 * 1024 * 1024) }; // максимум 2 МБ на обработку
    } catch (e) {
      return { ok: false, error: e && e.name === "AbortError" ? "таймаут" : (e && e.message) || String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Распаковывает ссылку DuckDuckGo: //duckduckgo.com/l/?uddg=<url>&rut=... → https://<url>
  function ddgUrlToHttps(url) {
    let u = String(url || "");
    const ud = u.match(/[?&]uddg=([^&]+)/);
    if (ud) {
      try { u = decodeURIComponent(ud[1]); } catch { u = ud[1]; }
    } else if (u.startsWith("//")) {
      u = "https:" + u;
    }
    return u;
  }

  // Парсит html.duckduckgo.com/html: a.result__a + a.result__snippet
  function parseDdgHtml(html) {
    const results = [];
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const url = ddgUrlToHttps(m[1]);
      if (!/^https?:\/\//i.test(url)) continue;
      const title = stripHtml(m[2]);
      if (!title) continue;
      results.push({ title, url });
    }
    const snRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let sn;
    let i = 0;
    while ((sn = snRe.exec(html)) && i < results.length) {
      results[i].snippet = stripHtml(sn[1]);
      i++;
    }
    return results;
  }

  // Парсит lite.duckduckgo.com/lite: a.result-link + td.result-snippet
  function parseDdgLite(html) {
    const results = [];
    const re = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const url = ddgUrlToHttps(m[1]);
      if (!/^https?:\/\//i.test(url)) continue;
      const title = stripHtml(m[2]);
      if (!title) continue;
      results.push({ title, url });
    }
    const snRe = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
    let sn;
    let i = 0;
    while ((sn = snRe.exec(html)) && i < results.length) {
      results[i].snippet = stripHtml(sn[1]);
      i++;
    }
    return results;
  }

  // Бесплатный веб-поиск: DuckDuckGo без API-ключа. Пробуем html-версию,
  // при пустом ответе (капча/изменение разметки) — lite-версию.
  async function webSearchDDG(query) {
    const q = encodeURIComponent(String(query || "").trim());
    if (!q) return "Ошибка: пустой поисковый запрос";
    let note = "";
    let results = [];
    const htmlRes = await downloadHtml("https://html.duckduckgo.com/html/?q=" + q);
    if (htmlRes.ok) {
      results = parseDdgHtml(htmlRes.text);
    } else {
      note = htmlRes.error || "";
    }
    if (!results.length) {
      const liteRes = await downloadHtml("https://lite.duckduckgo.com/lite/?q=" + q);
      if (liteRes.ok) results = parseDdgLite(liteRes.text);
      else if (!note) note = liteRes.error || "";
    }
    if (!results.length) {
      return "Поиск не дал результатов по запросу: " + query + (note ? " (" + note + ")" : "") + ". Попробуй переформулировать запрос или используй webFetch по известному адресу.";
    }
    return (
      "Результаты поиска по «" + query + "»:\n\n" +
      results
        .map((r, idx) => (idx + 1) + ". " + (r.title || "—") + "\n   " + r.url + (r.snippet ? "\n   " + r.snippet.slice(0, 300) : ""))
        .join("\n\n") +
      "\n\nЧтобы прочитать страницу целиком, используй инструмент webFetch с её URL."
    );
  }

  // Усиленный поиск: Google через Serper (нужен API-ключ из настроек).
  // POST https://google.serper.dev/search с заголовком X-API-KEY → { organic: [...] }.
  async function webSearchSerper(query, apiKey) {
    const q = String(query || "").trim();
    if (!q) return "Ошибка: пустой поисковый запрос";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "X-API-KEY": String(apiKey || "").trim(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: q, num: 10, gl: "ru", hl: "ru" }),
      });
      if (res.status === 401 || res.status === 403) {
        return "Ошибка поиска: Serper отклонил ключ (HTTP " + res.status + "). Проверь ключ в Настройках → 🔒 Секреты.";
      }
      if (!res.ok) return "Ошибка поиска: HTTP " + res.status;
      const data = await res.json();
      const organic = (data && data.organic) || [];
      if (!organic.length) {
        return "Поиск не дал результатов по запросу: " + query + ". Попробуй переформулировать запрос или используй webFetch по известному адресу.";
      }
      return (
        "Результаты поиска по «" + query + "» (Google):\n\n" +
        organic
          .map((r, idx) => (idx + 1) + ". " + (r.title || "—") + "\n   " + (r.link || "") + (r.snippet ? "\n   " + String(r.snippet).slice(0, 300) : ""))
          .join("\n\n") +
        "\n\nЧтобы прочитать страницу целиком, используй инструмент webFetch с её URL."
      );
    } catch (e) {
      return "Ошибка поиска: " + (e && e.name === "AbortError" ? "таймаут" : (e && e.message) || String(e));
    } finally {
      clearTimeout(timer);
    }
  }
  // Веб-поиск: Serper (Google), если задан API-ключ, иначе — DuckDuckGo.
  async function webSearch(query, apiKey) {
    if (String(apiKey || "").trim()) return await webSearchSerper(query, apiKey);
    return await webSearchDDG(query);
  }

  // Превращает HTML в читаемый текст (убирает скрипты, стили, разметку).
  function htmlToText(html) {
    let s = String(html || "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    s = s.replace(/<(br|p|div|li|h[1-6]|tr|section|article|pre|blockquote|table)[^>]*>/gi, "\n");
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    s = s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&mdash;|&ndash;/g, "—").replace(/&hellip;/g, "…");
    s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return s;
  }

  // Читает веб-страницу по URL и возвращает её текст (для чтения документации целиком).
  async function webFetchPage(url) {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) return "Ошибка: укажи URL вида https://...";
    const res = await downloadHtml(u);
    if (!res.ok) return "Ошибка загрузки страницы: " + res.error;
    let text = htmlToText(res.text);
    if (text.length > 30000) {
      text = text.slice(0, 30000) + "\n… (страница длиннее — показаны первые 30000 символов)";
    }
    if (!text.trim()) {
      return "Страница загружена, но текст не извлёкся (возможно, это JS-приложение или страница-заглушка).";
    }
    return "Содержимое " + u + ":\n\n" + text;
  }

  return {
    stripHtml,
    downloadHtml,
    ddgUrlToHttps,
    parseDdgHtml,
    parseDdgLite,
    webSearchDDG,
    webSearchSerper,
    webSearch,
    htmlToText,
    webFetchPage,
  };
});

"use strict";
// Правила «выкаченная страница действительно работает».
//
// После деплоя HTTP 200 ещё ничего не доказывает: приложение может отдавать
// пустую страницу, падать в консоли или получить 404 на свои же скрипты.
// Здесь лежит только решение — по данным аудита браузера (src/browser-tools.js,
// функция auditPage) сказать «годится», «годится с замечаниями» или «нет».
// Модуль чистый: ни браузера, ни сети — поэтому проверяется тестами напрямую.

// Меньше этого числа символов текста при пустом корне — почти всегда белый экран.
const MIN_TEXT = 20;
const MAX_CONSOLE_SHOWN = 3;
const MAX_REQUESTS_SHOWN = 3;

function fail(reason, warnings) {
  return { ok: false, level: "fail", reason: reason, warnings: warnings || [], metrics: null };
}

// audit: { ok, error, status, navError, info, consoleErrors, pageErrors, failedRequests, url, ms }
function evaluate(audit) {
  if (!audit || !audit.ok) {
    return fail((audit && audit.error) || "проверка страницы не запустилась");
  }
  const status = parseInt(audit.status, 10) || 0;
  const info = audit.info || {};
  const navError = String(audit.navError || "");
  const consoleErrors = audit.consoleErrors || [];
  const pageErrors = audit.pageErrors || [];
  const failedRequests = audit.failedRequests || [];
  const textLen = parseInt(info.textLen, 10) || 0;
  const rootChildren = typeof info.rootChildren === "number" ? info.rootChildren : -1;
  const h1 = info.h1 || [];

  // Сайт не открылся вовсе.
  if (!status && navError) return fail("страница не открылась: " + navError);
  if (!status) return fail("страница не ответила");
  if (status >= 500) return fail("сайт отвечает " + status + " — приложение падает при запуске");
  if (status === 404) return fail("сайт отвечает 404 — в образ не попал index.html или неверный путь");
  if (status === 401 || status === 403) {
    return fail("сайт требует авторизацию (" + status + ") — публичный доступ к контейнеру не настроен");
  }

  const blank = textLen < MIN_TEXT && (rootChildren === 0 || rootChildren === -1) && !h1.length;
  if (blank) {
    return fail("страница открылась, но пустая: ни текста, ни разметки — белый экран");
  }

  const warnings = [];
  if (textLen < MIN_TEXT) warnings.push("на странице почти нет текста (" + textLen + " символов)");
  if (rootChildren === 0) warnings.push("контейнер приложения пуст: в #root нет элементов — скрипты, возможно, не загрузились");
  for (const e of consoleErrors.slice(0, MAX_CONSOLE_SHOWN)) warnings.push("ошибка в консоли: " + String(e).slice(0, 200));
  if (consoleErrors.length > MAX_CONSOLE_SHOWN) {
    warnings.push("и ещё " + (consoleErrors.length - MAX_CONSOLE_SHOWN) + " ошибок консоли");
  }
  for (const e of pageErrors.slice(0, 2)) warnings.push("исключение на странице: " + String(e).slice(0, 200));
  for (const r of failedRequests.slice(0, MAX_REQUESTS_SHOWN)) {
    warnings.push("запрос не прошёл: " + String((r && r.reason) || "ошибка") + " " + String((r && r.url) || ""));
  }
  if (failedRequests.length > MAX_REQUESTS_SHOWN) {
    warnings.push("и ещё " + (failedRequests.length - MAX_REQUESTS_SHOWN) + " запросов не прошли");
  }

  return {
    ok: true,
    level: warnings.length ? "warn" : "ok",
    reason: "",
    warnings,
    metrics: {
      status,
      title: String(info.title || "").slice(0, 120),
      textLen,
      rootChildren,
      h1: h1.slice(0, 2),
      consoleErrors: consoleErrors.length,
      failedRequests: failedRequests.length,
      ms: audit.ms || 0,
      url: audit.url || "",
    },
  };
}

// Строка для истории деплоя и панели: коротко и по делу.
function summarize(result) {
  if (!result) return "";
  if (!result.ok) return "не прошла: " + result.reason;
  const m = result.metrics || {};
  const base = "HTTP " + m.status + ", текста " + m.textLen + " символов" + (m.title ? ", «" + m.title + "»" : "");
  return result.level === "warn" ? base + " — замечаний: " + result.warnings.length : base;
}

module.exports = { evaluate, summarize, MIN_TEXT, MAX_CONSOLE_SHOWN, MAX_REQUESTS_SHOWN };

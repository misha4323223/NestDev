// Обратный прокси для внешних AI-API (NestDev).
//
// Зачем: из России часть провайдеров и роутеров (OpenAI, Anthropic, bynara и др.)
// напрямую недоступна. Приложение ходит не к провайдеру, а сюда, а этот воркер
// пересылает запрос дальше и добавляет CORS.
//
// Как пользоваться: в настройках провайдера в поле «Базовый URL» впиши адрес
// этого воркера, а следом — полный адрес цели, например:
//   https://<имя-приложения>.deno.net/https://router.bynara.id/v1
// Тогда запрос приложения к <эта база>/models уйдёт на
//   https://router.bynara.id/v1/models
//
// Раньше это работало на Deno Deploy Classic (dash.deno.com). Классику отключили
// 20 июля 2026 — старые адреса *.deno.net теперь отвечают «503 SUSPENDED».
// Этот файл рассчитан на новый Deno Deploy (console.deno.com).

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS =
  "authorization, content-type, x-api-key, anthropic-version, " +
  "anthropic-dangerous-direct-browser-access, openai-project, x-goog-api-key";

function cors(existing?: HeadersInit): Headers {
  const h = new Headers(existing);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  h.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  const url = new URL(req.url);
  // Из пути берём всё после первого «/» — это и есть адрес цели.
  // url.pathname === "/https://router.bynara.id/v1/models"
  let target = url.pathname.replace(/^\//, "") + url.search;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Уже раскодировано — оставляем как есть.
  }

  if (!/^https?:\/\//i.test(target)) {
    return new Response(
      "Bad proxy path: после слэша укажи полный адрес цели, например /https://router.bynara.id/v1",
      { status: 400, headers: cors() },
    );
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response("Bad proxy target: не удалось разобрать адрес цели", {
      status: 400,
      headers: cors(),
    });
  }

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");

  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
  const body = hasBody ? await req.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      redirect: "follow",
    });
    const out = cors(upstream.headers);
    out.set("X-Proxied-Url", targetUrl.href);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  } catch (e) {
    const why = (e && (e as Error).message) || String(e);
    return new Response("Proxy error: " + why, { status: 502, headers: cors() });
  }
});

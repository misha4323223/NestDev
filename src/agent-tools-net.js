"use strict";

/* ─── Инструменты сети и проверки доступности ─────────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 6a). Здесь живут семь обработчиков,
   которые смотрят НАРУЖУ:

     • checkUrl — отвечает ли адрес и с каким кодом (сначала адрес проверяет
       src/net-guard.js: link-local и облачные метаданные запрещены);
     • checkPort / listPorts — кто слушает порт и что вообще слушают на машине;
     • webSearch / webFetch — поиск в интернете и чтение страницы текстом;
     • apiRequest — запрос к внешнему API (тело, заголовки, метод, время);
     • downloadAndExtract — скачать архив и распаковать в папку проекта.

   Все помощники приходят в `deps` (net-guard, webSearchPage, webFetchPage,
   downloadAndExtractTo): модуль сам ничего не достаёт и состояния не держит.
   Тела перенесены ПОБАЙТОВО, порядок инструментов в реестре сохранён ссылками. */

function createNetTools(deps) {
  const {
    path,
    os,
    net,
    resolvePath,
    agentWorkDir,
    runTerminalCommand,
    checkUrlStatus,
    downloadAndExtractTo,
    webSearch,
    webFetchPage,
    truncateText,
  } = deps;

  return {
    "checkUrl": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL, начинающийся с http:// или https:// (например http://localhost:3000)";
        return await checkUrlStatus(url);
    },
    "checkPort": async (args, settings) => {
        const port = parseInt(args.port, 10);
        if (!port || port < 1 || port > 65535) return "Ошибка: укажи корректный порт (1–65535)";
        return await new Promise((resolve) => {
          const sock = net.connect({ port, host: "127.0.0.1" });
          sock.setTimeout(2000);
          sock.once("connect", () => { sock.destroy(); resolve("Порт " + port + " занят — на нём что-то слушает."); });
          sock.once("timeout", () => { sock.destroy(); resolve("Порт " + port + " свободен."); });
          sock.once("error", () => { sock.destroy(); resolve("Порт " + port + " свободен (соединение отклонено)."); });
        });
    },
    "listPorts": async (args, settings) => {
        const cmd = process.platform === "win32"
          ? "netstat -ano -p tcp"
          : "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null";
        const out = await runTerminalCommand(cmd, os.homedir(), 15000);
        const lines = String(out)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /LISTEN|LISTENING/i.test(l))
          .slice(0, 40);
        return "Слушающие порты:\n" + (lines.join("\n") || "не удалось получить список портов:\n" + String(out).slice(0, 1000));
    },
    "webSearch": async (args, settings) => {
        const q = String(args.query || args.q || "").trim();
        // Serper (Google), если ключ задан в настройках; иначе — DuckDuckGo
        return await webSearch(q, settings && settings.serperApiKey);
    },
    "webFetch": async (args, settings) => {
        return await webFetchPage(args.url);
    },
    "downloadAndExtract": async (args, settings) => {
        const dest = args.path ? resolvePath(args.path, settings) : path.join(agentWorkDir(settings), "downloads");
        return await downloadAndExtractTo(args.url, dest);
    },
    "apiRequest": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL (http/https)";
        const method = String(args.method || "GET").toUpperCase();
        const headers = args.headers && typeof args.headers === "object" ? { ...args.headers } : {};
        let body = args.body;
        if (body && typeof body === "object") {
          body = JSON.stringify(body);
          if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
          const res = await fetch(url, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : String(body),
            signal: ctrl.signal,
            redirect: "follow",
          });
          const text = await res.text();
          const ct = res.headers.get("content-type") || "";
          const isText = /text|json|xml|javascript|html|urlencoded/i.test(ct) || text.length === 0;
          const shown = isText
            ? truncateText(text, 6000)
            : "(" + text.length + " байт, тип " + (ct || "неизвестен") + " — бинарное тело не показываю)";
          return "HTTP " + res.status + " " + res.statusText + " — " + method + " " + url + "\n" +
            "Content-Type: " + (ct || "—") + "\n" +
            "Объём тела: " + Buffer.byteLength(text, "utf8") + " байт\n\n" + shown;
        } catch (e) {
          return "Ошибка " + method + " " + url + ": " + ((e && e.name === "AbortError") ? "таймаут (30 с)" : (e && e.message) || String(e));
        } finally {
          clearTimeout(timer);
        }
    },
  };
}

module.exports = { createNetTools };

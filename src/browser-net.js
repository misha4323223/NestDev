"use strict";

/* ─── Сеть вкладки и ожидание покоя браузера агента ───────────────────────────
   Вынесено из browser-tools.js (часть 39). Здесь кольцевой журнал запросов
   вкладки (netRecorder), инструмент browserNetwork (что страница отправила и что
   вернул сервер) и browserWaitForIdle (ждём, пока DOM успокоится и сеть опустеет).

   Зависимости: maskForm — из browser-replay.js; idle*InPage — из
   browser-inpage.js. Две вещи приходят мостом из browser-tools.js: needTab (вкладка
   сессии) и sleep (общий помощник, он живёт в ядре). Состояние браузера модуль за
   собой не тянет.
*/

const { maskForm } = require("./browser-replay.js");
const { idleStartInPage, idleTakeInPage, idleStopInPage } = require("./browser-inpage.js");

// Живое состояние и общий помощник — только мостом (см. шапку).
let needTab = () => ({ error: "browser-net: needTab не подключён" });
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setBrowserNetDeps(d) {
  if (d && typeof d.needTab === "function") needTab = d.needTab;
  if (d && typeof d.sleep === "function") sleep = d.sleep;
  return true;
}

const NET_MAX = 200; // кольцевой буфер запросов на вкладку
// Тело POST держим целиком: бандл batch.call/execute у ВК бывает в десятки КБ,
// а обрезанное тело — это повтор не того запроса (сервер отвечает invalid v).
const NET_POST_MAX = 100000;
const NET_STATIC = { image: 1, font: 1, stylesheet: 1, media: 1, script: 1, other: 1 };

// Записываем сеть вкладки с первого же вызова инструмента: спрашивать «что
// ответил сервер» агент будет ПОСЛЕ действия, задним числом.
const netRecorders = new WeakMap();
function netRecorder(page) {
  const cached = netRecorders.get(page);
  if (cached) return cached;
  const rec = { entries: [], bodies: true };
  netRecorders.set(page, rec);
  const push = (e) => {
    rec.entries.push(e);
    if (rec.entries.length > NET_MAX) rec.entries.shift();
  };
  try {
    page.on("request", (req) => {
      try {
        // Тело POST-формы храним целиком: по нему browserReplay повторяет ТОТ ЖЕ
        // запрос клиента — с его версией API (v) и токеном сессии, которые
        // угадывать нельзя (чужая версия даёт ошибку 100 invalid v).
        let post = "";
        try { post = req.postData ? String(req.postData() || "") : ""; } catch (e) {}
        push({
          method: req.method ? req.method() : "GET",
          url: String(req.url ? req.url() : ""),
          type: req.resourceType ? String(req.resourceType()) : "",
          post: post.slice(0, NET_POST_MAX),
          ts: Date.now(),
        });
      } catch (e) {}
    });
    page.on("response", (res) => {
      try {
        const req = res.request();
        const url = String(req.url());
        const method = req.method ? req.method() : "GET";
        const status = res.status ? res.status() : 0;
        let mime = "";
        try { mime = String(((res.headers && res.headers()) || {})["content-type"] || ""); } catch (e) {}
        let e = null;
        for (let i = rec.entries.length - 1; i >= 0; i--) {
          const x = rec.entries[i];
          if (x.url === url && x.method === method && x.status == null) { e = x; break; }
        }
        if (e) { e.status = status; e.mime = mime; }
        else { e = { method: method, url: url, status: status, mime: mime, ts: Date.now() }; push(e); }
        if (rec.bodies && /json|text|xml|graphql/.test(mime) && !/event-stream/.test(mime)) {
          Promise.resolve(res.text()).then((txt) => {
            if (e && txt) e.body = String(txt).slice(0, 4000);
          }).catch(() => {});
        }
      } catch (e) {}
    });
  } catch (e) {}
  return rec;
}

// browserNetwork: что страница реально отправила и что вернул сервер.
async function network(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const rec = netRecorder(t.tab.page);
  if (args.bodies === false) rec.bodies = false;
  const all = rec.entries.slice();
  if (args.clear === true && args.since !== true) {
    rec.entries.length = 0;
    return "OK — сетевой журнал очищен (было " + all.length + " запросов).";
  }
  // По умолчанию отдаём НОВОЕ и очищаем буфер: агент спрашивает сразу после действия.
  const list = args.since === false ? all : all;
  if (args.since !== false) rec.entries.length = 0;
  const filter = String(args.filter || args.q || "").trim().toLowerCase();
  const rows = [];
  for (const e of list) {
    if (!args.all && NET_STATIC[e.type]) continue;
    if (filter && e.url.toLowerCase().indexOf(filter) < 0) continue;
    rows.push(e);
  }
  if (!rows.length) {
    return (
      "browserNetwork: новых запросов нет" + (list.length ? " (в журнале " + list.length + ", отсеял статику и фильтр)" : "") +
      ". Если действие должно было обратиться к серверу — возможно, оно не сработало: проверь browserSnapshot/browserText."
    );
  }
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 60);
  const shown = rows.slice(-limit);
  const bad = shown.filter((e) => e.status >= 400 || e.status === 0).length;
  const out = [
    "browserNetwork: запросов " + rows.length + (bad ? ", с ошибкой: " + bad : "") + (rows.length > shown.length ? " (показаны последние " + shown.length + ")" : ""),
  ];
  shown.forEach((e, i) => {
    const st = e.status == null ? "…" : e.status;
    const mime = String(e.mime || "").split(";")[0].slice(0, 24);
    out.push(i + 1 + ". " + e.method + " " + e.url.slice(0, 160) + " → " + st + (mime ? " (" + mime + ")" : "") + (e.status >= 400 || e.status == null ? " ❌" : ""));
    if (e.post) out.push("   ⤴ отправил: " + maskForm(e.post).slice(0, 400));
    if (e.post) out.push("      повторить с пагинацией: browserReplay { match: \"" + e.url.slice(0, 50) + "\" }");
    if (e.body) {
      const body = String(e.body).replace(/\s+/g, " ").trim().slice(0, 300);
      out.push("   → " + body);
    }
  });
  if (bad) out.push("Дальше: 4xx/5xx — прочитай тело ответа выше (там обычно причина) или browserEval, чтобы увидеть ошибку в JS-консоли страницы.");
  return out.join("\n");
}

// waitForIdle: дождаться, когда страница «успокоится» (DOM не меняется, сеть пуста) —
// чтобы клик не улетел в элемент, который Angular уже перерисовал.
async function waitForIdle(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const page = t.tab.page;
  const quietMs = Math.min(Math.max(parseInt(args.quietMs, 10) || 500, 100), 5000);
  const timeout = Math.min(Math.max(parseInt(args.timeout, 10) || 8000, 500), 60000);
  await page.evaluate(idleStartInPage).catch(() => null);
  let inflight = 0;
  const onReq = () => { inflight++; };
  const onDone = () => { if (inflight > 0) inflight--; };
  const canListen = typeof page.on === "function";
  if (canListen) {
    try {
      page.on("request", onReq);
      page.on("requestfinished", onDone);
      page.on("requestfailed", onDone);
    } catch (e) {}
  }
  const started = Date.now();
  let mutSeen = 0;
  let quietSince = Date.now();
  while (Date.now() - started < timeout) {
    const mut = await page.evaluate(idleTakeInPage).catch(() => 0);
    mutSeen += Number(mut) || 0;
    if ((Number(mut) || 0) > 0 || inflight > 0) quietSince = Date.now();
    if (Date.now() - quietSince >= quietMs) break;
    await sleep(150);
  }
  if (canListen && typeof page.off === "function") {
    try {
      page.off("request", onReq);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    } catch (e) {}
  }
  await page.evaluate(idleStopInPage).catch(() => null);
  const waited = Date.now() - started;
  const stillBusy = inflight > 0;
  return (
    "OK — страница " + (stillBusy ? "всё ещё грузит (" + inflight + " запросов)" : "успокоилась") +
    ": ждал " + waited + " мс, изменений DOM " + mutSeen + ", запросов в полёте " + inflight + "." +
    (stillBusy ? "\nДействуй по тому, что уже видно (browserSnapshot) — или повтори waitForIdle с большим timeout." : "\nТеперь карта (browserSnapshot) не поедет — можно кликать по ref.")
  );
}

module.exports = {
  setBrowserNetDeps,
  NET_MAX,
  NET_POST_MAX,
  NET_STATIC,
  netRecorder,
  network,
  waitForIdle,
};

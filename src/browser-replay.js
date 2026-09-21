"use strict";

/* ─── Replay: повторить запрос самой страницы и пролистать ответ курсором ─────
   Вынесено из browser-tools.js (часть 39). Здесь работа с формами (разбор,
   сборка, маскировка секретов) и сам browserReplay со спутниками (разбор пути к
   элементам, курсору и ключам строк). Зависимости: fetchJsonInPage — из
   browser-inpage.js (исполняется в странице), fs/os/path — из Node.

   Две функции СЕССИИ (needTab, netRecorder) приходят мостом из browser-tools.js,
   чтобы этот модуль не тянул за собой состояние браузера. До подключения они
   отвечают честной ошибкой, а не молчат.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchJsonInPage } = require("./browser-inpage.js");

// Живое состояние — только мостом (см. шапку).
let needTab = () => ({ error: "browser-replay: needTab не подключён" });
let netRecorder = () => ({ entries: [] });
function setBrowserReplayDeps(d) {
  if (d && typeof d.needTab === "function") needTab = d.needTab;
  if (d && typeof d.netRecorder === "function") netRecorder = d.netRecorder;
  return true;
}

// ── Replay: повторить запрос самой страницы и пролистать ответ курсором ──────
// Зачем: виртуальные списки (диалоги ВК, таблицы, ленты) нельзя надёжно прочитать
// из DOM — узлы переиспользуются, часть строк вообще не отрисована, а ref из карты
// устаревают после любой перерисовки. Зато страница УЖЕ ходит за этими данными
// запросом к серверу. Мы повторяем ТОТ ЖЕ запрос (его адрес, его версию API, его
// токен) ИЗ САМОЙ страницы: куки и CORS такие же, как у клиента, — и листаем ответ
// курсором, пока сервер отдаёт новое.
//
// Замер на живом ВК (15.09): POST api.vk.ru/method/messages.getItems?v=5.285,
// поля v, client_id, start_from=conversations_<id>, target_count, access_token —
// в теле (form-encoded); курсор — в ответе; конец — пустой items[]. Версия 5.285 —
// внутренняя версия клиента: свои версии сервер отвергает ошибкой 100 invalid v,
// поэтому v и токен берутся из перехвата, а не подставляются руками.

// Токен и пароли нужны инструменту, но не тексту ответа: в чат они не попадают.
const SECRET_KEY_RE = /token|password|passwd|secret|api[_-]?key|auth|session|sid|hash/i;
function maskForm(body) {
  return String(body || "").replace(/([^&=]+)=([^&]*)/g, function (m, k, v) {
    let key = k;
    try { key = decodeURIComponent(k); } catch (e) {}
    if (!SECRET_KEY_RE.test(key)) return m;
    return k + "=«скрыто, " + String(v || "").length + " симв.»";
  });
}

// Тело формы → пары [ключ, значение, исходный кусок]. Исходный кусок храним,
// чтобы НЕ тронутые поля уходили на сервер байт в байт (плюсы в токенах и base64
// слепая пересборка портит).
function parseForm(body) {
  const out = [];
  const parts = String(body || "").split("&");
  for (const part of parts) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? "" : part.slice(i + 1);
    let dk = k;
    let dv = v;
    try { dk = decodeURIComponent(k); } catch (e) {}
    try { dv = decodeURIComponent(v); } catch (e) {}
    out.push([dk, dv, part]);
  }
  return out;
}
function buildForm(pairs) {
  return (pairs || [])
    .map(function (p) {
      if (p.length > 2 && typeof p[2] === "string") {
        const eq = p[2].indexOf("=");
        let back = "";
        try { back = eq < 0 ? "" : decodeURIComponent(p[2].slice(eq + 1)); } catch (e) { back = ""; }
        if (back === String(p[1])) return p[2]; // поле не меняли — шлём как было
      }
      return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]);
    })
    .join("&");
}

// Путь по ответу: response.conversations.items или a.b.0.c
function pickPath(obj, spec) {
  if (spec == null || spec === "") return undefined;
  let cur = obj;
  const parts = String(spec).split(".");
  for (const part of parts) {
    if (cur == null) return undefined;
    if (/^\d+$/.test(part)) { cur = cur[Number(part)]; continue; }
    cur = cur[part];
  }
  return cur;
}

// Где в ответе массив элементов: сначала частые имена, потом первый массив
// объектов на глубине до 4 — работает и на незнакомом API.
function findItemsPath(json) {
  const known = [
    "response.items", "response.conversations.items", "response.messages.items",
    "response.list", "response.results", "response.rows", "response.data",
    "items", "results", "data", "list", "rows",
  ];
  for (const p of known) if (Array.isArray(pickPath(json, p))) return p;
  const queue = [[json, ""]];
  let seen = 0;
  while (queue.length && seen < 80) {
    const cur = queue.shift();
    seen++;
    const node = cur[0];
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === "object") return cur[1].replace(/^\./, "");
      continue;
    }
    if (!node || typeof node !== "object") continue;
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (child == null || typeof child !== "object") continue;
      queue.push([child, cur[1] + "." + k]);
    }
  }
  return "";
}
function findTotalPath(json) {
  const known = [
    "response.count", "response.total_count", "response.total",
    "response.conversations.count", "total_count", "total", "count",
  ];
  for (const p of known) {
    const v = pickPath(json, p);
    if (typeof v === "number" && v > 0) return p;
  }
  return "";
}
function findCursorPath(json) {
  const known = [
    "response.last_item", "response.next_from", "response.next_cursor", "response.cursor",
    "last_item", "next_from", "next_cursor", "cursor",
  ];
  for (const p of known) {
    const v = pickPath(json, p);
    if (v != null && v !== "" && typeof v !== "object") return p;
  }
  const resp = pickPath(json, "response");
  if (resp && typeof resp === "object") {
    for (const k of Object.keys(resp)) {
      const v = resp[k];
      if (v == null || v === "" || typeof v === "object") continue;
      if (/from|offset|cursor|next/i.test(k)) return "response." + k;
    }
  }
  return "";
}
function findCursorParam(pairs) {
  const known = ["start_from", "offset", "from", "cursor", "next_from", "page"];
  for (const name of known) for (const p of pairs || []) if (p[0] === name) return name;
  return "";
}

// Уникальный ключ строки: явный путь, затем обычные имена, в конце — сам JSON.
function keyOfItem(item, keyPath) {
  if (keyPath) {
    const v = pickPath(item, keyPath);
    if (v != null && typeof v !== "object") return String(v);
    if (v != null) return JSON.stringify(v);
  }
  const known = ["peer_id", "id", "conversation.peer.id", "conversation.peer_id", "uid", "key", "message_id", "conversation_id"];
  for (const p of known) {
    const v = pickPath(item, p);
    if (v != null && typeof v !== "object") return String(v);
  }
  try { return JSON.stringify(item).slice(0, 200); } catch (e) { return String(item); }
}

// Образец для повтора: последний подходящий запрос страницы (xhr/fetch).
// Совпадение ищем И В ТЕЛЕ, а не только в адресе: ВК шлёт методы бандлом
// (POST api.vk.ru/method/batch.call, а «messages.getItems» лежит внутри тела),
// и по адресу такой метод не находится — replay брал чужой запрос (поллинг) со
// старой версией API и получал ошибку про неверный v.
function replayFindSample(rec, args) {
  const match = String(args.match || args.filter || "").toLowerCase();
  const wantGet = String(args.method || "").toUpperCase() === "GET";
  const afterTs = Number(args.afterTs) || 0;
  const list = (rec && rec.entries) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const method = String(e.method || "").toUpperCase();
    if (!wantGet && method !== "POST") continue;
    if (String(e.url || "").indexOf("http") !== 0) continue;
    // Отбрасываем только заведомо не-API запросы (картинки, стили, скрипты).
    // Раньше принимались лишь xhr/fetch, и запрос с типом «other» не находился.
    const type = String(e.type || "");
    if (type === "image" || type === "font" || type === "stylesheet" || type === "media" || type === "script" || type === "document") continue;
    if (afterTs && Number(e.ts || 0) <= afterTs) continue;
    if (match && (String(e.url || "").toLowerCase() + "\n" + String(e.post || "").toLowerCase()).indexOf(match) < 0) continue;
    if (!e.post) continue;
    return e;
  }
  return null;
}

// browserReplay: собрать данные тем же запросом, что делает сам сайт.
async function replay(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const page = t.tab.page;
  const rec = netRecorder(page);
  let url = String(args.url || "").trim();
  let method = String(args.method || "").toUpperCase();
  let body = String(args.body != null ? args.body : "");
  let from = "указан вручную";
  let sampleTs = 0;
  if (!url || !body) {
    const sample = replayFindSample(rec, args);
    if (sample) {
      if (!url) url = String(sample.url || "");
      if (!method) method = String(sample.method || "POST").toUpperCase();
      if (!body) body = String(sample.post || "");
      sampleTs = Number(sample.ts) || 0;
      from = "из перехвата сети (страница сама отправила такой запрос)";
      // Совпадение в теле — это бандл (batch.call/execute), а не адрес: говорим
      // прямо, иначе непонятно, откуда взялся повторяемый запрос.
      const mLow = String(args.match || args.filter || "").toLowerCase();
      if (mLow && String(sample.url || "").toLowerCase().indexOf(mLow) < 0) {
        from += ", совпадение найдено в ТЕЛЕ запроса (метод внутри бандла batch/execute)";
      }
    }
  }
  if (!url) {
    return (
      "Ошибка browserReplay: нечего повторять. Либо укажи url и body, либо открой страницу, где сайт САМ делает этот " +
      "запрос, дёрни нужный элемент и повтори — накопленное покажет browserNetwork { since: false }."
    );
  }
  if (!method) method = body ? "POST" : "GET";
  const headers = Object.assign(
    { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    args.headers && typeof args.headers === "object" ? args.headers : {}
  );
  const maxSteps = Math.max(1, Math.min(parseInt(args.maxSteps, 10) || 20, 60));
  const pairs = parseForm(body);
  if ((method === "GET" || method === "HEAD") && url.indexOf("?") >= 0) {
    const qi = url.indexOf("?");
    for (const p of parseForm(url.slice(qi + 1))) pairs.push(p);
    url = url.slice(0, qi);
  }
  const setPair = function (name, value) {
    for (const p of pairs) {
      if (p[0] === name) {
        p[1] = String(value);
        p.length = 2; // значение изменили — исходный кусок больше не годится
        return;
      }
    }
    pairs.push([String(name), String(value)]);
  };
  if (args.set && typeof args.set === "object") for (const k of Object.keys(args.set)) setPair(k, args.set[k]);
  if (Array.isArray(args.remove)) {
    const drop = args.remove.map(String);
    for (let i = pairs.length - 1; i >= 0; i--) if (drop.indexOf(pairs[i][0]) >= 0) pairs.splice(i, 1);
  }
  let cursorParam = String(args.cursorParam || args.cursorParamName || args.cursor || "").trim();
  if (!cursorParam) cursorParam = findCursorParam(pairs);
  // Свежий перехват: сервер отверг образец (истёк токен сессии, сменилась версия
  // клиента) — берём тот же запрос, который страница отправила ПОЗЖЕ, и один раз
  // повторяем, а не заставляем человека догадываться о причине отказа.
  const refreshSample = () => {
    if (args.url) return false;
    const fresh = replayFindSample(rec, Object.assign({}, args, { afterTs: sampleTs }));
    if (!fresh || String(fresh.post || "") === body) return false;
    sampleTs = Number(fresh.ts) || 0;
    url = String(fresh.url || url);
    method = String(fresh.method || "POST").toUpperCase();
    body = String(fresh.post || "");
    const next = parseForm(body);
    pairs.length = 0;
    for (const p of next) pairs.push(p);
    if (cursorParam) setPair(cursorParam, cursor);
    return true;
  };
  let refreshed = false;

  let cursorPath = String(args.cursorPath || "").trim();
  let itemsPath = String(args.itemsPath || "").trim();
  let totalPath = String(args.totalPath || "").trim();
  let cursor = args.start != null ? String(args.start) : "";
  if (cursor && cursorParam) setPair(cursorParam, cursor);
  if (!cursor && cursorParam) {
    // Курсор уже был в перехваченном теле — берём его текущим: тогда сервер,
    // отдающий тот же курсор, сразу распознаётся как «дальше пусто».
    for (const p of pairs) {
      if (p[0] === cursorParam && p[1]) { cursor = String(p[1]); break; }
    }
  }

  const items = [];
  const seen = {};
  let steps = 0;
  let dupes = 0;
  let total = 0;
  let stop = "";
  for (let step = 0; step < maxSteps; step++) {
    const res = await page.evaluate(fetchJsonInPage, {
      url: url, method: method, body: buildForm(pairs), headers: headers,
    });
    steps++;
    if (!res || res.error) { stop = "запрос не прошёл — " + ((res && res.error) || "нет ответа"); break; }
    if (!res.json) { stop = "ответ не JSON (статус " + res.status + "): " + String(res.text || "").slice(0, 300); break; }
    const j = res.json;
    if (j && j.error) {
      if (!refreshed && step === 0 && refreshSample()) {
        refreshed = true;
        from = "из СВЕЖЕГО перехвата (сервер отверг прежний образец — страница успела отправить запрос заново)";
        step--;
        continue;
      }
      stop = "сервер вернул ошибку: " + JSON.stringify(j.error).slice(0, 300);
      break;
    }
    if (!itemsPath) itemsPath = findItemsPath(j);
    if (!totalPath) totalPath = findTotalPath(j);
    if (!cursorPath) cursorPath = findCursorPath(j);
    const arr = itemsPath ? pickPath(j, itemsPath) : null;
    const list = Array.isArray(arr) ? arr : [];
    const tot = totalPath ? Number(pickPath(j, totalPath)) : 0;
    if (tot > total) total = tot;
    let fresh = 0;
    for (const it of list) {
      const k = keyOfItem(it, String(args.key || ""));
      if (seen[k]) { dupes++; continue; }
      seen[k] = 1;
      items.push(it);
      fresh++;
    }
    if (!list.length) { stop = "сервер отдал пустой список — это конец"; break; }
    if (total && items.length >= total) { stop = "собрано всё: " + items.length + " из " + total; break; }
    if (!fresh) { stop = "новых строк нет (сервер повторяет те же) — дальше пусто"; break; }
    if (!cursorPath) { stop = "в ответе нет курсора — сервер отдаёт всё сразу"; break; }
    const next = pickPath(j, cursorPath);
    const nextCursor = next == null || next === "" ? "" : String(next);
    if (!nextCursor) { stop = "курсор пустой — это конец"; break; }
    // Сравниваем в том же виде, в каком отправляем: с префиксом. Иначе сервер,
    // отдающий один и тот же курсор, заставлял бы листать до потолка шагов.
    const composed = String(args.cursorPrefix != null ? args.cursorPrefix : "") + nextCursor;
    if (composed === cursor) { stop = "курсор не двигается — это конец"; break; }
    cursor = composed;
    setPair(cursorParam, cursor);
  }
  if (!stop) stop = "упёрся в предел " + maxSteps + " шагов — вызови ещё раз";

  // Данные — В ФАЙЛ: 100+ диалогов в чат не влезут, а файл агент читает сам и он
  // переживает перезагрузку вкладки (в отличие от window.__var).
  let file = "";
  const inlineJson = JSON.stringify(items);
  if (args.save !== false) {
    try {
      const dir = String(args.dir || path.join(os.tmpdir(), "ai-agent-replay"));
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, "replay-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            source: url, method: method, steps: steps, total: total, stop: stop,
            itemsPath: itemsPath, cursorPath: cursorPath, count: items.length, items: items,
          },
          null, 1
        ),
        "utf8"
      );
    } catch (e) { file = ""; }
  }
  let out =
    "OK — собрано " + items.length + " " + (items.length === 1 ? "строка" : "строк") +
    " за " + steps + " " + (steps === 1 ? "запрос" : "запросов") +
    (total ? " (всего на сервере: " + total + ")" : "") + ". Стоп: " + stop + "." +
    "\nИсточник: " + from + "\n" + method + " " + url.slice(0, 160) +
    "\nТело (секреты скрыты): " + maskForm(buildForm(pairs)).slice(0, 300);
  if (dupes) out += "\nПовторов отброшено: " + dupes + ".";
  if (itemsPath) out += "\nЭлементы взяты из " + itemsPath + (cursorPath ? ", курсор: " + cursorPath : "");
  if (file) {
    out += "\nФайл: " + file + " — полный JSON (items[]): читай через readFile или разбирай своим кодом.";
  } else if (args.save === false) {
    out += "\nitems: " + inlineJson.slice(0, 3000) +
      (inlineJson.length > 3000 ? " … [обрезано — добавь save: true и получишь файл]" : "");
  }
  const pick = Array.isArray(args.pick) ? args.pick.map(String) : [];
  if (pick.length && items.length) {
    const rows = Math.max(1, Math.min(parseInt(args.rows, 10) || 20, 60));
    out += "\n\nСтроки:";
    for (let i = 0; i < items.length && i < rows; i++) {
      const vals = pick.map(function (p) {
        const v = pickPath(items[i], p);
        return v == null || typeof v === "object" ? "" : String(v).replace(/\s+/g, " ").slice(0, 120);
      });
      out += "\n" + (i + 1) + ". " + vals.filter(function (x) { return x !== ""; }).join(" · ");
    }
    if (items.length > rows) out += "\n… ещё " + (items.length - rows) + " в файле";
  } else if (items.length) {
    out += "\n\nПервая строка (её поля потом можно выбрать через pick):\n" + JSON.stringify(items[0]).slice(0, 600);
  }
  if (/не прошёл|не JSON|сервер вернул ошибку/.test(stop)) {
    out += (
      "\nЕсли сервер отверг версию API или запрос — не подставляй v сам: вернись на страницу, дай клиенту " +
      "сделать запрос ещё раз и повтори browserReplay (он возьмёт свежий перехват)."
    );
  }
  return out;
}

module.exports = {
  setBrowserReplayDeps,
  maskForm,
  parseForm,
  buildForm,
  pickPath,
  findItemsPath,
  findTotalPath,
  findCursorPath,
  findCursorParam,
  keyOfItem,
  replayFindSample,
  replay,
};

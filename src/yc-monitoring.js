"use strict";

/* ─── Monitoring: данные метрик и их метаданные ──────────────────────────────
   Чистый Node-модуль (fetch + таймеры), как остальные облачные модули (yc-*.js):
   тел запросов в оболочке main.js не появляется, а сам модуль проверяется в
   plain-node.

   Публичный справочник API у Monitoring короткий — в нём ВСЕГО ДВА ресурса:
     MetricsData (данные)  POST /monitoring/v2/data/read?folderId=…
     MetricsMeta (метаданные) GET /monitoring/v2/metrics?folderId=…
   Это важно знать заранее: отдельного публичного REST для АЛЕРТОВ у облака нет
   (алерты настраиваются в консоли), поэтому «следить за порогом» из приложения
   пока нельзя — а вот читать метрики и понимать, что вообще измеряется, можно, и
   именно это здесь сделано. Обещать больше — значит показывать кнопку, за которой
   ничего нет.

   Единица языка запросов Monitoring: `имя{метка="значение", …}`. Метки у метрик
   облака одинаковые для всех сервисов: `service` (сервис) и `resource_id`
   (идентификатор ресурса) — поэтому сборка запроса и селектора живёт здесь одним
   местом, а не повторяется в инструменте и в панели.

   Прореживание — обязательная часть запроса данных: без него облако отдаёт
   СЫРЫЕ точки, и за сутки их бывают десятки тысяч. Поэтому в теле всегда есть
   `downsampling`: `maxPoints` (сколько точек оставить), `gridAggregation`
   (чем сводить: AVG/MAX/MIN/SUM/LAST/COUNT) и `gapFilling` (что делать с
   пропусками: NULL/NONE/PREVIOUS). Функции и заполнение сверены со справочником
   API, а не взяты по памяти. */

// Функции прореживания и заполнения пропусков — те, что принимает облако.
const AGGREGATIONS = ["AVG", "MAX", "MIN", "SUM", "LAST", "COUNT"];
const GAP_FILLING = ["NULL", "NONE", "PREVIOUS"];

// Типы метрик: нужны и для ответа человеку, и для разбора значений (у IGAUGE
// значения лежат в int64Values, у остальных — в doubleValues).
const TYPES = {
  DGAUGE: "дробный показатель",
  IGAUGE: "целый показатель",
  COUNTER: "счётчик",
  RATE: "производная",
};

// ── Текст: цифры без подписи бесполезны ────────────────────────────────────
// Форматирование живёт в модуле, а не в панели и не в инструменте: одним и тем же
// текстом отвечает и агент, и окно — разойтись они уже не могут.
function formatValue(v, type) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (type === "COUNTER" || type === "IGAUGE") return String(Math.round(n));
  if (Math.abs(n) >= 1000) return String(Math.round(n));
  if (Math.abs(n) >= 1) return String(Math.round(n * 100) / 100);
  return String(Math.round(n * 10000) / 10000);
}

function linesMetrics(rows, opts) {
  const o = opts || {};
  const out = [];
  for (const r of rows) {
    if (r.error) {
      out.push("⚠ " + r.query + ": " + r.error);
      continue;
    }
    if (r.empty || !r.summary || !r.summary.count) {
      out.push("• " + r.query + " — данных за " + o.minutes + " мин нет (ресурс мог быть остановлен или запрос не тот)");
      continue;
    }
    const s = r.summary;
    out.push(
      "• " + (r.name || r.query) + " (" + (TYPES[r.type] || r.type || "тип неизвестен") + "):" +
      " в среднем " + formatValue(s.avg, r.type) +
      ", максимум " + formatValue(s.max, r.type) +
      ", последнее " + formatValue(s.last, r.type) +
      " (точек: " + s.count + ")"
    );
  }
  return out;
}

function linesNames(res) {
  return ((res && res.names) || []).slice(0, 40).map(
    (n) => "• " + n.name + " — " + (TYPES[n.type] || n.type || "?") + ", рядов: " + n.series + (n.labels && n.labels.length ? " (метки: " + n.labels.join(", ") + ")" : "")
  );
}

function createYcMonitoring(deps) {
  const { fetchJson, endpoint, getIamToken, serviceError, isNetworkError } = deps || {};

  async function baseOf() {
    const b = await endpoint("monitoring");
    if (!b) throw new Error("Облако не отдало адрес сервиса Monitoring — проверь подключение к интернету.");
    return b || "https://monitoring.api.cloud.yandex.net";
  }

  const one = (v) => String(v == null ? "" : v).trim();
  const list = (v) =>
    Array.isArray(v)
      ? v.map((x) => String(x == null ? "" : x)).filter((s) => s.trim())
      : one(v)
        ? [one(v)]
        : [];

  // Строка метки для языка запросов: `service="compute"`. Кавычки и обратные
  // слэши экранируются — иначе имя ресурса с кавычкой «уезжает» в другой запрос.
  function labelPair(key, value) {
    const q = String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return key + '="' + q + '"';
  }

  // Селектор меток для поиска метаданных (без имени метрики).
  function selectorFor(labels) {
    const parts = [];
    if (labels && typeof labels === "object") {
      for (const k of Object.keys(labels)) {
        if (labels[k] === undefined || labels[k] === null || labels[k] === "") continue;
        parts.push(labelPair(k, labels[k]));
      }
    }
    return parts.join(", ");
  }

  // Запрос данных: `имя{метки}`. Имя обязательно — без него облако не поймёт, что
  // читать; метки необязательны (метрика без меток вернётся целиком).
  function queryFor(metric, labels) {
    const name = one(metric);
    if (!name) throw new Error("Пустое имя метрики: нужен metric (например cpu_usage).");
    const sel = typeof labels === "string" ? one(labels) : selectorFor(labels);
    return name + "{" + sel + "}";
  }

  // Сводка по ряду значений: пустые точки (gapFilling NULL) в расчёт не идут,
  // иначе среднее считалось бы вместе с пропусками и врало.
  function summarize(timeseries) {
    const ts = timeseries || {};
    const raw = Array.isArray(ts.doubleValues) ? ts.doubleValues : Array.isArray(ts.int64Values) ? ts.int64Values : [];
    const marks = Array.isArray(ts.timestamps) ? ts.timestamps : [];
    const nums = [];
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (!isFinite(n)) continue;
      nums.push({ v: n, ts: marks[i] });
    }
    if (!nums.length) return { count: 0 };
    let min = nums[0].v;
    let max = nums[0].v;
    let sum = 0;
    for (const p of nums) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
      sum += p.v;
    }
    const last = nums[nums.length - 1];
    return {
      count: nums.length,
      min: min,
      max: max,
      avg: sum / nums.length,
      last: last.v,
      lastTs: last.ts,
      firstTs: nums[0].ts,
      skipped: raw.length - nums.length,
    };
  }

  // Данные метрик. Один запрос — один `query`; список запросов делается пачкой,
  // как у перевода: ждать по одному — это N раз по таймауту.
  async function readMetrics(oauthToken, opts) {
    const o = opts || {};
    const folderId = one(o.folderId);
    if (!folderId) throw new Error("Не выбран каталог (folderId) — метрики облака привязаны к каталогу.");
    const queries = list(o.queries && o.queries.length ? o.queries : o.query);
    if (!queries.length) throw new Error("Нужен query — текст запроса Monitoring, например cpu_usage{service=\"compute\", resource_id=\"…\"}.");
    const minutes = Number(o.minutes) > 0 ? Number(o.minutes) : 60;
    const to = o.toTime ? new Date(o.toTime) : new Date();
    const from = o.fromTime ? new Date(o.fromTime) : new Date(to.getTime() - minutes * 60000);
    if (!isFinite(from.getTime()) || !isFinite(to.getTime())) throw new Error("Не понял время. Укажи минуты (minutes) или время в формате RFC3339.");
    const maxPoints = Math.max(11, parseInt(o.maxPoints, 10) || 30); // облако требует больше 10
    const gridAggregation = one(o.aggregation || o.gridAggregation).toUpperCase();
    if (gridAggregation && AGGREGATIONS.indexOf(gridAggregation) === -1) {
      throw new Error("Неизвестная функция прореживания «" + gridAggregation + "». Доступно: " + AGGREGATIONS.join(", ") + ".");
    }
    const gapFilling = one(o.gapFilling).toUpperCase();
    if (gapFilling && GAP_FILLING.indexOf(gapFilling) === -1) {
      throw new Error("Неизвестное заполнение пропусков «" + gapFilling + "». Доступно: " + GAP_FILLING.join(", ") + ".");
    }
    const base = await baseOf();
    const path = "/monitoring/v2/data/read?folderId=" + encodeURIComponent(folderId);
    const headers = { Authorization: "Bearer " + (await getIamToken(oauthToken)), "Content-Type": "application/json" };

    const send = async (query) => {
      const body = {
        query: query,
        // Облако ждёт RFC3339 без миллисекунд — формат тот же, что у машин (yc-compute).
        fromTime: from.toISOString().replace(/\.\d{3}Z$/, "Z"),
        toTime: to.toISOString().replace(/\.\d{3}Z$/, "Z"),
        downsampling: { maxPoints: String(maxPoints), gridAggregation: gridAggregation || "AVG", gapFilling: gapFilling || "NULL" },
      };
      try {
        const j = await fetchJson(base + path, { method: "POST", headers: headers, body: JSON.stringify(body) }, 30000);
        const series = (j && j.metrics) || [];
        if (!series.length) return { query: query, empty: true, found: 0, summary: { count: 0 } };
        // Ряд может прийти несколькими метриками (разные наборы меток) — сводим
        // каждую отдельно, а итоговую строку отдаём по первой: человек читает
        // «сколько, максимум, в среднем», а не таблицу рядов.
        const rows = series.map((m) => ({
          name: one(m && m.name),
          labels: (m && m.labels) || {},
          type: one(m && m.type),
          summary: summarize(m && m.timeseries),
        }));
        return { query: query, empty: false, found: series.length, rows: rows, summary: rows[0].summary, name: rows[0].name, labels: rows[0].labels, type: rows[0].type };
      } catch (e) {
        return { query: query, error: serviceError(e, base, "/monitoring/v2/data/read") };
      }
    };
    return await Promise.all(queries.map(send));
  }

  // Метаданные: какие метрики вообще есть в каталоге и с какими метками. Это
  // единственный честный способ узнать имена метрик: они меняются от сервиса к
  // сервису, и список, записанный по памяти, устареет молча.
  async function listMetrics(oauthToken, opts) {
    const o = opts || {};
    const folderId = one(o.folderId);
    if (!folderId) throw new Error("Не выбран каталог (folderId) — метрики облака привязаны к каталогу.");
    const selectors = one(o.selectors);
    const limit = Number(o.limit) > 0 ? Number(o.limit) : 200;
    const q = new URLSearchParams();
    q.set("folderId", folderId);
    if (selectors) q.set("selectors", selectors);
    // fromTime и toTime облако принимает ТОЛЬКО вместе: по одному оно их не
    // понимает, а по паре — отдаёт метрики, у которых были данные в интервале.
    const minutes = Number(o.minutes) > 0 ? Number(o.minutes) : 0;
    if (minutes) {
      const to = new Date();
      const from = new Date(to.getTime() - minutes * 60000);
      q.set("fromTime", from.toISOString().replace(/\.\d{3}Z$/, "Z"));
      q.set("toTime", to.toISOString().replace(/\.\d{3}Z$/, "Z"));
    }
    const base = await baseOf();
    const path = "/monitoring/v2/metrics?" + q.toString();
    let j = null;
    try {
      j = await fetchJson(base + path, { method: "GET", headers: { Authorization: "Bearer " + (await getIamToken(oauthToken)) } }, 30000);
    } catch (e) {
      throw new Error(serviceError(e, base, "/monitoring/v2/metrics"));
    }
    const items = ((j && j.metrics) || []).map((m) => ({ name: one(m && m.name), labels: (m && m.labels) || {}, type: one(m && m.type) }));
    // Имён может быть много, а полезного мало: без меток метрика не читается,
    // поэтому собираем и список имён, и сколько раз встретилось каждое.
    const byName = new Map();
    for (const it of items) {
      const cur = byName.get(it.name) || { name: it.name, type: it.type, series: 0, labels: new Set() };
      cur.series++;
      cur.type = cur.type || it.type;
      for (const k of Object.keys(it.labels)) cur.labels.add(k);
      byName.set(it.name, cur);
    }
    const names = Array.from(byName.values())
      .map((n) => ({ name: n.name, type: n.type, series: n.series, labels: Array.from(n.labels).sort() }))
      .sort((a, b) => b.series - a.series || (a.name < b.name ? -1 : 1));
    return { items: items.slice(0, limit), total: items.length, names: names.slice(0, limit), namesTotal: names.length, selectors: selectors };
  }

  return {
    AGGREGATIONS,
    GAP_FILLING,
    TYPES,
    selectorFor,
    queryFor,
    summarize,
    readMetrics,
    listMetrics,
    formatValue,
    linesMetrics,
    linesNames,
  };
}

module.exports = { createYcMonitoring, AGGREGATIONS, GAP_FILLING, TYPES, formatValue, linesMetrics, linesNames };

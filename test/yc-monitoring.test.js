"use strict";

/* ── Monitoring: метрики каталога (данные и метаданные) ───────────────────────
   Запуск: node test/yc-monitoring.test.js   (входит в общий `npm test`)

   Зачем набор. Метрики — единственный способ узнать, что ресурс ДЕЛАЕТ: работает
   или простаивает, упирается ли в предел. Публичный справочник API у Monitoring
   короткий — всего два ресурса (данные метрик и их метаданные), — и у каждого
   своя форма запроса: данные идут POST-ом с телом (query + интервал +
   ПРОРЕЖИВАНИЕ), метаданные — GET-ом со строкой параметров. Ошибка в любом из
   двух выглядит одинаково — «пусто», и без набора это неотличимо от «метрик нет».

   Что проверяется:
     • сборка запроса и селектора: `имя{метка="значение"}`, экранирование
       кавычек в значении, отказ на пустом имени метрики;
     • отказы ДО сети: незнакомая функция прореживания, незнакомое заполнение
       пропусков, maxPoints меньше предела облака (он требует больше 10);
     • живой запрос данных: путь, folderId в строке, тело (query, fromTime/toTime
       без миллисекунд, downsampling с maxPoints строкой), разбор ответа в сводку,
       пропуски (NULL) в расчёт не идут, ПУСТОЙ ответ — это `empty`, а не ошибка;
     • метаданные: каталог и селектор уходят в строке, fromTime/toTime только
       ВМЕСТЕ (по одному их не бывает), имена собираются с числом рядов и метками;
     • текст ответа: «данных нет» и тип метрики словами — тот же текст у агента и
       в окне, потому что живёт он в модуле;
     • инструмент ycMonitor: каталог и токен обязательны, чужое действие
       отвергается, ответ честно говорит, что алерт поставить нечем;
     • интерфейс: семейство в yc-actions (канал, список действий, поля), канал
       `yc:monitoring` с тем же списком в отказе, проброс в окно, полка каталога
       (плитка Monitoring и её запрос по своим правилам);
     • согласованность: схема, обе строки промпта, группа «облако», политика прав,
       справочник yc.md, smoke-набор и цепочка npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE). */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
const ycMonitoringMod = require(path.join(ROOT, "src", "yc-monitoring.js"));
const { createYcMonitoring } = ycMonitoringMod;
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke", "03-cloud.js");
const ACTIONS_TEST_SRC = read("test", "yc-actions.test.js");
const MAIN_SRC = read("src", "main.js");
const YC_SRC = read("src", "yandex-cloud.js");
const PKG = JSON.parse(read("package.json"));

// ── Подменённое облако Monitoring ───────────────────────────────────────────
// Отвечает обеими формами, какие есть у сервиса: данные — JSON на POST, метаданные
// — JSON на GET со строкой параметров. В ряду данных нарочно стоит ПРОПУСК
// (null): именно на нём видно, что сводка считает только настоящие точки.
function startMonitoringStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      const url = req.url || "";
      calls.push({ method: req.method, url: url, headers: req.headers, body: raw });
      const json = (o, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (url.indexOf("/monitoring/v2/data/read") >= 0) {
        const b = JSON.parse(raw || "{}");
        if (/нет-такой/.test(b.query || "")) return json({ metrics: [] });
        if (/беда/.test(b.query || "")) return json({ message: "Metric not found" }, 400);
        return json({
          metrics: [{
            name: "cpu_usage",
            labels: { service: "compute", resource_id: "epd1" },
            type: "DGAUGE",
            timeseries: { timestamps: [1, 2, 3, 4], doubleValues: [1, null, 3, 5] },
          }],
        });
      }
      if (url.indexOf("/monitoring/v2/metrics") >= 0) {
        return json({
          metrics: [
            { name: "cpu_usage", labels: { service: "compute", resource_id: "epd1" }, type: "DGAUGE" },
            { name: "cpu_usage", labels: { service: "compute", resource_id: "epd2" }, type: "DGAUGE" },
            { name: "disk_read_bytes", labels: { service: "compute", resource_id: "epd1" }, type: "RATE" },
          ],
        });
      }
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server: server, calls: calls, base: "http://127.0.0.1:" + server.address().port }));
  });
}

const monitoring = createYcMonitoring({
  fetchJson: yandex._fetchJson,
  endpoint: yandex.endpoint,
  getIamToken: yandex.getIamToken,
  serviceError: yandex.serviceError,
  isNetworkError: yandex.isNetworkError,
});

function settingsFor(over) {
  return Object.assign(
    { yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "folder-1", ycFolderName: "prod" },
    over || {}
  );
}

function buildTools(settingsOver) {
  const settings = settingsFor(settingsOver);
  const tools = createCloudTools({
    path: path,
    fs: fs,
    yandexCloud: yandex,
    ycMonitoring: monitoring,
    ycConfig: (s) => {
      const st = s || settings;
      return {
        oauth: String(st.yandexOauthToken || ""),
        cloudId: st.ycCloudId || "",
        folderId: st.ycFolderId || "",
        folderName: st.ycFolderName || "",
        allowCreate: !!st.ycAllowAgentCreate,
        allowDelete: !!st.ycAllowAgentDelete,
        allowUpdate: !!st.ycAllowAgentUpdate,
      };
    },
    loadSettings: () => settings,
  });
  return { tools: tools, settings: settings };
}

const callsTo = (stub, part) => stub.calls.filter((c) => c.url.indexOf(part) >= 0);
const section = (src, channel) => {
  const at = src.indexOf('ipcMain.handle("' + channel + '"');
  assert.ok(at > 0, "нет канала " + channel);
  let end = src.indexOf('ipcMain.handle("', at + 10);
  if (end < 0) end = src.length;
  return src.slice(at, end);
};

(async () => {
  const stub = await startMonitoringStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Сборка запроса: имя метрики и метки");

  await test("ycMonitor: запрос собирается как имя{метка=\"значение\"}, кавычки экранируются", () => {
    assert.strictEqual(monitoring.queryFor("cpu_usage", { service: "compute", resource_id: "epd1" }), 'cpu_usage{service="compute", resource_id="epd1"}');
    assert.strictEqual(monitoring.selectorFor({ service: "compute", resource_id: "epd1" }), 'service="compute", resource_id="epd1"');
    assert.strictEqual(monitoring.selectorFor({ service: "compute", resource_id: "" }), 'service="compute"', "пустая метка попала в селектор");
    assert.strictEqual(monitoring.queryFor("m", { id: 'a"b' }), 'm{id="a\\"b"}', "кавычка в значении не экранирована");
    assert.strictEqual(monitoring.queryFor("cpu_usage", undefined), "cpu_usage{}", "метрика без меток собрана неверно");
    assert.throws(() => monitoring.queryFor("", {}), /Пустое имя метрики/, "пустое имя метрики не отвергнуто");
  });

  await test("ycMonitor: незнакомая функция прореживания и пропуски — отказ до сети", async () => {
    const from = stub.calls.length;
    await assert.rejects(() => monitoring.readMetrics("oauth-1", { folderId: "f1", query: "cpu_usage{}", aggregation: "СРЕДНЕЕ" }), /Неизвестная функция прореживания/);
    await assert.rejects(() => monitoring.readMetrics("oauth-1", { folderId: "f1", query: "cpu_usage{}", gapFilling: "ЧЕМ-НИБУДЬ" }), /Неизвестное заполнение пропусков/);
    await assert.rejects(() => monitoring.readMetrics("oauth-1", { folderId: "", query: "cpu_usage{}" }), /Не выбран каталог/);
    await assert.rejects(() => monitoring.readMetrics("oauth-1", { folderId: "f1", query: "" }), /Нужен query/);
    assert.strictEqual(stub.calls.length, from, "при ошибке всё-таки ушли запросы");
  });

  await test("ycMonitor: сводка считает настоящие точки, а пропуски (null) пропускает", () => {
    const s = monitoring.summarize({ timestamps: [1, 2, 3, 4], doubleValues: [1, null, 3, 5] });
    assert.strictEqual(s.count, 3, "пропуск засчитан как точка: " + s.count);
    assert.strictEqual(s.min, 1);
    assert.strictEqual(s.max, 5);
    assert.strictEqual(s.avg, 3, "среднее посчитано вместе с пропуском: " + s.avg);
    assert.strictEqual(s.last, 5);
    assert.strictEqual(s.skipped, 1, "пропуск не отмечен");
    const empty = monitoring.summarize({ timestamps: [], doubleValues: [] });
    assert.strictEqual(empty.count, 0, "пустой ряд дал точки");
    const ints = monitoring.summarize({ timestamps: [1, 2], int64Values: [10, 20] });
    assert.strictEqual(ints.avg, 15, "целые значения (IGAUGE) не разобраны");
  });

  console.log("\n[2] Данные метрик: запрос и разбор ответа");

  await test("ycMonitor: данные идут POST-ом с каталогом в строке и прореживанием в теле", async () => {
    const from = callsTo(stub, "/monitoring/v2/data/read").length;
    const rows = await monitoring.readMetrics("oauth-1", { folderId: "folder-1", query: 'cpu_usage{service="compute"}', minutes: 30, maxPoints: 20, aggregation: "MAX", gapFilling: "PREVIOUS" });
    const sent = callsTo(stub, "/monitoring/v2/data/read").slice(from);
    assert.strictEqual(sent.length, 1, "ушло не одно обращение: " + sent.length);
    assert.strictEqual(sent[0].method, "POST");
    assert.ok(/folderId=folder-1/.test(sent[0].url), "каталог не ушёл в строке: " + sent[0].url);
    assert.strictEqual(sent[0].headers.authorization, "Bearer iam-test", "нет IAM-токена");
    const b = JSON.parse(sent[0].body);
    assert.strictEqual(b.query, 'cpu_usage{service="compute"}');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(b.fromTime), "fromTime не в RFC3339 без миллисекунд: " + b.fromTime);
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(b.toTime), "toTime не в RFC3339 без миллисекунд: " + b.toTime);
    assert.strictEqual(b.downsampling.maxPoints, "20", "maxPoints ушёл не строкой: " + JSON.stringify(b.downsampling));
    assert.strictEqual(b.downsampling.gridAggregation, "MAX", "функция прореживания не дошла");
    assert.strictEqual(b.downsampling.gapFilling, "PREVIOUS", "заполнение пропусков не дошло");
    assert.strictEqual(rows[0].name, "cpu_usage");
    assert.strictEqual(rows[0].type, "DGAUGE");
    assert.strictEqual(rows[0].summary.count, 3, "сводка не разобрана");
    assert.strictEqual(rows[0].labels.resource_id, "epd1", "метки ряда не разобраны");
  });

  await test("ycMonitor: несколько запросов идут пачкой, а maxPoints меньше предела — поднимается", async () => {
    const from = callsTo(stub, "/monitoring/v2/data/read").length;
    await monitoring.readMetrics("oauth-1", { folderId: "folder-1", queries: ["cpu_usage{}", "disk_read_bytes{}"] });
    assert.strictEqual(callsTo(stub, "/monitoring/v2/data/read").length - from, 2, "на два запроса ушло не два обращения");
    const one = await monitoring.readMetrics("oauth-1", { folderId: "folder-1", query: "cpu_usage{}", maxPoints: 5 });
    assert.strictEqual(one[0].summary.count, 3);
    const sent = callsTo(stub, "/monitoring/v2/data/read").slice(-1)[0];
    assert.strictEqual(JSON.parse(sent.body).downsampling.maxPoints, "11", "предел облака (>10) не соблюдён: " + JSON.parse(sent.body).downsampling.maxPoints);
    assert.strictEqual(JSON.parse(sent.body).downsampling.gridAggregation, "AVG", "функция прореживания по умолчанию не AVG");
  });

  await test("ycMonitor: пустой ответ — это «нет данных», а не ошибка сервиса", async () => {
    const rows = await monitoring.readMetrics("oauth-1", { folderId: "folder-1", query: 'нет-такой{service="compute"}' });
    assert.strictEqual(rows[0].empty, true, "пустой ответ не отмечен как пустой");
    assert.strictEqual(rows[0].error, undefined, "пустой ответ превратился в ошибку");
    const bad = await monitoring.readMetrics("oauth-1", { folderId: "folder-1", query: 'беда{service="compute"}' });
    assert.ok(/беда/.test(bad[0].query), "ошибочный запрос потерялся");
    assert.ok(bad[0].error, "отказ сервиса не пойман");
    assert.ok(/monitoring\.api\.cloud\.yandex\.net|127\.0\.0\.1/.test(bad[0].error), "в ошибке нет адреса сервиса: " + bad[0].error);
  });

  console.log("\n[3] Метаданные: какие метрики вообще есть");

  await test("ycMonitor: метаданные идут GET-ом, каталог и селектор — в строке", async () => {
    const from = callsTo(stub, "/monitoring/v2/metrics").length;
    const r = await monitoring.listMetrics("oauth-1", { folderId: "folder-1", selectors: 'service="compute"' });
    const sent = callsTo(stub, "/monitoring/v2/metrics").slice(from);
    assert.strictEqual(sent.length, 1, "ушло не одно обращение");
    assert.strictEqual(sent[0].method, "GET");
    assert.ok(/folderId=folder-1/.test(sent[0].url), "каталог не ушёл: " + sent[0].url);
    assert.ok(/selectors=/.test(sent[0].url), "селектор не ушёл: " + sent[0].url);
    assert.ok(!/fromTime|toTime/.test(sent[0].url), "время ушло без просьбы: " + sent[0].url);
    assert.strictEqual(r.total, 3, "ряды не разобраны: " + r.total);
    assert.strictEqual(r.namesTotal, 2, "имена не сгруппированы: " + r.namesTotal);
    assert.strictEqual(r.names[0].name, "cpu_usage", "первым идёт не самый частый: " + r.names[0].name);
    assert.strictEqual(r.names[0].series, 2, "число рядов у имени не посчитано");
    assert.deepStrictEqual(r.names[0].labels, ["resource_id", "service"], "метки имени не собраны: " + JSON.stringify(r.names[0].labels));
    assert.strictEqual(r.names[0].type, "DGAUGE");
  });

  await test("ycMonitor: время в метаданных уходит только ПАРОЙ (по одному облако не понимает)", async () => {
    const from = callsTo(stub, "/monitoring/v2/metrics").length;
    await monitoring.listMetrics("oauth-1", { folderId: "folder-1", minutes: 120 });
    const sent = callsTo(stub, "/monitoring/v2/metrics").slice(from)[0];
    assert.ok(/fromTime=/.test(sent.url) && /toTime=/.test(sent.url), "пара времени ушла не целиком: " + sent.url);
    const from2 = callsTo(stub, "/monitoring/v2/metrics").length;
    await monitoring.listMetrics("oauth-1", { folderId: "folder-1" });
    const sent2 = callsTo(stub, "/monitoring/v2/metrics").slice(from2)[0];
    assert.ok(!/fromTime/.test(sent2.url), "время ушло, хотя не просили");
  });

  console.log("\n[4] Текст ответа — один для агента и для окна");

  await test("ycMonitor: строки говорят «данных нет» и называют тип словами", () => {
    const lines = monitoring.linesMetrics([{ query: 'x{}', empty: true, summary: { count: 0 } }], { minutes: 60 });
    assert.ok(/данных за 60 мин нет/.test(lines[0]), "пустой ряд не объяснён: " + lines[0]);
    const ok = monitoring.linesMetrics([{ query: "cpu_usage{}", name: "cpu_usage", type: "DGAUGE", summary: { count: 3, avg: 3, max: 5, last: 5 } }], { minutes: 60 });
    assert.ok(/дробный показатель/.test(ok[0]), "тип не назван словами: " + ok[0]);
    assert.ok(/в среднем 3/.test(ok[0]) && /максимум 5/.test(ok[0]), "цифры не в строке: " + ok[0]);
    const names = monitoring.linesNames({ names: [{ name: "cpu_usage", type: "DGAUGE", series: 2, labels: ["service", "resource_id"] }] });
    assert.ok(/cpu_usage/.test(names[0]) && /рядов: 2/.test(names[0]) && /метки: service, resource_id/.test(names[0]), "строка имени неполна: " + names[0]);
  });

  console.log("\n[5] Инструмент агента ycMonitor");

  await test("ycMonitor: без подключения, без каталога и с чужим действием — до сети", async () => {
    const off = buildTools({ yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await off.tools.ycMonitor({ action: "overview" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({ ycFolderId: "" });
    assert.ok(/выбери каталог/.test(await noFolder.tools.ycMonitor({ action: "overview" }, {})), "нет ответа про каталог");
    const env = buildTools();
    const from = stub.calls.length;
    const bad = await env.tools.ycMonitor({ action: "создай-алерт" }, {});
    assert.ok(/неизвестное действие ycMonitor/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 120));
    assert.strictEqual(stub.calls.length, from, "на чужом действии ушли запросы");
  });

  await test("ycMonitor: overview показывает имена метрик и честно говорит про алерты", async () => {
    const env = buildTools();
    const out = await env.tools.ycMonitor({ action: "overview" }, {});
    assert.ok(/cpu_usage/.test(out) && /disk_read_bytes/.test(out), "имена метрик не показаны: " + out.slice(0, 200));
    assert.ok(/Метрик-имён: 2/.test(out), "счёт имён не назван: " + out.slice(0, 200));
    assert.ok(/консоли Monitoring/.test(out) && /алерт/i.test(out), "ответ молчит про то, что алерт поставить нечем");
    const byName = await env.tools.ycMonitor({ action: "names", service: "compute", resource: "epd1" }, {});
    assert.ok(/селектор service="compute", resource_id="epd1"/.test(byName), "селектор не назван: " + byName.slice(0, 200));
  });

  await test("ycMonitor: metrics читает данные и объясняет пустой ряд", async () => {
    const env = buildTools();
    const out = await env.tools.ycMonitor({ action: "metrics", metric: "cpu_usage", service: "compute", resource: "epd1", minutes: 15, aggregation: "max" }, {});
    assert.ok(/Метрики за 15 мин/.test(out), "период не назван: " + out.slice(0, 160));
    assert.ok(/дробный показатель/.test(out) && /в среднем 3/.test(out), "сводка не показана: " + out.slice(0, 200));
    assert.ok(/Прочитано: 1 из 1/.test(out), "итог чтения не назван");
    const sent = callsTo(stub, "/monitoring/v2/data/read").slice(-1)[0];
    assert.strictEqual(JSON.parse(sent.body).downsampling.gridAggregation, "MAX", "функция прореживания из аргументов не дошла (регистр?)");
    const empty = await env.tools.ycMonitor({ action: "metrics", metric: "нет-такой", service: "compute" }, {});
    assert.ok(/данных за 60 мин нет/.test(empty), "пустой ряд не объяснён: " + empty.slice(0, 160));
    assert.ok(/names/.test(empty), "пустой ряд не подсказывает, как узнать настоящие метрики");
  });

  console.log("\n[6] Интерфейс: семейство действий, канал и полка");

  await test("ycMonitor: семейство объявлено в yc-actions и совпадает с каналом", () => {
    assert.ok(/monitoring: "ycMonitoring"/.test(ACTIONS_SRC), "в таблице действий нет канала мониторинга");
    assert.ok(/monitoring: \["overview", "names", "metrics"\]/.test(ACTIONS_SRC), "нет списка допустимых действий");
    assert.ok(/monitoring: \{ title: "Monitoring", ru: "метрика" \}/.test(ACTIONS_SRC), "нет подписи семейства");
    // Якорь именно на ТАБЛИЦУ действий, а не на список допустимых ops: у них
    // одинаковое начало строки, и первый попавшийся нашёлся бы у ops.
    const at = ACTIONS_SRC.indexOf('monitoring: [\n      { id: "overview"');
    assert.ok(at > 0, "нет таблицы действий мониторинга");
    const body = ACTIONS_SRC.slice(at, ACTIONS_SRC.indexOf("\n    ],", at));
    for (const part of ['op: "overview"', 'op: "names"', 'op: "metrics"', "minutes", "aggregation", "maxPoints"]) {
      assert.ok(body.includes(part), "в семействе мониторинга нет " + part);
    }
    assert.ok(/Кнопки «создать алерт» здесь НЕТ/.test(ACTIONS_SRC), "молчание про алерты не объяснено в модуле действий");
    assert.ok(/monitoring: "yc:monitoring"/.test(ACTIONS_TEST_SRC), "набор действий не знает семейство мониторинга — сверка каналов его не увидит");
  });

  await test("ycMonitor: канал yc:monitoring отвечает теми же действиями и отвергает чужие", () => {
    const body = section(IPC_SRC, "yc:monitoring");
    const m = body.match(/Доступно:\s*([^"]+?)\./);
    assert.ok(m, "в канале нет списка доступных действий");
    assert.deepStrictEqual(m[1].split(",").map((x) => x.trim()), ["overview", "names", "metrics"], "список действий канала разошёлся с интерфейсом");
    assert.ok(/ycMonitoring\.listMetrics\(/.test(body) && /ycMonitoring\.readMetrics\(/.test(body), "канал не зовёт модуль метрик");
    assert.ok(/ycMonitoring\.selectorFor\(/.test(body), "канал не собирает селектор меток модулем");
    assert.ok(/linesMetrics\(/.test(body) && /linesNames\(/.test(body), "канал собирает текст сам, а не берёт его у модуля");
    assert.ok(PRELOAD_SRC.includes('ycMonitoring: (args) => ipcRenderer.invoke("yc:monitoring", args || {})'), "preload не пробрасывает метрики в окно");
  });

  await test("ycMonitor: плитка Monitoring на полке и её запрос по своим правилам", () => {
    assert.ok(/"monitoring": "https:\/\/monitoring\.api\.cloud\.yandex\.net"/.test(YC_SRC), "нет адреса Monitoring в KNOWN_ENDPOINTS");
    assert.ok(/key: "monitoring", ru: "Метрики", title: "Monitoring"/.test(YC_SRC), "нет плитки Monitoring на полке");
    const at = YC_SRC.indexOf('svcDef.query === "monitoring"');
    assert.ok(at > 0, "нет правила запроса для Monitoring");
    // Границы правила — сама ветка: следующая строка общая для всех сервисов,
    // и её pageSize к Monitoring отношения не имеет.
    const body = YC_SRC.slice(at, YC_SRC.indexOf("}", at) + 1);
    assert.ok(/folderId=/.test(body) && !/pageSize/.test(body), "Monitoring получает чужой параметр pageSize: " + body);
    assert.ok(/createYcMonitoring|require\("\.\/yc-monitoring\.js"\)/.test(MAIN_SRC), "модуль метрик не собран в main.js");
    assert.ok(/ycMonitoring,/.test(MAIN_SRC), "модуль метрик не передан инструментам и каналам");
  });

  console.log("\n[7] Согласованность: схема, промпт, политика, справочник");

  await test("ycMonitor: схема, группа облака, промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycMonitor"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 4200);
    for (const part of ["action", "metric", "query", "service", "resource", "minutes", "aggregation", "maxPoints", "gapFilling", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/метаданные/.test(schema) && /СПРАВОЧНИК|метаданные/.test(schema), "схема не объясняет метаданные");
    assert.ok(/алерт/.test(schema), "схема молчит про то, что алертов нет");
    // Границы записи, а не число знаков: окно в 900 знаков ломалось от каждого
    // нового ключевого слова группы (заход 2 части 91 добавил «балансировщик»),
    // хотя проверяемое свойство — «инструмент есть в группе облака» — не менялось.
    const groupAt = CORE_SRC.indexOf('id: "cloud"');
    const groupEnd = CORE_SRC.indexOf('id: "', groupAt + 10);
    const cloudGroup = CORE_SRC.slice(groupAt, groupEnd > groupAt ? groupEnd : groupAt + 1400);
    assert.ok(cloudGroup.includes('"ycMonitor"'), "инструмента нет в группе «облако»");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycMonitor/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycMonitor \(METRIKI/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycMonitor");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 280).includes('"ycMonitor"'), "нет назначения cloud.read для ycMonitor");
    assert.ok(SMOKE_SRC.includes('"ycMonitor"'), "smoke-набор не знает про ycMonitor");
  });

  await test("ycMonitor: справочник агента учит узнавать метрики, а не выдумывать", () => {
    assert.ok(/ycMonitor/.test(GUIDE_SRC), "в yc.md нет ycMonitor");
    assert.ok(/Сначала `overview`/.test(GUIDE_SRC), "в yc.md нет правила «сначала метаданные»");
    assert.ok(/maxPoints/.test(GUIDE_SRC) && /AVG\/MAX\/MIN\/SUM\/LAST\/COUNT/.test(GUIDE_SRC), "в yc.md нет прореживания");
    assert.ok(/алерт/.test(GUIDE_SRC) && /консоли Monitoring/.test(GUIDE_SRC), "в yc.md не сказано про алерты");
  });

  await test("ycMonitor: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-monitoring.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

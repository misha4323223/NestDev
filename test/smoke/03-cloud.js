"use strict";
/* ─── Группа «Yandex Cloud: журналы, папки, реестр, деньги» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 6.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  coreData,
  get,
  hasTool,
  mainOnlySrc,
  modelPrompt,
  tmpdir,
  toolBody,
} = H;

// ── Yandex Cloud по отчёту песочницы: адреса, повторы, пачки, UX ────────────
async function testYcDiagnosis() {
  const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
  const mainSrc = backendSrc();
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  // Панель Yandex Cloud вынесена в отдельный модуль (этап 2 разбора app.js):
  // проверки интерфейса читают оба файла, а appSrc остаётся строго про app.js.
  const uiSrc = appSrc + "\n" + fs.readFileSync(path.join(ROOT, "src", "renderer", "yc-panel.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js

  const makeFetch = (handler) => {
    const calls = [];
    let inflight = 0;
    let maxInflight = 0;
    const f = async (url) => {
      calls.push(String(url));
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        const r = await handler(String(url), calls.length);
        return {
          ok: r.status ? r.status < 400 : true,
          status: r.status || 200,
          async text() { return r.body == null ? "" : JSON.stringify(r.body); },
        };
      } finally {
        inflight--;
      }
    };
    f.calls = calls;
    f.stats = () => ({ maxInflight, count: calls.length });
    return f;
  };
  const iamBody = () => ({ iamToken: "t", expiresAt: new Date(Date.now() + 3600e3).toISOString() });

  const realFetch = global.fetch;
  try {
    await test("yc: адреса сервисов — logging/logGroups и SES-путь Postbox", async () => {
      const lg = yc.SERVICES.find((s) => s.key === "logging");
      assert.strictEqual(lg.listPath, "/logging/v1/logGroups", "неверный путь лог-групп");
      const f = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} }; // нет списка эндпоинтов → фолбэк
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        return { body: { Identities: [] } };
      });
      global.fetch = f;
      yc.resetIamCache();
      await yc.listService("oauth", "folder1", yc.serviceByKey("postbox"));
      const url = f.calls.find((u) => u.includes("postbox"));
      assert.ok(/^https:\/\/postbox\.cloud\.yandex\.net\/v2\/email\/identities/.test(url), "неверный адрес Postbox: " + url);
      // folderId у SES-API нет: свои параметры (PageSize), см. отдельный тест.
      assert.ok(!url.includes("folderId="), "SES-запрос получил непонятный ему folderId: " + url);
    });

    await test("yc: сетевой сбой повторяется (2 попытки), 403 — нет и подписан адресом", async () => {
      let n = 0;
      const f = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        n++;
        if (n === 1) throw new TypeError("fetch failed");
        return { body: { networks: [{ id: "n1" }, { id: "n2" }] } };
      });
      global.fetch = f;
      yc.resetIamCache();
      const r = await yc.listService("oauth", "f1", yc.serviceByKey("vpc"));
      assert.strictEqual(r.count, 2);
      assert.strictEqual(n, 2, "попыток: " + n);

      let m = 0;
      const f2 = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        m++;
        return { status: 403, body: { message: "Permission denied" } };
      });
      global.fetch = f2;
      yc.resetIamCache();
      let err = null;
      try {
        await yc.listService("oauth", "f1", yc.serviceByKey("cdn"));
      } catch (e) {
        err = e;
      }
      assert.ok(err && /Нет доступа \(403\)/.test(err.message), err && err.message);
      assert.ok(/cdn\.api\.cloud\.yandex\.net/.test(err.message), "нет адреса в ошибке: " + err.message);
      assert.strictEqual(m, 1, "403 не должен повторяться");
    });

    await test("yc: дашборд опрашивает сервисы пачками, порядок и ошибки сохранены", async () => {
      const f = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        if (!url.includes("vpc")) throw new TypeError("fetch failed");
        return { body: { networks: [{ id: "n1" }] } };
      });
      global.fetch = f;
      yc.resetIamCache();
      const res = await yc.resourcesStatus("oauth", "f1");
      assert.deepStrictEqual(res.map((s) => s.key), yc.SERVICES.map((s) => s.key), "порядок карточек поехал");
      // Пачка из 3 + не больше одного фонового запроса каталога эндпоинтов.
      assert.ok(f.stats().maxInflight <= 4, "залп запросов: " + f.stats().maxInflight);
      assert.ok(f.calls.filter((u) => u.includes("/endpoints")).length <= 1, "каталог эндпоинтов дёргается повторно");
      const broken = res.filter((s) => !s.ok);
      assert.ok(broken.length > 0 && broken.every((s) => /Сеть:|Таймаут:|\[/.test(s.error)), "непонятная ошибка: " + (broken[0] || {}).error);
      assert.ok(res.find((s) => s.key === "vpc" && s.ok), "vpc должен был ответить");
      // Русское имя едет вместе с английским: полка в окне и поиск по ней
      // работают по тому, что человек ВИДИТ («Сети VPC», «DNS-зоны»). Однажды
      // это поле потерялось, и панель молча стала английской — поймал живой
      // прогон test:live:yc, а здесь то же самое видно без окна и за секунду.
      const namesLost = res.filter((s) => s.ru !== (yc.SERVICES.find((d) => d.key === s.key) || {}).ru);
      assert.strictEqual(namesLost.length, 0, "полка не получает русское имя сервиса: " + JSON.stringify(namesLost.map((s) => s.key + "=" + s.ru)));
      const notRu = res.filter((s) => !/[А-Яа-яЁё]/.test(String(s.ru || "")));
      assert.strictEqual(notRu.length, 0, "сервисы названы не по-русски: " + notRu.map((s) => s.key).join(", "));
    });

    await test("yc: классификация ошибок (сеть / таймаут / API с адресом)", () => {
      assert.ok(yc.isNetworkError(new TypeError("fetch failed")), "не распознан сетевой сбой");
      const ab = new Error("This operation was aborted");
      ab.name = "AbortError";
      assert.ok(yc.isNetworkError(ab), "не распознан таймаут");
      assert.ok(/Таймаут: logging\.api\.cloud\.yandex\.net\/x/.test(yc.serviceError(ab, "https://logging.api.cloud.yandex.net", "/x")));
      assert.ok(/Сеть:/.test(yc.serviceError(new TypeError("fetch failed"), "https://vpc.api.cloud.yandex.net", "/vpc/v1/networks")));
      assert.strictEqual(yc.hostOf("https://a.b.c/x"), "a.b.c");
    });

    await test("инструменты агента читают свежие настройки (каталог применяется сразу)", () => {
      assert.strictEqual((mainSrc.match(/ycConfig\(settings\)/g) || []).length, 0, "остались вызовы со старым settings");
      assert.ok((mainSrc.match(/ycConfig\(loadSettings\(\)\)/g) || []).length >= 6, "yc-инструменты не читают свежие настройки");
      assert.ok(mainSrc.includes("mailConfig(loadSettings())"), "почта не читает свежие настройки");
      assert.ok(mainSrc.includes("loadSettings().sitePasswords"), "пароли сайтов не читаются свежими");
    });

    await test("cmd на Windows: UTF-8 (chcp 65001) для всех команд агента", () => {
      assert.ok(mainSrc.includes("function shellArgsFor(command)"), "нет хелпера кодировки");
      assert.ok(mainSrc.includes('"chcp 65001>nul & "'), "нет переключения кодировки");
      const uses = (mainSrc.match(/shellArgsFor\(command\)/g) || []).length;
      assert.ok(uses >= 3, "кодировка подключена не во все места запуска: " + uses);
      assert.strictEqual((mainSrc.match(/\[\"\/d\", \"\/s\", \"\/c\", command\]/g) || []).length, 0, "остался запуск cmd без UTF-8");
    });

    await test("UI: ошибки дашборда и списка каталогов видны текстом", () => {
      assert.ok(uiSrc.includes('err.className = "yc-card-err"'), "ошибка сервиса не показывается текстом");
      // Свёрнутая плитка длинный отказ НЕ печатает: текст заслонял полку, а при
      // раскрытии та же ошибка читалась дважды. Причина — в подсказке плитки
      // (card.title), полный текст — в развёрнутом списке (проверено в yc-ui).
      assert.ok(!uiSrc.includes("card.appendChild(err)"), "свёрнутая плитка печатает полный текст отказа");
      assert.ok(/card\.title = s\.ok[\s\S]{0,400}?: s\.error/.test(uiSrc), "причина отказа потерялась из подсказки плитки");
      assert.ok(uiSrc.includes('chip("Ошибки API", failed.length'), "строй здоровья не сообщает, сколько сервисов упало");
      assert.ok(uiSrc.includes("⏳ Загрузка каталогов…"), "нет состояния загрузки каталогов");
      assert.ok(uiSrc.includes("Каталоги не загрузились"), "пустой список каталогов не объясняет причину");
      assert.ok(htmlSrc.includes("галочка = РАЗРЕШЕНО"), "семантика чекбоксов разрешений не пояснена");
    });

    await test("app-инструменты: ref в описаниях и «номер [N] устаревает» в промпте", () => {
      for (const n of ["appClick", "appFill", "appSelect", "appWait"]) {
        const d = coreSrc.split('name: "' + n + '"')[1] || "";
        assert.ok(d.slice(0, 600).includes("ref"), "в описании " + n + " нет ref");
      }
      assert.ok(/номер \[N\] устаревает при любой перерисовке/.test(modelPrompt()), "промпт не предупреждает про номера");
    });
  } finally {
    global.fetch = realFetch;
    yc.resetIamCache();
  }
}

async function testYandexCloud() {
  const ycCli = require(path.join(ROOT, "src", "yc-cli.js"));
  const ycLogs = require(path.join(ROOT, "src", "yc-logs.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const http2 = require("http2");
  const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
  const ycSrc = fs.readFileSync(path.join(ROOT, "src", "yandex-cloud.js"), "utf8");
  const mainSrc = backendSrc();
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
  // Тот же простой мок сети, что и в yc-тестах выше: считает запросы и «в полёте».
  const makeFetch = (route) => {
    let inflight = 0;
    let maxInflight = 0;
    const calls = [];
    const f = async (url, opts) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      calls.push(String(url));
      try {
        const r = route(String(url), opts) || {};
        if (r.throw) throw r.throw;
        return {
          ok: r.status ? r.status < 400 : true,
          status: r.status || 200,
          async text() { return r.body == null ? "" : JSON.stringify(r.body); },
        };
      } finally {
        inflight--;
      }
    };
    f.calls = calls;
    f.stats = () => ({ maxInflight, count: calls.length });
    return f;
  };

  await test("yc-logs: протобаф — критерий запроса и разбор ответа (уровень, ресурс, время)", () => {
    const req = ycLogs.buildReadRequest({
      logGroupId: "grp-1",
      resourceIds: ["cont-1"],
      resourceTypes: ["serverless.container"],
      sinceMs: 1700000000000,
      untilMs: 1700003600000,
      pageSize: 50,
      filter: 'level = "ERROR"',
    });
    const crit = ycLogs.pbDecode(req).find((f) => f.field === 2 && f.wire === 2);
    assert.ok(crit, "в запросе нет criteria");
    const c = ycLogs.pbDecode(crit.buf);
    const str = (num) => {
      const f = c.find((x) => x.field === num && x.wire === 2);
      return f ? f.buf.toString("utf8") : "";
    };
    assert.strictEqual(str(1), "grp-1");
    assert.strictEqual(str(2), "serverless.container");
    assert.strictEqual(str(3), "cont-1");
    assert.strictEqual(str(7), 'level = "ERROR"');
    assert.strictEqual(Number(c.find((f) => f.field === 8 && f.wire === 0).num), 50);
    assert.ok(c.some((f) => f.field === 4 && f.wire === 2), "нет since");
    assert.ok(c.some((f) => f.field === 5 && f.wire === 2), "нет until");

    const resource = Buffer.concat([ycLogs.pbString(1, "serverless.container"), ycLogs.pbString(2, "cont-1")]);
    const entry = Buffer.concat([
      ycLogs.pbString(1, "uid-1"),
      ycLogs.pbMessage(2, resource),
      ycLogs.pbMessage(3, Buffer.concat([ycLogs.pbInt(1, 1700000000), ycLogs.pbInt(2, 500000000)])),
      ycLogs.pbInt(6, 5),
      ycLogs.pbString(7, "контейнер упал: timeout"),
    ]);
    const entries = ycLogs.parseReadResponse(Buffer.concat([ycLogs.pbString(1, "grp-1"), ycLogs.pbMessage(2, entry)]));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].message, "контейнер упал: timeout");
    assert.strictEqual(entries[0].level, 5);
    assert.strictEqual(entries[0].resourceId, "cont-1");
    assert.strictEqual(entries[0].timestamp, 1700000000500);
    assert.strictEqual(ycLogs.LEVEL_NAMES[5], "ERROR");
    const line = ycLogs.formatEntries(entries, { max: 5 })[0];
    assert.ok(line.includes("ERROR") && line.includes("timeout"), "строка лога: " + line);
    assert.deepStrictEqual(ycLogs.parseReadResponse(Buffer.alloc(0)), []);
  });

  await test("yc-logs: gRPC-кадры разделяются, обрезанный кадр не съедает мусор", () => {
    const frame = (buf) => {
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(buf.length, 1);
      return Buffer.concat([h, buf]);
    };
    const parts = ycLogs.grpcFrames(Buffer.concat([frame(Buffer.from("первый")), frame(Buffer.from("второй"))]));
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[1].toString("utf8"), "второй");
    assert.strictEqual(ycLogs.grpcFrames(Buffer.concat([frame(Buffer.from("ок")), Buffer.from([0, 0, 0, 0, 99, 1, 2])])).length, 1);
  });

  await test("yc-logs: живой обмен — лог-группы по REST, записи по gRPC (http2), внешний yc не нужен", async () => {
    const resource = Buffer.concat([ycLogs.pbString(1, "serverless.container"), ycLogs.pbString(2, "cont-42")]);
    const entry = Buffer.concat([
      ycLogs.pbString(1, "u"),
      ycLogs.pbMessage(2, resource),
      ycLogs.pbInt(6, 3),
      ycLogs.pbString(7, "hello from logs"),
    ]);
    const respBuf = Buffer.concat([ycLogs.pbString(1, "grp"), ycLogs.pbMessage(2, entry)]);
    let seenAuth = "";
    let seenPath = "";
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      seenAuth = String(headers.authorization || "");
      seenPath = String(headers[":path"] || "");
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(respBuf.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, respBuf]));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const res = await ycLogs.readLogs({
        iamToken: "t.IAM",
        baseUrl: "http://127.0.0.1:" + port,
        folderId: "folder-1",
        resourceIds: ["cont-42"],
        resourceTypes: ["serverless.container"],
        limit: 10,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ groups: [{ id: "grp", name: "default" }] }) }),
      });
      assert.strictEqual(res.logGroupId, "grp");
      assert.strictEqual(res.logGroupName, "default");
      assert.strictEqual(res.entries.length, 1);
      assert.strictEqual(res.entries[0].message, "hello from logs");
      assert.strictEqual(seenAuth, "Bearer t.IAM");
      assert.strictEqual(seenPath, "/yandex.cloud.logging.v1.LogReadingService/Read");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test("yc-logs: нет лог-групп и ошибки gRPC объясняются человеку", async () => {
    const noGroups = await ycLogs
      .readLogs({ iamToken: "t", baseUrl: "http://127.0.0.1:1", folderId: "f", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) })
      .then(() => null, (e) => e);
    assert.ok(noGroups && /нет ни одной лог-группы/.test(noGroups.message), "сообщение: " + (noGroups && noGroups.message));

    const bad = await ycLogs
      .readLogs({
        iamToken: "t",
        baseUrl: "http://127.0.0.1:1",
        folderId: "f",
        fetchImpl: async () => ({ ok: false, status: 403, text: async () => "Permission denied" }),
      })
      .then(() => null, (e) => e);
    assert.ok(bad && /HTTP 403/.test(bad.message), "сообщение: " + (bad && bad.message));

    const noFolder = await ycLogs.readLogs({ iamToken: "t", baseUrl: "http://127.0.0.1:1", folderId: "" }).then(() => null, (e) => e);
    assert.ok(noFolder && /каталог/.test(noFolder.message), "сообщение: " + (noFolder && noFolder.message));

    // Понятная подсказка по коду gRPC (нет прав / плохой токен / нет группы).
    const g = ycLogs.grpcCall("http://127.0.0.1:1", "/x", "t", Buffer.alloc(0), 2000).then(() => null, (e) => e);
    const ge = await g;
    assert.ok(ge instanceof Error, "нет ошибки при недоступном сервере");
  });

  await test("yc-cli: платформа, версия и адреса бинаря (официальная схема хранилища)", () => {
    assert.deepStrictEqual(ycCli.platformInfo("win32", "x64"), { ok: true, os: "windows", arch: "amd64", binName: "yc.exe" });
    assert.strictEqual(ycCli.platformInfo("darwin", "arm64").arch, "arm64");
    assert.strictEqual(ycCli.platformInfo("linux", "x64").binName, "yc");
    assert.strictEqual(ycCli.platformInfo("linux", "ia32").arch, "386");
    assert.strictEqual(ycCli.platformInfo("win32", "arm64").ok, false, "Windows/ARM не поддерживается");
    assert.strictEqual(ycCli.platformInfo("aix", "x64").ok, false);
    assert.ok(ycCli.versionUrl().endsWith("/release/stable"));
    assert.strictEqual(
      ycCli.binaryUrl("0.140.0", "linux", "amd64", "yc"),
      "https://storage.yandexcloud.net/yandexcloud-yc/release/0.140.0/linux/amd64/yc"
    );
    assert.ok(ycCli.binDir("/tmp/x").endsWith(path.join("x", "bin")));
    assert.strictEqual(ycCli.installed("/tmp/нет-такой-папки-xyz"), null);
  });

  await test("yc-cli: установка кладёт бинарь в папку приложения и не оставляет .tmp", async () => {
    const dir = tmpdir("yc-cli-");
    const big = Buffer.alloc(1024 * 1024 + 64, 7);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith("/release/stable")) return { ok: true, status: 200, text: async () => "0.140.0" };
      return { ok: true, status: 200, arrayBuffer: async () => big };
    };
    const r = await ycCli.install({ userData: dir, platform: "linux", arch: "x64", fetchImpl, timeoutMs: 5000 });
    assert.ok(r.ok, "установка не прошла: " + (r && r.error));
    assert.strictEqual(r.version, "0.140.0");
    const target = path.join(ycCli.binDir(dir), "yc");
    assert.ok(fs.existsSync(target), "бинарь не появился");
    assert.strictEqual(fs.statSync(target).size, big.length);
    assert.ok(!fs.existsSync(target + ".tmp"), "остался временный файл");
    assert.strictEqual(ycCli.installed(dir), target);
    assert.ok(calls.some((u) => u.includes("/0.140.0/linux/amd64/yc")), "скачан не тот бинарь: " + calls.join(", "));
  });

  await test("yc-cli: недокачанный файл не подменяет бинарь, мусор не остаётся", async () => {
    const dir = tmpdir("yc-cli-bad-");
    const small = await ycCli.install({
      userData: dir,
      platform: "linux",
      arch: "x64",
      fetchImpl: async (url) =>
        url.endsWith("stable") ? { ok: true, status: 200, text: async () => "0.140.0" } : { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(10) },
    });
    assert.strictEqual(small.ok, false);
    assert.ok(!fs.existsSync(path.join(ycCli.binDir(dir), "yc")), "недокачанный файл не должен занимать место бинаря");
    assert.ok(!fs.existsSync(path.join(ycCli.binDir(dir), "yc.tmp")), "остался .tmp");

    const bad = await ycCli.install({ userData: dir, platform: "linux", arch: "x64", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>error</html>" }) });
    assert.strictEqual(bad.ok, false);
    assert.ok(/Неожиданный ответ/.test(bad.error), "сообщение: " + bad.error);

    const offline = await ycCli.install({ userData: dir, platform: "linux", arch: "x64", fetchImpl: async () => { throw new Error("нет сети"); } });
    assert.strictEqual(offline.ok, false);
    assert.ok(/нет связи/i.test(offline.error), "сообщение: " + offline.error);

    const noDir = await ycCli.install({ userData: "", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "1.0.0" }) });
    assert.strictEqual(noDir.ok, false);
    const noFetch = await ycCli.install({ userData: dir, fetchImpl: null, platform: "sunos", arch: "x64" });
    assert.strictEqual(noFetch.ok, false);
  });

  await test("Yandex Cloud: токен и каталог автоматически уходят в окружение команд", () => {
    const main = backendSrc();
    assert.ok(main.includes('require("./yc-cli.js")') && main.includes('require("./yc-logs.js")'), "модули не подключены");
    assert.ok(/function ycAutoEnv\(s\)/.test(main), "нет ycAutoEnv");
    // yc CLI принимает в YC_TOKEN/YC_IAM_TOKEN только IAM-токен: OAuth там даёт
    // «The token is invalid», поэтому в env идёт свежий IAM из обмена OAuth→IAM.
    assert.ok(/out\.YC_IAM_TOKEN = iam/.test(main) && /out\.YC_TOKEN = iam/.test(main), "свежий IAM не подставляется");
    assert.ok(!/out\.YC_TOKEN = cfg\.oauth/.test(main), "в YC_TOKEN по-прежнему кладётся OAuth-токен");
    assert.ok(/const iam = ycIamEnvToken\(cfg\)/.test(main), "нет проверки свежести снимка IAM");
    assert.ok(/getIamTokenInfo\(cfg\.oauth\)/.test(main), "IAM берётся без срока жизни");
    assert.ok(/out\.YC_CLOUD_ID = cfg\.cloudId/.test(main), "cloudId не подставляется");
    assert.ok(/out\.YC_FOLDER_ID = cfg\.folderId/.test(main), "folderId не подставляется");
    assert.ok(main.includes("agentEnv = { ...userAgentEnv, ...ycAutoEnv(lastAgentEnvSettings) }"), "окружение не собирается из двух частей");
    assert.ok(main.includes("applyAgentEnv(s);"), "loadSettings не пересобирает окружение");
    assert.ok(main.includes("applyAgentEnv(merged);"), "смена настроек не пересобирает окружение");
    // Автоподстановка не должна оседать в настройках: сохраняем только пользовательское.
    assert.ok(main.includes("s.agentEnv = { ...live.userAgentEnv }"), "в настройки пишется не только пользовательское");
    // «Голое» имя main.js внутри модуля недоступно: было ReferenceError, и envSet/envUnset
    // отвечали ошибкой вместо работы (нашлось при вводе выдачи секретов).
    assert.ok(!main.includes("s.agentEnv = { ...userAgentEnv }"), "инструменты берут окружение не через мост");
    assert.ok(!main.includes("s.agentEnv = { ...agentEnv }"), "в настройки попадает объединённое окружение");
    assert.ok(main.includes("YC_TOKEN") && main.includes("[авто: Yandex Cloud]"), "envList не помечает автоматические переменные");
    assert.ok(/подставляется автоматически из настроек Yandex Cloud/.test(main), "envUnset не защищает автоматические переменные");
    // Папка встроенного yc CLI — в PATH всех команд.
    assert.ok(/function ycEnsurePath\(\)/.test(main), "нет ycEnsurePath");
    assert.ok(main.includes('ycCli.binDir(app.getPath("userData"))'), "не берётся папка приложения");
    assert.ok(main.includes("setMergedPath(before, dir)"), "PATH не обновляется");
  });

  await test("Yandex Cloud: ycLogs идёт через внутренний API — внешний yc CLI больше не нужен", () => {
    const main = backendSrc();
    assert.ok(/async function readYcLogsText\(/.test(main), "нет чтения логов внутренним API");
    assert.ok(main.includes('yandexCloud.endpoint("logging")'), "нет адреса сервиса логирования");
    assert.ok(main.includes("ycLogs.readLogs("), "не вызывается модуль логов");
    assert.ok(!main.includes("yc logging read"), "остался вызов внешнего yc CLI");
    assert.ok(!main.includes('findProgram("yc")'), "логи всё ещё ищут внешний yc");
    assert.ok(main.includes('ipcMain.handle("yc:logs"') && main.includes("readYcLogsText(cfg,"), "IPC логов не переведён");
    assert.ok(hasTool(main, "ycLogs") && hasTool(main, "ycInstall"), "нет инструментов ycLogs/ycInstall");
    assert.ok(main.includes('ipcMain.handle("yc:cliStatus"') && main.includes('ipcMain.handle("yc:installCli"'), "нет IPC встроенного yc CLI");
    assert.ok(main.includes("const YC_RESOURCE_TYPES") && main.includes("serverless.container"), "нет карты типов ресурсов");
  });

  await test("Yandex Cloud: инструменты, алиасы промпта, мост и интерфейс согласованы", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    for (const n of ["ycStatus", "ycList", "ycContainer", "ycSecret", "ycDns", "ycRegistry", "ycStorage", "ycVpc", "ycCompute", "ycIam", "ycFunctions", "ycBilling", "ycCdn", "ycDb", "ycCreate", "ycDelete", "ycDeploy", "ycLogs", "ycInstall"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
    const prompt = core.SYSTEM_PROMPT || "";
    for (const n of ["ycLogs", "ycInstall", "ycCdn"]) assert.ok(prompt.includes(n), "в промпте нет " + n);
    assert.ok(/yc init не нужен/.test(prompt), "в промпте нет пояснения про автоматическую авторизацию");
    const full = modelPrompt(); // промпт + автоподключаемый справочник группы cloud (промпт-диета)
    assert.ok(/внутренним API/i.test(full) && /Cloud Logging/.test(full), "в промпте не сказано, что логи идут внутренним API");
    const logsDef = core.TOOL_DEFINITIONS.find((d) => d.function && d.function.name === "ycLogs");
    assert.ok(/внутренним API/.test(logsDef.function.description), "описание ycLogs не обновлено");
    assert.deepStrictEqual(logsDef.function.parameters.required, ["id"], "id должен быть единственным обязательным");
    const installDef = core.TOOL_DEFINITIONS.find((d) => d.function && d.function.name === "ycInstall");
    assert.ok(/userData\/bin/.test(installDef.function.description), "описание ycInstall без папки установки");
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    for (const s of ["ycCliStatus", "ycInstallCli", "ycCdn"]) assert.ok(preload.includes(s), "в preload нет " + s);
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    for (const id of ["btn-yc-install-cli", "yc-cli-status"]) assert.ok(html.includes('id="' + id + '"'), "в index.html нет " + id);
    // Панель Yandex Cloud вынесена в src/renderer/yc-panel.js (этап 2 разбора app.js):
    // проверяем интерфейс целиком — сам app.js и модуль панели.
    const app = ["app.js", "yc-panel.js"]
      .map((f) => fs.readFileSync(path.join(ROOT, "src", "renderer", f), "utf8"))
      .join("\n");
    assert.ok(app.includes("api.ycInstallCli()"), "интерфейс не устанавливает yc CLI");
    assert.ok(app.includes("api.ycCliStatus()"), "интерфейс не показывает статус yc CLI");
    assert.ok(app.includes('$("btn-yc-install-cli")'), "нет обработчика кнопки установки yc CLI");
  });

  await test("Yandex Cloud: панель вынесена в yc-panel.js, собирается с заглушками и находит элементы разметки", () => {
    const vm = require("vm");
    const panelPath = path.join(ROOT, "src", "renderer", "yc-panel.js");
    assert.ok(fs.existsSync(panelPath), "нет файла src/renderer/yc-panel.js");
    const panelSrc = fs.readFileSync(panelPath, "utf8");
    const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");

    // 1. Разметка грузит модуль раньше app.js: иначе фабрика ещё не объявлена.
    const iPanel = html.indexOf('src="yc-panel.js"');
    assert.ok(iPanel > 0, "разметка не грузит yc-panel.js");
    assert.ok(iPanel < html.indexOf('src="app.js"'), "yc-panel.js подключён после app.js");
    // 2. Телефон получает модуль так же, как ПК.
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"yc-panel\.js"/.test(bridge), "мобильный мост не отдаёт yc-panel.js");
    // 3. В app.js не осталось кода панели — только сборка модуля с зависимостями.
    assert.ok(!/function ycLoadDashboard|const YC_CREATABLE/.test(appSrc), "код панели остался в app.js");
    assert.ok(/const YcPanel = window\.YcPanel\(\{/.test(appSrc), "app.js не собирает панель");
    for (const dep of ["$: $", "api: api", "isElectron: isElectron", "toast: toast", "termAppend: SidePanel.termAppend",
      "confirmModal: (...a) => ProjectPanel.confirmModal(...a)",
      "inputDialog: (...a) => ProjectPanel.inputDialog(...a)", "openSettings: SettingsPanel.openSettings",
      "openSidePanel: SidePanel.openSidePanel", "getSettings: () => settings"]) {
      assert.ok(appSrc.includes(dep), "в проводку панели не передан " + dep);
    }
    // 4. Границы модуля: настройки только через getSettings(), в чужие глобалы не лезем.
    assert.ok(!/(^|[^\w.])settings\./.test(panelSrc), "модуль ходит в settings напрямую вместо getSettings()");
    assert.ok(!/AgentCore|window\.api\b|localStorage/.test(panelSrc), "модуль лезет в чужие глобалы");

    // 5. Настоящая сборка в браузерной песочнице: модуль должен подняться и повесить
    //    обработчики на те id, которые реально есть в разметке (иначе тут TypeError).
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const stubs = new Map();
    const makeEl = (id) => {
      const set = new Set();
      return {
        id, style: {}, dataset: {}, children: [], value: "", textContent: "", innerHTML: "",
        title: "", checked: false, disabled: false,
        classList: {
          add: (...c) => c.forEach((x) => set.add(x)),
          remove: (...c) => c.forEach((x) => set.delete(x)),
          contains: (c) => set.has(c),
          toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
        },
        setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false,
        appendChild(c) { this.children.push(c); return c; }, removeChild() {},
        insertBefore(c) { this.children.push(c); return c; },
        addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
        focus() {}, blur() {}, click() {}, remove() {}, scrollIntoView() {}, closest: () => null,
        clientHeight: 100, scrollHeight: 100, offsetHeight: 100,
      };
    };
    const $ = (id) => {
      if (!ids.has(id)) return null;
      if (!stubs.has(id)) stubs.set(id, makeEl(id));
      return stubs.get(id);
    };
    const win = { YcConsole: { open() {}, close() {}, isOpen: () => false } };
    const sandbox = {
      window: win, self: win,
      document: { getElementById: $, createElement: (t) => makeEl(t), querySelector: () => null, querySelectorAll: () => [] },
      navigator: { clipboard: { readText: async () => "" } },
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.runInNewContext(panelSrc, sandbox, { filename: "yc-panel.js" });
    assert.strictEqual(typeof win.YcPanel, "function", "модуль не отдал фабрику в window.YcPanel");
    const built = win.YcPanel({
      $, isElectron: true,
      api: { ycCliStatus: async () => ({ ok: true }), ycInstallCli: async () => ({ ok: true }) },
      toast() {}, termAppend() {}, confirmModal() {}, inputDialog() {},
      openSettings() {}, openSidePanel() {},
      getSettings: () => ({ ycFolderId: "folder-1", ycCloudId: "cloud-1" }),
    });
    for (const id of ["btn-yc-connect", "btn-yc-get-token", "btn-yc-logout", "btn-yc-refresh-folders",
      "s-yc-folder", "s-yc-allow-create", "s-yc-allow-delete", "s-yc-allow-update", "btn-yc-install-cli",
      "btn-yc-dash-refresh", "btn-yc-dash-settings", "btn-yc-open-dash", "btn-yc-onboard-settings",
      "btn-yc-onboard-token", "btn-yc-paste-token", "btn-yc-deploy", "btn-yc-deploy-open"]) {
      const el = stubs.get(id);
      const handler = el && (el.onchange || el.onclick);
      assert.ok(typeof handler === "function", "модуль не повесил обработчик на " + id);
    }
    assert.deepStrictEqual(Object.keys(built).sort(), ["loadDashboard", "refreshSettingsUI"], "наружу торчит лишнее");
    assert.strictEqual(typeof built.loadDashboard, "function");
    assert.strictEqual(typeof built.refreshSettingsUI, "function");
  });

  await test("readYcLogsText: берёт реальный код модуля и собирает запрос из настроек", async () => {
    const main = fs.readFileSync(path.join(ROOT, "src", "yc-service.js"), "utf8");
    const s0 = main.indexOf("// Ключ сервиса → тип ресурса Cloud Logging");
    const s1 = main.indexOf("// Встроенный yc CLI:");
    assert.ok(s0 > 0 && s1 > s0, "не нашёл helpers логирования в main.js");
    const code = main.slice(s0, s1);

    const mkApi = (logGroup) => {
      const captured = { token: "", svcs: [], read: null };
      const sandbox = {
        yandexCloud: {
          getIamToken: async (t) => {
            captured.token = t;
            return "iam-1";
          },
          endpoint: async (svc) => {
            captured.svcs.push(svc);
            // Разные адреса намеренно разные: REST-группы и gRPC-чтение — разные хосты.
            return svc === "log-reading" ? "https://reader.test" : "https://logging.test";
          },
        },
        ycLogs: {
          readLogs: async (o) => {
            captured.read = o;
            return logGroup;
          },
          formatEntries: (entries, o) => entries.map((e) => "FMT:" + e.message + " max=" + o.max),
        },
      };
      const fn = new Function(...Object.keys(sandbox), code + "\nreturn { readYcLogsText, YC_RESOURCE_TYPES };");
      return { api: fn(...Object.values(sandbox)), captured };
    };

    const ok = mkApi({ logGroupId: "grp", logGroupName: "default", entries: [{ timestamp: 1700000000000, level: 3, resourceId: "c1", message: "ok", json: null }] });
    assert.strictEqual(ok.api.YC_RESOURCE_TYPES.serverlessContainers, "serverless.container");
    const text = await ok.api.readYcLogsText({ oauth: "y0", folderId: "f1" }, "serverlessContainers", "cont-9", { limit: 7, sinceHours: 12 });
    assert.strictEqual(ok.captured.token, "y0", "IAM-токен должен браться из настроек");
    assert.deepStrictEqual(ok.captured.svcs, ["logging", "log-reading"], "адреса берутся у сервисов logging и log-reading");
    assert.strictEqual(ok.captured.read.baseUrl, "https://logging.test", "группы читаются не с logging");
    assert.strictEqual(ok.captured.read.grpcBaseUrl, "https://reader.test", "записи читаются не с log-reading");
    assert.strictEqual(ok.captured.read.folderId, "f1");
    assert.deepStrictEqual(ok.captured.read.resourceIds, ["cont-9"]);
    assert.deepStrictEqual(ok.captured.read.resourceTypes, ["serverless.container"], "тип ресурса выводится из ключа сервиса");
    assert.strictEqual(ok.captured.read.limit, 7);
    assert.strictEqual(ok.captured.read.sinceHours, 12);
    assert.ok(text.includes("FMT:ok max=50"), "записи не отформатированы: " + text);
    assert.ok(text.includes("12 ч") && text.includes("default"), "в ответе нет окна времени/группы: " + text);

    // Без каталога запрос не уходит — сразу понятная ошибка.
    await assert.rejects(() => ok.api.readYcLogsText({ oauth: "y", folderId: "" }, "", "id", {}), /каталог/);

    // Пустые логи — честное «логов нет», а не пустая строка.
    const empty = mkApi({ logGroupId: "g", logGroupName: "", entries: [] });
    const emptyText = await empty.api.readYcLogsText({ oauth: "y", folderId: "f" }, "", "id", {});
    assert.ok(/Логов за последние 3 ч нет/.test(emptyText), "сообщение: " + emptyText);
  });

  // ── Адреса Cloud Logging разведены: REST-группы ≠ gRPC-чтение ──────────────
  await test("yc-logs: чтение идёт на log-reading, группы — на logging (это два разных хоста)", async () => {
    assert.ok(
      /"log-reading": "https:\/\/reader\.logging\.yandexcloud\.net"/.test(ycSrc),
      "в KNOWN_ENDPOINTS нет log-reading — при недоступном каталоге читать логи нечем"
    );
    assert.ok(/"log-ingestion": "https:\/\/ingester\.logging\.yandexcloud\.net"/.test(ycSrc), "нет log-ingestion");

    // Живой gRPC-сервер отвечает только за «чтение», а список групп приходит из
    // ПОДСТАВНОГО REST (другой адрес) — если бы код послал gRPC на REST-хост, чтения не было бы.
    const resource = Buffer.concat([ycLogs.pbString(1, "serverless.container"), ycLogs.pbString(2, "cont-7")]);
    const entry = Buffer.concat([ycLogs.pbString(1, "u"), ycLogs.pbMessage(2, resource), ycLogs.pbInt(6, 3), ycLogs.pbString(7, "log line")]);
    const respBuf = Buffer.concat([ycLogs.pbString(1, "grp"), ycLogs.pbMessage(2, entry)]);
    let seenAuthority = "";
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      seenAuthority = String(headers[":authority"] || "");
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(respBuf.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, respBuf]));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    let restUrl = "";
    try {
      const res = await ycLogs.readLogs({
        iamToken: "t",
        baseUrl: "https://logging.api.cloud.yandex.net",
        grpcBaseUrl: "http://127.0.0.1:" + port,
        folderId: "folder-1",
        limit: 5,
        fetchImpl: async (u) => {
          restUrl = String(u);
          return { ok: true, status: 200, text: async () => JSON.stringify({ groups: [{ id: "grp", name: "default" }] }) };
        },
      });
      assert.ok(restUrl.startsWith("https://logging.api.cloud.yandex.net/logging/v1/logGroups"), "группы ушли не на REST-хост: " + restUrl);
      assert.strictEqual(seenAuthority, "127.0.0.1:" + port, "gRPC ушёл не на grpcBaseUrl: " + seenAuthority);
      assert.strictEqual(res.entries.length, 1);
      assert.strictEqual(res.entries[0].message, "log line");
    } finally {
      await new Promise((r) => server.close(r));
    }

    // Известен id группы — REST-запрос за списком не нужен вовсе.
    let restCalls = 0;
    const srv2 = http2.createServer();
    srv2.on("stream", (stream) => {
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(respBuf.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, respBuf]));
    });
    await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
    try {
      const res2 = await ycLogs.readLogs({
        iamToken: "t",
        baseUrl: "https://logging.api.cloud.yandex.net",
        grpcBaseUrl: "http://127.0.0.1:" + srv2.address().port,
        folderId: "f",
        logGroupId: "grp-known",
        fetchImpl: async () => {
          restCalls++;
          return { ok: true, status: 200, text: async () => "{}" };
        },
      });
      assert.strictEqual(restCalls, 0, "лишний REST-запрос при известном id группы");
      assert.strictEqual(res2.logGroupId, "grp-known");
      assert.strictEqual(res2.entries.length, 1);
    } finally {
      await new Promise((r) => srv2.close(r));
    }
  });

  await test("yc: catalog не ждётся — первый запрос уходит сразу, каталог догружается в фоне", async () => {
    const realFetch = global.fetch;
    try {
      // Каталог эндпоинтов «висит» — адрес всё равно должен вернуться мгновенно.
      global.fetch = () => new Promise(() => {});
      const t0 = Date.now();
      const guard = () => new Promise((r) => setTimeout(() => r("__timeout__"), 1500));
      const addr = await Promise.race([yc.endpoint("log-reading"), guard()]);
      const ms = Date.now() - t0;
      assert.strictEqual(addr, "https://reader.logging.yandexcloud.net", "адрес: " + addr);
      assert.ok(ms < 600, "endpoint ждал сеть " + ms + " мс");
      // Второй сервис из выверенного списка тоже отдаётся мгновенно.
      const addr2 = await Promise.race([yc.endpoint("log-ingestion"), guard()]);
      assert.strictEqual(addr2, "https://ingester.logging.yandexcloud.net", "адрес: " + addr2);
      // Адрес сервиса, которого нет в KNOWN, и правда требует каталога — в этом и
      // смысл фолбэка, поэтому такой id здесь не проверяем (сеть подделана «висящей»).
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("yc: в env идёт свежий IAM (YC_IAM_TOKEN/YC_TOKEN), OAuth туда не попадает", async () => {
    // Проверяем ЖИВОЙ модуль, а не текст: окружение агента вынесено в src/agent-env.js
    // (часть 22), и снимок IAM живёт внутри него. Подменяем только то, что модуль
    // получает снаружи: служебный слой облака, журнал и мост к системному разделу.
    const { createAgentEnv } = require(path.join(ROOT, "src", "agent-env.js"));
    const toolPolicy = require(path.join(ROOT, "src", "tool-policy.js"));
    const cfg = { oauth: "OAUTH-SECRET", cloudId: "b1g", folderId: "f1" };
    const mk = (info) =>
      createAgentEnv({
        toolPolicy,
        audit: { setSecrets() {} },
        app: { getPath: () => os.tmpdir() },
        path,
        yandexCloud: { getIamTokenInfo: async () => info },
        ycCli: { binDir: () => "" },
        live: {
          getYcConfig: () => (s) => s,
          envPathInfo: () => ({ value: "" }),
          setMergedPath: () => "",
        },
      });
    // Обмен OAuth→IAM идёт в фоне (команды из-за токена не стоят) — даём микрозадачам
    // дойти до конца, иначе проверили бы пустой снимок.
    const settle = async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    };

    // 1. Снимка IAM ещё нет — переменных с токеном нет вовсе (раньше сюда попадал OAuth).
    const fresh = mk({ token: "IAM-FRESH", expiresAtMs: Date.now() + 3600 * 1000 });
    const before = fresh.ycAutoEnv(cfg);
    assert.strictEqual(before.YC_CLOUD_ID, "b1g");
    assert.strictEqual(before.YC_FOLDER_ID, "f1");
    assert.ok(!("YC_TOKEN" in before), "OAuth утёк в YC_TOKEN");
    assert.ok(!("YC_IAM_TOKEN" in before), "пустой IAM попал в env");

    // 2. После обмена OAuth→IAM свежий токен идёт в ОБА имени и доезжает до команды.
    await fresh.applyAgentEnv({ ...cfg, agentEnv: { MY_KEY: "v" }, agentEnvScopes: {} });
    await settle();
    const after = fresh.ycAutoEnv(cfg);
    assert.strictEqual(after.YC_IAM_TOKEN, "IAM-FRESH");
    assert.strictEqual(after.YC_TOKEN, "IAM-FRESH");
    assert.strictEqual(fresh.ycIamEnvToken(cfg), "IAM-FRESH");
    assert.strictEqual(fresh.envFor("terminal.execute").YC_IAM_TOKEN, "IAM-FRESH", "токен не доехал до окружения команды");
    // Тот же свежий снимок, но спрошенный от ДРУГОГО аккаунта: чужой IAM в окружение
    // не уходит. Проверка изолирует счёт снимка — ветка смены аккаунта в ycIamSync
    // обнуляет снимок сама и эту ошибку скрыла бы.
    const foreign = fresh.ycAutoEnv({ oauth: "ДРУГОЙ", cloudId: "b1g", folderId: "f1" });
    assert.ok(!("YC_IAM_TOKEN" in foreign) && !("YC_TOKEN" in foreign), "токен чужого аккаунта ушёл в окружение");
    assert.strictEqual(fresh.ycIamEnvToken({ oauth: "ДРУГОЙ" }), "", "чужому аккаунту отдан снимок IAM");

    // 3. Просроченный IAM не подставляем (yc CLI сказал бы «The token is invalid»).
    const old = mk({ token: "IAM-OLD", expiresAtMs: Date.now() - 1000 });
    await old.applyAgentEnv({ ...cfg });
    await settle();
    assert.strictEqual(old.ycIamEnvToken(cfg), "", "просроченный IAM считается живым");
    assert.ok(!("YC_IAM_TOKEN" in old.ycAutoEnv(cfg)), "просроченный IAM ушёл в env");

    // 4. Сменили OAuth-аккаунт — снимок прошлого аккаунта не переиспользуем ни одной командой.
    const other = mk({ token: "IAM-FIRST", expiresAtMs: Date.now() + 3600 * 1000 });
    await other.applyAgentEnv({ ...cfg });
    await settle();
    assert.strictEqual(other.ycIamEnvToken(cfg), "IAM-FIRST");
    await other.applyAgentEnv({ oauth: "ДРУГОЙ", cloudId: "b1g", folderId: "f1" });
    await settle();
    assert.strictEqual(other.ycIamEnvToken(cfg), "", "токен чужого аккаунта остался в окружении");
    assert.ok(!("YC_IAM_TOKEN" in other.ycAutoEnv(cfg)), "токен чужого аккаунта ушёл в команду");
  });

  await test("yc: ycInstall пересобирает окружение, а токен продлевается заранее", () => {
    // Окружение агента и продление IAM живут в src/agent-env.js (часть 22);
    // пересборка после установки yc CLI — в обработчике инструмента (agent-tools).
    const envSrc = fs.readFileSync(path.join(ROOT, "src", "agent-env.js"), "utf8");
    assert.ok(
      /applyAgentEnv\(loadSettings\(\)\);\n          const iamReady/.test(backendSrc()),
      "после установки yc CLI окружение не пересобирается"
    );
    assert.ok(/applyAgentEnv\(loadSettings\(\)\)/.test(backendSrc()), "нет пересборки окружения в ycInstall");
    assert.ok(/getIamTokenInfo\(cfg\.oauth\)/.test(envSrc), "слой окружения не берёт срок жизни IAM");
    assert.ok(/YC_IAM_REFRESH_MARGIN = 5 \* 60 \* 1000/.test(envSrc), "нет запаса на продление IAM");
    assert.ok(/ycIamTimer\.unref/.test(envSrc), "таймер продления держит процесс");
    assert.ok(/Date\.now\(\) - ycIamLastTryTs < 60 \* 1000/.test(envSrc), "нет ограничения частоты обращений к IAM");
    // Тексты (промпт и интерфейс) больше не обещают YC_TOKEN как OAuth.
    assert.ok(/YC_IAM_TOKEN — свежий IAM/.test(coreSrc), "промпт не упоминает YC_IAM_TOKEN");
    assert.ok(!/автоматически \(YC_TOKEN \/ YC_CLOUD_ID/.test(coreSrc), "в промпте остался старый текст про YC_TOKEN");
  });

  await test("yc: Postbox спрашивается как SES v2 (путь, заголовок, диагностика 403)", async () => {
    const pb = yc.serviceByKey("postbox");
    assert.strictEqual(pb.listPath, "/v2/email/identities", "Postbox: неверный путь (был выдуманный /postbox/v1/addresses)");
    assert.strictEqual(pb.listKey, "Identities");
    assert.strictEqual(pb.auth, "subject");
    assert.strictEqual(pb.query, "ses");
    assert.strictEqual(yc.serviceQuery(pb, "folder1"), "?PageSize=100", "SES не понимает folderId/pageSize");

    const realFetch = global.fetch;
    try {
      let seenUrl = "";
      let seenHeaders = {};
      const iamJson = () => ({ iamToken: "t", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      global.fetch = makeFetch((url, opts) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamJson() };
        seenUrl = String(url);
        seenHeaders = (opts && opts.headers) || {};
        return { body: { Identities: ["mail.example.ru"] } };
      });
      yc.resetIamCache();
      const r = await yc.listService("oauth", "folder1", pb);
      assert.strictEqual(r.count, 1, "адреса Postbox не разобрались: " + JSON.stringify(r.items));
      assert.strictEqual(r.items[0], "mail.example.ru");
      assert.ok(/^https:\/\/postbox\.cloud\.yandex\.net\/v2\/email\/identities\?PageSize=100$/.test(seenUrl), "URL: " + seenUrl);
      assert.strictEqual(seenHeaders["X-YaCloud-SubjectToken"], "t", "IAM не ушёл в X-YaCloud-SubjectToken");
      assert.ok(!seenHeaders.Authorization, "Postbox не принимает Authorization");

      // 403 объясняется причиной (нужен сервисный аккаунт), а не «Нет доступа».
      global.fetch = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamJson() };
        return { status: 403, body: { message: "Forbidden" } };
      });
      yc.resetIamCache();
      const err403 = await yc.listService("oauth", "f1", pb).then(() => null, (e) => e);
      assert.ok(err403 && /сервисн[а-яё]*\s+аккаунт/i.test(err403.message), "непонятная ошибка: " + (err403 && err403.message));
      assert.ok(/postbox\.viewer/.test(err403.message), "нет роли в подсказке: " + err403.message);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("ycContainer: пустой контейнер и границы сервиса не ломают сводку", () => {
    // Контейнер без ревизий: сводка пустой ревизии должна быть безопасной.
    const s = yc.revisionSummary(undefined);
    assert.strictEqual(s.image, "");
    assert.deepStrictEqual(s.secrets, []);
    assert.deepStrictEqual(s.mounts, []);
    assert.strictEqual(s.timeoutSec, null);
    // Неизвестная длительность не превращается в NaN.
    assert.strictEqual(yc.revisionSummary({ executionTimeout: "не время" }).timeoutSec, null);
  });


  // ── Глубокий слой Serverless Containers: обзор → редактор → ревизии ────────
  // Фикстура — ровно тот Revision, который отдаёт Container.GetRevision.
  const REV = {
    id: "bba5rev1",
    containerId: "c1",
    description: "release 1",
    createdAt: "2026-09-10T10:00:00Z",
    image: {
      imageUrl: "cr.yandex/cr1/api:latest",
      imageDigest: "sha256:abc",
      command: { command: ["node", "server.js"] },
      args: { args: ["--port", "8080"] },
      environment: { NODE_ENV: "production", LOG_LEVEL: "info" },
      workingDir: "/app",
    },
    resources: { memory: String(256 * 1024 * 1024), cores: "1", coreFraction: "100" },
    executionTimeout: "30s",
    concurrency: "4",
    serviceAccountId: "aje1",
    status: "ACTIVE",
    connectivity: { networkId: "enp1" },
    provisionPolicy: { minInstances: "1" },
    secrets: [{ id: "e6q1", versionId: "v1", key: "DB_PASS", environmentVariable: "DB_PASSWORD" }],
    logOptions: { folderId: "b1", minLevel: "INFO" },
    scalingPolicy: { zoneInstancesLimit: "5", zoneRequestsLimit: "0" },
    storageMounts: [{ bucketId: "static-bucket", prefix: "assets", readOnly: true, mountPointPath: "/static" }],
    mounts: [{ mountPointPath: "/data", mode: "READ_WRITE", objectStorage: { bucketId: "data-bucket", prefix: "" } }],
    runtime: { task: {} },
  };

  await test("ycContainer: сводка ревизии переводит байты, длительность и режим в человеческий вид", () => {
    const s = yc.revisionSummary(REV);
    assert.strictEqual(s.id, "bba5rev1");
    assert.strictEqual(s.status, "ACTIVE");
    assert.strictEqual(s.image, "cr.yandex/cr1/api:latest");
    assert.strictEqual(s.memoryMb, 256, "байты должны стать мегабайтами");
    assert.strictEqual(s.cores, 1);
    assert.strictEqual(s.coreFraction, 100);
    assert.strictEqual(s.timeoutSec, 30, "duration 30s → секунды");
    assert.strictEqual(s.concurrency, 4);
    assert.deepStrictEqual(s.command, ["node", "server.js"]);
    assert.deepStrictEqual(s.args, ["--port", "8080"]);
    assert.strictEqual(s.workingDir, "/app");
    assert.strictEqual(s.env.NODE_ENV, "production", "переменные окружения ревизии потерялись");
    assert.strictEqual(s.serviceAccountId, "aje1");
    assert.strictEqual(s.networkId, "enp1");
    assert.strictEqual(s.minInstances, 1);
    assert.strictEqual(s.maxInstancesPerZone, 5);
    assert.strictEqual(s.secrets[0].environmentVariable, "DB_PASSWORD");
    assert.strictEqual(s.logDisabled, false);
    assert.strictEqual(s.logMinLevel, "INFO");
    assert.strictEqual(s.storageMounts[0].path, "/static");
    assert.strictEqual(s.storageMounts[0].readOnly, true);
    assert.strictEqual(s.mounts[0].path, "/data");
    assert.strictEqual(s.mounts[0].mode, "READ_WRITE");
    assert.strictEqual(s.mounts[0].bucketId, "data-bucket");
    assert.strictEqual(s.runtime, "task", "режим task не распознан");
    // Пустая ревизия не должна ничего ломать (контейнер ещё не деплоился).
    const empty = yc.revisionSummary(null);
    assert.strictEqual(empty.id, "");
    assert.strictEqual(empty.runtime, "http");
    assert.deepStrictEqual(empty.env, {});
  });

  await test("ycContainer: префилл «Создать ревизию» берёт настройки активной и не теряет переменные", () => {
    const base = yc.revisionToDeployOpts(REV, {});
    assert.strictEqual(base.imageUrl, "cr.yandex/cr1/api:latest", "образ должен подставляться из ревизии");
    assert.strictEqual(base.memoryMb, 256);
    assert.strictEqual(base.cores, 1);
    assert.strictEqual(base.timeoutSec, 30);
    assert.strictEqual(base.concurrency, 4);
    assert.strictEqual(base.serviceAccountId, "aje1");
    assert.strictEqual(base.networkId, "enp1");
    assert.strictEqual(base.workingDir, "/app");
    assert.strictEqual(base.runtime, "task");
    assert.strictEqual(base.storageMounts.length, 1);
    assert.strictEqual(base.mounts.length, 1);
    assert.deepStrictEqual(base.env, { NODE_ENV: "production", LOG_LEVEL: "info" });

    // Переменные ДОБАВЛЯЮТСЯ к прежним, переданное побеждает.
    const merged = yc.revisionToDeployOpts(REV, { env: { NODE_ENV: "staging", EXTRA: "1" } });
    assert.deepStrictEqual(merged.env, { NODE_ENV: "staging", LOG_LEVEL: "info", EXTRA: "1" });

    // envReplace: true — набор заменяется целиком (старые переменные не остаются).
    const replaced = yc.revisionToDeployOpts(REV, { env: { ONLY: "1" }, envReplace: true });
    assert.deepStrictEqual(replaced.env, { ONLY: "1" });

    // Переопределения сильнее префилла.
    const over = yc.revisionToDeployOpts(REV, { memoryMb: 512, cores: 2, image: undefined, imageUrl: "cr.yandex/cr1/api:v2" });
    assert.strictEqual(over.memoryMb, 512);
    assert.strictEqual(over.cores, 2);
    assert.strictEqual(over.imageUrl, "cr.yandex/cr1/api:v2");

    // Первая ревизия контейнера: префилла нет, образ обязателен.
    const first = yc.revisionToDeployOpts(null, {});
    assert.ok(!first.imageUrl, "без префилла образ должен остаться пустым — его спросит инструмент");
    assert.strictEqual(first.memoryMb, 256, "нужны разумные значения по умолчанию");
  });

  await test("ycContainer: запрос ревизии несёт ресурсы, команду, сеть, секреты и режим task", async () => {
    const realFetch2 = global.fetch;
    const seen = { url: "", body: null };
    try {
      global.fetch = makeFetch((url, opts) => {
        const u = String(url);
        if (u.includes("/endpoints")) return { body: {} };
        if (u.includes("/iam/v1/tokens")) return { body: { iamToken: "t", expiresAt: new Date(Date.now() + 3600e3).toISOString() } };
        if (u.includes(":deploy")) {
          seen.url = u;
          seen.body = JSON.parse((opts && opts.body) || "{}");
          return { body: { id: "op1", done: true } };
        }
        if (u.includes("/operations/")) return { body: { id: "op1", done: true } };
        return { body: {} };
      });
      yc.resetIamCache();
      await yc.deployContainerRevision("oauth", {
        containerId: "c1",
        folderId: "b1",
        imageUrl: "cr.yandex/cr1/api:latest",
        memoryMb: 256,
        cores: 2,
        coreFraction: 20, // у многоядерной ревизии сервис принимает только 100%
        timeoutSec: 45,
        concurrency: 5,
        env: { A: "1" },
        command: ["node", "server.js"],
        args: ["--port", "8080"],
        workingDir: "/app",
        networkId: "enp1",
        minInstances: 1,
        secrets: [{ id: "e6q1", key: "DB_PASS", environmentVariable: "DB_PASSWORD" }, { id: "broken" }],
        storageMounts: [{ bucketId: "static-bucket", prefix: "assets", readOnly: true, mountPointPath: "/static" }],
        mounts: [{ mountPointPath: "/data", mode: "read_write", bucketId: "data-bucket" }],
        runtime: "task",
        logMinLevel: "warn",
      });
      assert.ok(/\/containers\/v1\/revisions:deploy$/.test(seen.url), "URL деплоя: " + seen.url);
      assert.strictEqual(seen.body.containerId, "c1");
      assert.strictEqual(seen.body.resources.memory, String(256 * 1024 * 1024), "память уходит в байтах");
      assert.strictEqual(seen.body.resources.cores, "2");
      assert.strictEqual(seen.body.resources.coreFraction, "100", "доля ядра у многоядерной ревизии только 100%");
      assert.strictEqual(seen.body.executionTimeout, "45s");
      assert.strictEqual(seen.body.concurrency, "5");
      assert.deepStrictEqual(seen.body.imageSpec.environment, { A: "1" });
      assert.deepStrictEqual(seen.body.imageSpec.command, { command: ["node", "server.js"] });
      assert.deepStrictEqual(seen.body.imageSpec.args, { args: ["--port", "8080"] });
      assert.strictEqual(seen.body.imageSpec.workingDir, "/app");
      assert.deepStrictEqual(seen.body.connectivity, { networkId: "enp1" });
      assert.deepStrictEqual(seen.body.provisionPolicy, { minInstances: "1" });
      assert.strictEqual(seen.body.secrets.length, 1, "секрет без key/environmentVariable не должен уходить");
      assert.deepStrictEqual(seen.body.secrets[0], { id: "e6q1", key: "DB_PASS", environmentVariable: "DB_PASSWORD" });
      assert.strictEqual(seen.body.storageMounts[0].mountPointPath, "/static");
      assert.strictEqual(seen.body.storageMounts[0].readOnly, true);
      assert.strictEqual(seen.body.mounts[0].mode, "READ_WRITE", "режим монтирования приводится к верхнему регистру");
      assert.deepStrictEqual(seen.body.runtime, { task: {} });
      assert.strictEqual(seen.body.logOptions.minLevel, "WARN", "уровень логов приводится к верхнему регистру");
      assert.strictEqual(seen.body.logOptions.folderId, "b1");

      // Границы сервиса: таймаут не больше 600 с, память не меньше 128 МБ.
      seen.body = null;
      await yc.deployContainerRevision("oauth", { containerId: "c1", imageUrl: "cr.yandex/cr1/api:latest", timeoutSec: 9999, memoryMb: 64 });
      assert.strictEqual(seen.body.executionTimeout, "600s");
      assert.strictEqual(seen.body.resources.memory, String(128 * 1024 * 1024));
      // Без образа ревизию создавать нечем — ошибка должна быть понятной, без сети.
      const noImage = await yc.deployContainerRevision("oauth", { containerId: "c1" }).then(() => null, (e) => e);
      assert.ok(noImage && /образ/i.test(noImage.message), "нет понятной ошибки про образ: " + (noImage && noImage.message));
    } finally {
      global.fetch = realFetch2;
    }
  });

  await test("ycContainer: обзор, ревизии, правка и откат идут по верным адресам", async () => {
    const realFetch2 = global.fetch;
    const seen = [];
    try {
      global.fetch = makeFetch((url, opts) => {
        const u = String(url);
        const method = (opts && opts.method) || "GET";
        if (u.includes("/endpoints")) return { body: {} };
        if (u.includes("/iam/v1/tokens")) return { body: { iamToken: "t", expiresAt: new Date(Date.now() + 3600e3).toISOString() } };
        if (u.includes("/operations/")) return { body: { id: "op1", done: true } };
        seen.push({ url: u, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
        if (method === "GET" && u.includes("/containers/v1/containers/c1")) {
          return {
            body: { id: "c1", name: "api", url: "https://api.example", status: "ACTIVE", folderId: "b1", createdAt: "2026-09-01T00:00:00Z", description: "Прод", labels: { env: "prod" } },
          };
        }
        if (u.includes("/containers/v1/revisions?")) return { body: { revisions: [Object.assign({}, REV)] } };
        if (method === "GET" && /\/containers\/v1\/revisions\/[^:?]+$/.test(u)) return { body: Object.assign({}, REV) };
        return { body: {} };
      });
      yc.resetIamCache();
      const cont = await yc.getContainer("oauth", "c1");
      assert.strictEqual(cont.url, "https://api.example");
      assert.strictEqual(cont.labels.env, "prod", "метки контейнера потерялись");
      const revs = await yc.listRevisions("oauth", { containerId: "c1", pageSize: 100 });
      assert.strictEqual(revs.length, 1);
      assert.strictEqual(revs[0].id, "bba5rev1");
      const rev = await yc.getRevision("oauth", "bba5rev1");
      assert.strictEqual(rev.containerId, "c1");
      const upd = await yc.updateContainer("oauth", "c1", { description: "Прод API" });
      assert.strictEqual(upd.name, "api");
      await yc.rollbackContainer("oauth", "c1", "bba5rev1");

      const listUrl = seen.find((s) => s.url.includes("/revisions?")).url;
      assert.ok(/\/containers\/v1\/revisions\?containerId=c1&pageSize=100$/.test(listUrl), "список ревизий: " + listUrl);
      const revUrl = seen.find((s) => s.url.includes("/revisions/bba5rev1")).url;
      assert.ok(/\/containers\/v1\/revisions\/bba5rev1$/.test(revUrl), "детали ревизии: " + revUrl);
      const patch = seen.find((s) => s.method === "PATCH");
      assert.ok(patch && /\/containers\/v1\/containers\/c1$/.test(patch.url), "PATCH контейнера: " + (patch && patch.url));
      assert.strictEqual(patch.body.updateMask, "description", "маска должна перечислять только изменяемые поля");
      assert.strictEqual(patch.body.description, "Прод API");
      assert.ok(!("name" in patch.body) && !("labels" in patch.body), "неизменяемые поля не должны уходить в запрос — иначе сервис их сбросит");
      const rb = seen.find((s) => /:rollback$/.test(s.url));
      assert.ok(rb && rb.method === "POST", "откат — это POST :rollback");
      assert.deepStrictEqual(rb.body, { revisionId: "bba5rev1" });
      // Пустая правка — понятная ошибка, а не молчаливый PATCH без маски.
      const noPatch = await yc.updateContainer("oauth", "c1", {}).then(() => null, (e) => e);
      assert.ok(noPatch && /нечего менять/i.test(noPatch.message), "нет понятной ошибки про пустую правку");
    } finally {
      global.fetch = realFetch2;
    }
  });

  await test("ycContainer: инструмент, разрешение и интерфейс согласованы", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    assert.ok(names.includes("ycContainer"), "нет инструмента ycContainer");
    assert.ok(/ycContainer/.test(modelPrompt()), "в промпте нет ycContainer");
    const cloud = core.TOOL_GROUPS.find((g) => g.id === "cloud");
    assert.ok(cloud && cloud.names.includes("ycContainer"), "группа cloud не содержит ycContainer");
    const def = core.TOOL_DEFINITIONS.find((d) => d.function && d.function.name === "ycContainer");
    for (const a of ["overview", "revisions", "revision", "deploy", "rollback", "update"]) {
      assert.ok(def.function.description.includes(a), "в описании инструмента нет действия " + a);
    }
    assert.deepStrictEqual(def.function.parameters.required, ["action", "container"], "action и container обязательны");
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    assert.ok(/ycSetPermissions: \(allowCreate, allowDelete, allowUpdate, allowPublic\)/.test(preload), "preload не передаёт четвёртое разрешение");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(html.includes('id="s-yc-allow-update"'), "нет чекбокса «Разрешить агенту менять контейнеры»");
    // обработчики разрешений Yandex Cloud переехали в src/renderer/yc-panel.js (этап 2)
    const app = ["app.js", "yc-panel.js"]
      .map((f) => fs.readFileSync(path.join(ROOT, "src", "renderer", f), "utf8"))
      .join("\n");
    assert.ok(/s-yc-allow-update"\)\.onchange/.test(app), "интерфейс не слушает третий чекбокс");
    assert.ok(/api\.ycSetPermissions\(create, del, upd, pub\)/.test(app), "интерфейс не сохраняет четвёртое разрешение");
    const main = backendSrc();
    assert.ok(hasTool(main, "ycContainer"), "нет обработчика ycContainer");
    assert.ok(/allowUpdate \? "разрешено"/.test(main), "ycStatus не сообщает про право менять контейнеры");
    assert.ok(/ycAllowAgentUpdate: !!allowUpdate/.test(main), "IPC не сохраняет право менять контейнеры");
    assert.ok(
      /\(action === "deploy" \|\| action === "rollback" \|\| action === "update"\) && !cfg\.allowUpdate/.test(main),
      "нет гейта разрешения для deploy/rollback/update"
    );
    const guide = fs.readFileSync(path.join(ROOT, "src", "agent-guides", "yc.md"), "utf8");
    for (const a of ["overview", "revisions", "revision", "deploy", "rollback", "update"]) {
      assert.ok(guide.includes(a), "в справочнике yc.md нет действия " + a);
    }
    assert.ok(/удалить ревизию нельзя/i.test(guide), "в справочнике нет важного ограничения: ревизию удалить нельзя");
    // Ждём завершения операций без гарантированной паузы в 2 секунды.
    assert.ok(/let first = true;/.test(ycSrc), "waitOperation всё ещё спит перед первой проверкой");
  });
  await test("yc: сводка быстрее — короткий таймаут без повторов, облака и каталоги параллельно", () => {
    const ycSrc2 = fs.readFileSync(path.join(ROOT, "src", "yandex-cloud.js"), "utf8");
    assert.ok(
      /Object\.assign\(\{ timeoutMs: 12000, retries: 1 \}, opts \|\| \{\}\)/.test(ycSrc2),
      "у дашборда нет короткого таймаута по умолчанию"
    );
    // Последовательный вызов по-прежнему может себе позволить 2 попытки и 25 с.
    assert.ok(/o\.retries == null \? 2 :/.test(ycSrc2), "сломан запасной путь с повторами");
    assert.ok(/async function retryNet\(fn, tries\)/.test(ycSrc2), "нет повторов для облаков/каталогов");
    assert.ok(/listClouds\(cfg\.oauth\);\n    const foldersP = cfg\.cloudId/.test(mainSrc), "облака и каталоги по-прежнему последовательны");
    assert.ok(/await yandexCloud\.getIamToken\(cfg\.oauth\);\n    const cloudsP/.test(mainSrc), "обмен токена не вынесен до параллельных запросов");
    // Каталог эндпоинтов не тормозит запуск.
    assert.ok(/if \(known\) \{\n    primeEndpoints\(\);\n    return known;/.test(ycSrc2) === false || /primeEndpoints\(\)/.test(ycSrc2), "нет фонового прогрева каталога");
    assert.ok(/PRIME_MIN_INTERVAL/.test(ycSrc2), "нет ограничения на частые обращения к каталогу");
  });

}

// ── Каталог Yandex Cloud: сохранение настроек не должно его стирать ────────
// Симптом: интерфейс каталог видит, а агент — нет; помогало «обновить и сохранить»
// дважды. Причина: объект настроек интерфейса, загруженный ДО автовыбора каталога,
// при сохранении приносил пустой ycFolderId и стирал выбор в main.
async function testYcFolderPersistence() {
  const mainSrc = backendSrc();
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  // Панель Yandex Cloud вынесена в отдельный модуль (этап 2 разбора app.js):
  // проверки интерфейса читают оба файла, а appSrc остаётся строго про app.js.
  const uiSrc = appSrc + "\n" + fs.readFileSync(path.join(ROOT, "src", "renderer", "yc-panel.js"), "utf8");

  const a = mainSrc.indexOf('ipcMain.handle("settings:set"');
  // Границы среза — сам обработчик до следующего канала: раньше конец искали
  // дословной строкой, и любая правка в теле (маска секретов, проверка
  // отправителя) ломала проверку не по делу.
  const b = a < 0 ? -1 : mainSrc.indexOf('ipcMain.handle("', a + 10);
  const e = b < 0 ? mainSrc.length : b;
  assert.ok(a > 0 && e > a, "не нашёл обработчик settings:set в main.js");
  const code = mainSrc.slice(a, e);

  const prevSettings = {
    workingDir: "/proj",
    ycFolderId: "b1g2folder",
    ycFolderName: "prod",
    ycCloudId: "b1g2cloud",
    ycAllowAgentCreate: false,
    ycAllowAgentDelete: false,
    sitePasswords: [{ id: "a" }],
    mailPassword: "secret",
  };
  let handle = null;
  const saved = [];
  let repoDirReset = 0;
  // Рядом с обработчиком в модуле стоят ещё две вещи: отказ чужому рендереру и
  // маска секретов (src/settings-ipc.js, src/secret-mask.js). В этом стенде
  // клиент — окно на ПК, поэтому отказов нет и маски нет; сама маска проверяется
  // отдельно (test/secret-mask.test.js).
  const deniedFor = () => null;
  const maskedFor = () => false;
  const secretMask = require(path.join(ROOT, "src", "secret-mask.js"));
  new Function(
    "ipcMain", "loadSettings", "normalizeSettings", "applyAgentEnv",
    "applyBrowserSettings", "saveSettings", "mobileBridge", "live",
    "deniedFor", "maskedFor", "secretMask",
    code
  )(
    { handle: (ch, cb) => { handle = cb; } },
    () => ({ ...prevSettings }),
    (x) => ({ ...x }),
    () => {},
    () => {},
    (x) => { saved.push(x); },
    { applySettings: () => {} },
    // Сброс «активного репозитория» при смене рабочей папки: код уехал в
    // src/settings-ipc.js (часть 30) и делает это СЕТТЕРОМ моста — переменная
    // принадлежит оболочке (её читают пути-и-git, GitHub-каналы и инструменты),
    // и копия значения «застыла» бы.
    { setLastAgentRepoDir: () => { repoDirReset++; } },
    deniedFor,
    maskedFor,
    secretMask
  );
  assert.strictEqual(typeof handle, "function", "обработчик settings:set не зарегистрировался");

  await test("настройки: сохранение из интерфейса не стирает каталог Yandex Cloud", () => {
    // Ровно тот случай, из-за которого агент видел «каталог не выбран»:
    // интерфейс присылает свой устаревший объект с пустыми yc-полями.
    const merged = handle(null, {
      workingDir: "/proj",
      ycFolderId: "",
      ycFolderName: "",
      ycCloudId: "",
      ycAllowAgentCreate: true,
      someOther: 1,
    });
    assert.strictEqual(merged.ycFolderId, "b1g2folder", "каталог стёрт сохранением настроек");
    assert.strictEqual(merged.ycFolderName, "prod", "имя каталога стёрто");
    assert.strictEqual(merged.ycCloudId, "b1g2cloud", "облако стёрто");
    assert.strictEqual(merged.someOther, 1, "обычные поля должны сохраняться");
    // Разрешения агента менять можно — они есть в форме
    assert.strictEqual(merged.ycAllowAgentCreate, true, "разрешение агента не применилось");
    // Защита паролей/почты осталась на месте
    assert.deepStrictEqual(merged.sitePasswords, [{ id: "a" }], "sitePasswords затёрты");
    assert.strictEqual(merged.mailPassword, "secret", "mailPassword затёрт");
    // Устаревший, но НЕпустой каталог тоже не должен перебивать актуальный
    const merged2 = handle(null, { ycFolderId: "old-folder", ycFolderName: "old", ycCloudId: "old-cloud" });
    assert.strictEqual(merged2.ycFolderId, "b1g2folder", "устаревший каталог перебил актуальный");
    // И записано это в настройки, а не только возвращено
    assert.strictEqual(saved[saved.length - 1].ycFolderId, "b1g2folder", "в файл ушёл стёртый каталог");
  });

  await test("настройки: актуальный Yandex Cloud попадает в САММАРИ проекта, UI держит синхрон", () => {
    assert.ok(/function ycBriefLine\(s\)/.test(mainSrc), "нет ycBriefLine");
    assert.ok(/const ycLine = ycBriefLine\(loadSettings\(\)\)/.test(mainSrc), "YC-строка читает не свежие настройки");
    assert.ok(/parts\.push\(ycLine\)/.test(mainSrc), "строка YC не попадает в САММАРИ проекта");
    assert.ok(/Yandex Cloud: каталог «/.test(mainSrc), "нет формулировки про каталог");
    assert.ok(/каталог НЕ выбран/.test(mainSrc), "нет строки для случая «каталог не выбран»");
    assert.ok(/getSettings\(\)\.ycFolderId = st\.folderId/.test(uiSrc), "интерфейс не синхронизирует каталог из статуса");
    assert.ok(/getSettings\(\)\.ycFolderId = sel\.value/.test(uiSrc), "интерфейс не синхронизирует каталог при выборе");
    // Инструменты по-прежнему читают свежие настройки, а не снимок начала ответа
    const ycCases = toolBody(mainSrc, "ycStatus", "ycInstall");
    assert.ok(/ycConfig\(loadSettings\(\)\)/.test(ycCases), "yc-инструменты читают устаревший снимок настроек");
  });

  await test("настройки: смена рабочей папки сбрасывает «активный репозиторий» через мост", () => {
    const before = repoDirReset;
    handle(null, { workingDir: "/proj2" });
    assert.strictEqual(repoDirReset, before + 1, "смена рабочей папки не сбросила папку агента");
    handle(null, { workingDir: "/proj" });
    assert.strictEqual(repoDirReset, before + 1, "папка агента сбрасывается без смены рабочей папки");
  });
}

// ── 1.66 консоль Yandex Cloud: карточка ресурса и связанные объекты ─────────
async function testYcConsole() {
  const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
  const c = require(path.join(ROOT, "src", "yc-console.js"));
  const NOW = new Date(2026, 8, 13, 12, 0, 0).getTime();

  await test("yc-консоль: подписи и значения полей читаются человеком, а не как JSON", () => {
    assert.strictEqual(c.labelFor("folderId"), "Каталог");
    assert.strictEqual(c.labelFor("v4CidrBlocks"), "Диапазоны IPv4");
    // Незнакомое поле не должно выглядеть как ключ API — только читаемо.
    assert.strictEqual(c.labelFor("someWeirdField"), "Some Weird Field");
    assert.strictEqual(c.formatField("mountType", true, NOW), "да");
    assert.strictEqual(c.formatField("mountType", false, NOW), "нет");
    assert.strictEqual(c.formatField("description", "", NOW), "");
    assert.strictEqual(c.formatField("labels", { env: "prod", team: "" }, NOW), "env: prod");
    assert.strictEqual(c.formatField("image", { imageUrl: "cr.yandex/cr1/api:2" }, NOW), "cr.yandex/cr1/api:2");
    assert.strictEqual(c.formatField("resources", { memory: 131072, cores: 2 }, NOW), "Память: 128 КБ · Ядра: 2");
    assert.strictEqual(c.formatField("v4CidrBlocks", ["10.0.0.0/24", "10.0.1.0/24"], NOW), "10.0.0.0/24, 10.0.1.0/24");
    // Локальное время, чтобы проверка не зависела от часового пояса машины.
    const created = c.formatField("createdAt", new Date(2026, 7, 1, 10, 0, 0).toISOString(), NOW);
    assert.ok(created.indexOf("01.08.2026 10:00") >= 0 && created.indexOf("назад") >= 0, "дата создания: " + created);
  });

  await test("yc-консоль: «3 дня назад» и размеры считаются без вранья", () => {
    const iso = (ms) => new Date(NOW - ms).toISOString();
    assert.strictEqual(c.humanAgo(iso(20 * 1000), NOW), "только что");
    assert.strictEqual(c.humanAgo(iso(5 * 60 * 1000), NOW), "5 мин назад");
    assert.strictEqual(c.humanAgo(iso(3 * 3600 * 1000), NOW), "3 ч назад");
    assert.strictEqual(c.humanAgo(iso(25 * 3600 * 1000), NOW), "вчера");
    assert.strictEqual(c.humanAgo(iso(5 * 86400 * 1000), NOW), "5 дн назад");
    assert.strictEqual(c.humanAgo(iso(-60 * 1000), NOW), "", "будущее не должно выглядеть «назад»");
    assert.strictEqual(c.humanAgo("мусор", NOW), "");
    assert.strictEqual(c.humanBytes(0), "0 Б");
    assert.strictEqual(c.humanBytes(512), "512 Б");
    assert.strictEqual(c.humanBytes(131072), "128 КБ");
    assert.strictEqual(c.humanBytes(134217728), "128 МБ");
    assert.strictEqual(c.humanBytes("2048"), "2 КБ");
    assert.strictEqual(c.humanBytes(-1), "", "отрицательный размер — не размер");
  });

  await test("yc-консоль: обзор ресурса — служебное скрыто, уточнение из карточки подмешано", () => {
    const item = {
      ok: true, error: "служебное", count: 5, items: [], title: "дубль",
      id: "net1", name: "default", createdAt: "2026-08-01T10:00:00Z",
      labels: { env: "prod" }, addresses: ["10.0.0.1"],
    };
    const built = c.buildFields("vpc", item, { defaultSecurityGroupId: "sg0", connectivity: { some: { deep: 1 } } }, NOW);
    const fields = built.fields;
    const labels = fields.map((f) => f.label);
    assert.deepStrictEqual(labels.slice(0, 2), ["Название", "Идентификатор"], "порядок полей: " + labels.join(", "));
    assert.ok(labels.indexOf("Ok") < 0 && labels.indexOf("Error") < 0 && labels.indexOf("Count") < 0, "служебное поле попало в карточку");
    assert.strictEqual((fields.find((f) => f.label === "Метки") || {}).value, "env: prod");
    assert.strictEqual((fields.find((f) => f.label === "Группа безопасности по умолчанию") || {}).value, "sg0", "уточнение из карточки не подмешалось");
    // Сложное поле не выдумывается строкой — уходит отдельным блоком.
    assert.ok(built.extra.some((x) => x.key === "connectivity"), "сложное поле потерялось: " + JSON.stringify(built.extra.map((x) => x.key)));
  });

  await test("yc-консоль: таблица связанных объектов — колонки по смыслу, пустое и сложное не ломают", () => {
    const subnets = c.buildTable("vpc", "subnets", [{ name: "app-subnet", zoneId: "ru-central1-a", v4CidrBlocks: ["10.0.0.0/24"], status: "READY" }], NOW);
    assert.strictEqual(subnets.columns.map((x) => x.label).join("|"), "Название|Зона|Диапазоны IPv4|Статус");
    assert.deepStrictEqual(subnets.rows[0], ["app-subnet", "ru-central1-a", "10.0.0.0/24", "READY"]);
    // Отсутствующее значение — прочерк, а не «undefined».
    const sparse = c.buildTable("vpc", "subnets", [{ name: "only-name" }], NOW);
    assert.strictEqual(sparse.rows[0][1], "—");
    // Образ — вложенный объект, а в таблице — адрес.
    const revs = c.buildTable("serverlessContainers", "revisions", [{ id: "rev1", status: "ACTIVE", createdAt: "2026-08-01T10:00:00Z", image: { imageUrl: "cr.yandex/cr1/api:2" } }], NOW);
    assert.ok(revs.rows[0].indexOf("cr.yandex/cr1/api:2") >= 0, "образ в таблице: " + JSON.stringify(revs.rows[0]));
    // Незнакомая связь: колонки выводятся из первой строки, без выдуманных полей.
    const guess = c.buildTable("vpc", "unknown", [{ status: "OK", name: "x", zoneId: "z", size: 2048, extra: { deep: 1 } }], NOW);
    assert.deepStrictEqual(guess.columns.map((x) => x.key), ["name", "status", "size", "zoneId"], "вывод колонок: " + guess.columns.map((x) => x.key).join(","));
  });

  await test("yc-консоль: реестр связей и возможностей согласован с сервисами и yandex-cloud.js", () => {
    const serviceKeys = yc.SERVICES.map((s) => s.key).sort();
    assert.deepStrictEqual(c.capabilities().map((x) => x.serviceKey).sort(), serviceKeys, "консоль и дашборд видят разные сервисы");
    for (const key of Object.keys(c.RELATIONS)) {
      assert.ok(serviceKeys.indexOf(key) >= 0, "связи для неизвестного сервиса: " + key);
      for (const r of c.RELATIONS[key]) {
        assert.ok(r.key && r.title, "у связи нет ключа или подписи");
        // Способ запроса объявлен ВСЕГДА: либо формы пути консольного API, либо
        // свой протокол у связи (s3 — объекты бакета, docApi — таблицы базы YDB).
        const special = r.s3 === true || r.docApi === true;
        assert.ok(Array.isArray(r.attempts), "варианты запроса не массив: " + key + ":" + r.key);
        assert.ok(special || r.attempts.length > 0, "связь без способа запроса: " + key + ":" + r.key);
        for (const a of r.attempts) {
          assert.strictEqual(typeof a.path, "function", "вариант без пути: " + key + ":" + r.key);
          assert.ok(String(a.path({ id: "r1", folderId: "f1" })).startsWith("/"), "путь не от корня: " + key + ":" + r.key);
        }
      }
    }
    for (const key of Object.keys(c.DETAIL_PATHS)) {
      assert.ok(String(c.DETAIL_PATHS[key]({ id: "r1" })).startsWith("/"), "путь карточки не от корня: " + key);
    }
    assert.deepStrictEqual(c.capabilities().find((x) => x.serviceKey === "vpc").relations.map((r) => r.title), ["Подсети", "Группы безопасности", "Таблицы маршрутизации"]);
    assert.ok(c.capabilities().find((x) => x.serviceKey === "serverlessContainers").relations.some((r) => r.key === "revisions"));
    assert.ok(c.RELATIONS.ydb.some((r) => r.key === "tables" && r.docApi === true), "у таблиц базы YDB не объявлен свой способ запроса (docApi)");
  });
}

async function testYcCosts() {
  const costs = require(path.join(ROOT, "src", "yc-costs.js"));
  const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
  const engine = require(path.join(ROOT, "src", "deploy-engine.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const mainSrc = backendSrc();

  await test("стоимость: формула контейнера совпадает с примерами из документации", () => {
    const doc = costs.containerCost({ memoryMb: 2048, cores: 0.2, calls: 3000000, msPerCall: 150 });
    assert.strictEqual(doc.total, 1061.34, "первый пример расчёта из документации");
    const doc2 = costs.containerCost({ memoryMb: 2048, cores: 1, calls: 3000000, msPerCall: 150 });
    assert.strictEqual(doc2.total, 1630.34, "второй пример расчёта из документации");
  });

  await test("стоимость: бесплатный пакет учитывается, дорогое видно заранее", () => {
    const est = costs.estimateContainerConfig({});
    const quiet = est.scenarios.find((x) => /тихий/.test(x.title));
    const busy = est.scenarios.find((x) => /живой/.test(x.title));
    const idle = est.scenarios.find((x) => /круглосуточно/.test(x.title));
    assert.strictEqual(quiet.cost.total, 0, "100 тыс. вызовов в месяц — в пределах бесплатного пакета");
    assert.ok(busy.cost.total > 100, "живой сайт должен показывать реальную цифру: " + busy.cost.total);
    assert.ok(idle.cost.total > busy.cost.total, "круглосуточная работа дороже вызовов по запросу");
    assert.strictEqual(est.needsConfirm, true, "платную ревизию нельзя создавать без согласия");
    assert.strictEqual(est.pricedAt, costs.PRICED_AT, "у оценки должна быть дата тарифов");
  });

  await test("стоимость: ресурсы считаются по тарифам, а не на глаз", () => {
    assert.strictEqual(costs.estimate("storage", { gb: 0.5 }).approxMonth, 0, "первый гигабайт бесплатен");
    assert.strictEqual(costs.estimate("storage", { gb: 23 }).approxMonth, 52.27, "23 ГБ — как в примере документации");
    assert.strictEqual(costs.estimate("lockbox", {}).approxMonth, 19.73, "версия секрета: 720 × 0,0274 ₽");
    assert.strictEqual(costs.estimate("dns", {}).approxMonth, 42.62, "зона DNS: 0,0592 ₽ × 720 ч");
    assert.ok(costs.estimate("containerRegistry", { gb: 5 }).approxMonth < 20, "реестр на 5 ГБ — копейки");
  });

  await test("стоимость: где тариф не подтверждён — цифры нет, есть ссылка", () => {
    const ydb = costs.estimate("ydb", {});
    assert.strictEqual(ydb.approxMonth, null, "цену за RU не подтверждали — не выдумываем число");
    assert.ok(/pricing/.test(ydb.source), "должна быть ссылка на тарифы сервиса");
    assert.strictEqual(ydb.calculator, costs.CALCULATOR, "и ссылка на калькулятор");
    const vpc = costs.estimate("vpc", {});
    assert.strictEqual(vpc.level, "free", "сеть и подсети не тарифицируются");
    assert.strictEqual(vpc.needsConfirm, false, "бесплатное не должно требовать согласия");
  });

  await test("стоимость: у каждого создаваемого ресурса есть оценка и текст", () => {
    const keys = yc.creatableKeys();
    const missing = keys.filter((k) => !costs.has(k));
    assert.deepStrictEqual(missing, [], "нет оценки стоимости для: " + missing.join(", "));
    const paid = keys.filter((k) => costs.needsConfirm(k));
    assert.strictEqual(paid.length, keys.length - 1, "всё платное требует согласия, бесплатна только сеть");
    for (const k of keys) {
      const text = costs.formatLines(costs.estimate(k, {})).join("\n");
      assert.ok(text.indexOf("undefined") === -1, k + ": в тексте оценки не должно быть undefined");
      assert.ok(text.indexOf(costs.CALCULATOR) !== -1, k + ": должна быть ссылка на калькулятор");
    }
  });

  await test("стоимость: параметры ревизии берутся из движка, а не из копии", () => {
    assert.ok(engine.REVISION_DEFAULTS && engine.REVISION_DEFAULTS.memoryMb > 0, "движок отдаёт параметры ревизии");
    const src = fs.readFileSync(path.join(ROOT, "src", "yc-costs.js"), "utf8");
    assert.ok(src.indexOf("REVISION_DEFAULTS") !== -1, "цены читают параметры из движка");
    const est = costs.estimateContainerConfig({});
    assert.strictEqual(est.memoryMb, engine.REVISION_DEFAULTS.memoryMb, "оценка считается по тем же 256 МБ");
    assert.strictEqual(est.cores, engine.REVISION_DEFAULTS.cores, "и по тому же 1 vCPU");
    const big = costs.estimateContainerConfig({ memoryMb: 1024, cores: 1 });
    assert.ok(big.scenarios[1].cost.total > est.scenarios[1].cost.total, "больше памяти — больше счёт");
  });

  await test("стоимость: агент видит инструмент, а платное создание идёт через согласие", () => {
    const names = (core.TOOL_DEFINITIONS || []).map((d) => (d && d.function && d.function.name) || "");
    assert.ok(names.includes("ycCosts"), "в схемах агента должен быть ycCosts");
    const ycCreate = (core.TOOL_DEFINITIONS || []).find((d) => d.function && d.function.name === "ycCreate");
    assert.ok(ycCreate && ycCreate.function.parameters.properties.confirm, "у ycCreate должно быть согласие confirm");
    assert.ok(mainSrc.includes('ipcMain.handle("yc:costs"'), "в приложении должен быть канал оценки стоимости");
    assert.ok(mainSrc.includes("⛔ Не создаю без согласия"), "агент не создаёт платное без согласия");
    assert.ok(mainSrc.includes("cost = ycCosts.estimateContainerConfig({})"), "панель получает стоимость до запуска");
  });

  await test("стоимость: про дорогое, что мы не создаём, сказано прямо", () => {
    const titles = costs.EXPENSIVE.map((e) => e.title).join(" ");
    assert.ok(/PostgreSQL|Kubernetes/.test(titles), "про managed-базы надо предупредить");
    assert.ok(/Виртуальная машина/.test(titles), "про ВМ 24/7 тоже");
    assert.strictEqual(costs.PRICED_AT.length > 0, true, "у тарифов должна быть дата");
  });
}

// ── Вынесенный Yandex Cloud: служебный слой и IPC-мост ──────────────────────
// Код переехал из main.js в yc-service.js и yc-ipc.js (1.5.74). Проверяем три
// вещи: в main.js его больше нет, модули работают сами (без Electron) и каналы
// IPC отвечают на своих моках — включая запрет создавать платное без согласия.
async function testYcSplit() {
  const main = mainOnlySrc(); // проверяем: в main.js этого больше нет
  const svcSrc = fs.readFileSync(path.join(ROOT, "src", "yc-service.js"), "utf8");
  const ipcSrc = fs.readFileSync(path.join(ROOT, "src", "yc-ipc.js"), "utf8");
  const { createYcService } = require(path.join(ROOT, "src", "yc-service.js"));
  const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));
  const costs = require(path.join(ROOT, "src", "yc-costs.js"));

  await test("Yandex Cloud: служебный слой и каналы вынесены из main.js", () => {
    const channels = [
      "yc:status", "yc:setToken", "yc:folders", "yc:setFolder", "yc:setPermissions",
      "yc:logout", "yc:console:overview", "yc:console:list", "yc:console:rollback", "yc:console:secretVersion", "yc:console:dnsRecord", "yc:console:registryImage", "yc:console:storageObject", "yc:console:bucketAccess",
      "yc:resources", "yc:costs", "yc:create", "yc:delete", "yc:logs",
      "yc:cliStatus", "yc:installCli", "yc:vpc", "yc:compute", "yc:iam", "yc:functions", "yc:billing", "yc:cdn",
    ];
    for (const ch of channels) {
      assert.ok(!main.includes('ipcMain.handle("' + ch + '"'), "канал остался в main.js: " + ch);
      assert.ok(ipcSrc.includes('ipcMain.handle("' + ch + '"'), "канал не найден в yc-ipc.js: " + ch);
    }
    const deploySrc = fs.readFileSync(path.join(ROOT, "src", "deploy-ipc.js"), "utf8");
    assert.ok(!main.includes('ipcMain.handle("yc:'), "каналов yc:* в main.js быть не должно");
    assert.ok(deploySrc.includes('ipcMain.handle("yc:deploy"'), "мост деплоя переехал в deploy-ipc.js");
    assert.ok(/const \{ runCloudDeploy, cloudDeployBrief \} = registerDeployIpc/.test(main), "main.js берёт запуск и сводку из моста");
    assert.ok(!/^function ycConfig\(/m.test(main), "ycConfig остался в main.js");
    assert.ok(/^function ycConfig\(/m.test(svcSrc), "ycConfig не найден в yc-service.js");
    assert.ok(!/^async function readYcLogsText\(/m.test(main), "чтение логов осталось в main.js");
    assert.ok(main.includes('require("./yc-service.js")') && main.includes('require("./yc-ipc.js")'), "main.js не подключает вынесенные модули");
    assert.ok(/registerYcIpc\(\{ ipcMain/.test(main), "IPC-мост не регистрируется");
    const found = [...ipcSrc.matchAll(/ipcMain\.handle\("(yc:[^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(found.length, 27, "каналов в мосте должно быть 27 (yc:deploy остаётся мостом деплоя): " + found.length);
  });

  await test("Yandex Cloud: служебный слой работает сам, без main.js", () => {
    const settings = {
      yandexOauthToken: "  tok  ",
      ycCloudId: " c1 ",
      ycFolderId: " f1 ",
      ycFolderName: " каталог ",
      ycAllowAgentUpdate: true,
    };
    const svc = createYcService({
      app: { getPath: () => "/tmp" },
      path,
      net: {},
      secrets: {},
      yandexCloud: {},
      ycCli: { installed: () => "/tmp/bin/yc", binDir: () => "/tmp/bin" },
      ycLogs: {},
      ycEnsurePath: () => {},
      loadSettings: () => settings,
    });
    const cfg = svc.ycConfig();
    assert.strictEqual(cfg.oauth, "tok", "OAuth-токен берётся из настроек без пробелов");
    assert.strictEqual(cfg.folderId, "f1", "каталог берётся из настроек");
    assert.strictEqual(cfg.allowUpdate, true, "право менять контейнеры читается из настроек");
    let err = null;
    try {
      svc.ycRequireAuth({});
    } catch (e) {
      err = e;
    }
    assert.ok(err && err.status === 401, "без токена — понятная ошибка 401");
    assert.strictEqual(svc.ycJsonArg('{"A":"1"}').A, "1", "аргументы строкой разбираются");
    assert.strictEqual(svc.ycJsonArg({ B: 2 }).B, 2, "объект проходит как есть");
    assert.strictEqual(svc.ycJsonArg("мусор"), undefined, "мусор не роняет разбор");
    const line = svc.ycRevisionLine({ id: "rev1", status: "ACTIVE", memoryMb: 256, cores: 1 }, true);
    assert.ok(line.includes("rev1") && line.includes("★"), "строка ревизии: " + line);
    const details = svc.ycRevisionDetails({ id: "rev1", status: "ACTIVE", command: [], args: [], secrets: [], storageMounts: [], mounts: [], env: { A: "1" } });
    assert.ok(details.includes("Переменные окружения (1): A"), "в подробностях видны только КЛЮЧИ переменных, без значений");
    assert.strictEqual(svc.ycCliStatus().installed, true, "статус встроенного yc CLI читается из папки приложения");
  });

  await test("Yandex Cloud: каналы отвечают на моках — согласие и сохранение настроек", async () => {
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
    const saved = [];
    const settings = { yandexOauthToken: "" };
    const svc = createYcService({
      app: { getPath: () => "/tmp" },
      path,
      net: {},
      secrets: {},
      yandexCloud: { resetIamCache() {} },
      ycCli: {},
      ycLogs: {},
      ycEnsurePath: () => {},
      loadSettings: () => settings,
    });
    registerYcIpc({
      ipcMain,
      yandexCloud: {
        resetIamCache() {},
        listClouds: async () => [{ id: "c1", name: "облако" }],
        listFolders: async () => [{ id: "f1", name: "каталог" }],
        createResource: async () => ({ message: "создано", resourceId: "r1", name: "n" }),
      },
      ycConsole: {},
      ycCosts: costs,
      loadSettings: () => settings,
      saveSettings: (s) => saved.push(s),
      svc,
    });
    assert.ok(handlers.has("yc:status") && handlers.has("yc:create"), "обработчики зарегистрированы");
    const status = await handlers.get("yc:status")();
    assert.strictEqual(status.loggedIn, false, "без токена статус — «не авторизован»");
    // Дальше — путь создания: он начинается с проверки авторизации.
    settings.yandexOauthToken = "oauth-token";
    settings.ycFolderId = "f1";
    const denied = await handlers.get("yc:create")(null, "dns", "зона", {});
    assert.strictEqual(denied.ok, false, "платное без согласия не создаётся");
    assert.strictEqual(denied.needsConfirm, true, "должно вернуться требование согласия");
    const allowed = await handlers.get("yc:create")(null, "dns", "зона", { confirmed: true });
    assert.strictEqual(allowed.ok, true, "с согласием ресурс создаётся");
    const tok = await handlers.get("yc:setToken")(null, "oauth-token");
    assert.strictEqual(tok.ok, true, "токен принимается");
    assert.strictEqual(saved.length, 1, "настройки сохранены один раз");
    assert.strictEqual(saved[0].yandexOauthToken, "oauth-token", "токен записан в настройки");
    assert.strictEqual(saved[0].ycFolderId, "f1", "каталог выбран автоматически");
  });
}

module.exports = {
  testYandexCloud,
  testYcDiagnosis,
  testYcFolderPersistence,
  testYcConsole,
  testYcCosts,
  testYcSplit,
};

"use strict";

/* ── Записи DNS-зоны Cloud DNS: посмотреть, поставить, удалить ────────────────
   Запуск: node test/yc-dns.test.js   (входит в общий `npm test`)

   Зачем набор. DNS-зону создавать было чем (ycCreate), а записей не было вовсе:
   список читался карточкой панели, но ни агент, ни человек не могли поставить
   или убрать запись — домен подключить было нечем, и деплой упирался в «адрес
   не отвечает, потому что имени в DNS нет».

   Главная тонкость, ради которой набор и написан: метод Cloud DNS
   `DnsZone.UpdateRecordSets` СТРОГИЙ — удаление несуществующей записи ошибка,
   добавление поверх существующей пары «имя+тип» тоже ошибка. Значит «поставить
   значение» обязано быть «прочитать → удалить прежний набор → добавить новый»,
   и новый набор — ровно с тем TTL и теми значениями, что лежат в зоне.

   Что проверяется:
     • нормализация записи: имя приводится к FQDN с точкой, тип к верхнему
       регистру, ttl к строке секунд, значения к непустому массиву строк;
     • настоящие запросы: чтение зоны, тело updateRecordSets (deletions первыми),
       ожидание операции, повторная запись заменяет, а не падает;
     • обёртки панели, канал IPC и проброс в окно;
     • инструмент агента ycDns: разрешения, поиск зоны по имени и по id,
       records / add / delete и тексты ответов;
     • согласованность: схема, группа промпта, политика прав, справочник yc.md;
     • набор стоит в цепочке npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а инструмент агента получает подменённый модуль облака. */

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
const plain = (v) => JSON.parse(JSON.stringify(v));

const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
const ycConsoleMain = require(path.join(ROOT, "src", "yc-console.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));

const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const SMOKE_SRC = read("test", "smoke", "03-cloud.js");
const CONSOLE_UI_SRC = read("src", "renderer", "yc-console.js");
const CONSOLE_CSS = read("src", "renderer", "yc-console.css");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const PKG = JSON.parse(read("package.json"));

// ── Подменённая зона Cloud DNS ──────────────────────────────────────────────
// Чтение отдаёт то, что реально лежит в «зоне», поэтому проверяется не только
// форма запроса, но и то, что после записи зона действительно изменилась.
function startDnsStub() {
  const calls = [];
  const zone = {
    recordSets: [
      { name: "www.example.com.", type: "A", ttl: "300", data: ["1.1.1.1"] },
      { name: "example.com.", type: "MX", ttl: "21600", data: ["10 mx.yandex.net."] },
    ],
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url || "";
      calls.push({ method: req.method, url: url, body: body });
      const json = (o) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      // Список зон каталога — его спрашивают и канал плитки (yc:dns), и агент.
      if (url.split("?")[0] === "/dns/v1/zones") {
        return json({ zones: [{ id: "dns-zone-1", name: "example.com.", createdAt: "2026-08-01T10:00:00Z" }] });
      }
      if (url.indexOf(":getRecordSets") >= 0) return json({ recordSets: plain(zone.recordSets) });
      if (url.indexOf(":updateRecordSets") >= 0) {
        const b = JSON.parse(body || "{}");
        // Порядок как в API: сначала deletions, потом additions.
        for (const d of b.deletions || []) {
          const i = zone.recordSets.findIndex((r) => r.name === d.name && r.type === d.type);
          if (i < 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ code: 5, message: "Deleted record is not found.", details: [] }));
          }
          if (String(zone.recordSets[i].ttl) !== String(d.ttl) || String(zone.recordSets[i].data.join(",")) !== String(d.data.join(","))) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ code: 5, message: "Found record with matched type and name but different TTL, value, or description.", details: [] }));
          }
          zone.recordSets.splice(i, 1);
        }
        for (const a of b.additions || []) {
          if (zone.recordSets.some((r) => r.name === a.name && r.type === a.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ code: 6, message: "Record with such name and type already exists.", details: [] }));
          }
          zone.recordSets.push(a);
        }
        return json({ id: "op-9", done: false });
      }
      if (url.indexOf("/operations/") >= 0) return json({ id: "op-9", done: true, response: {} });
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, zone, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function fakeCloud(over) {
  const calls = { list: 0, upsert: [], del: [], records: 0 };
  const cloud = Object.assign(
    {
      serviceByKey: (k) => ({ key: k, svc: "dns", title: "Cloud DNS", listPath: "/dns/v1/zones", listKey: "zones" }),
      listService: async () => {
        calls.list++;
        return { count: 1, items: [{ id: "dns-zone-1", name: "example.com.", zone: "example.com." }] };
      },
      listRecordSets: async () => {
        calls.records++;
        return [{ name: "www.example.com.", type: "A", ttl: "300", data: ["1.1.1.1"], description: "" }];
      },
      upsertRecordSet: async (oauth, zoneId, rec) => {
        calls.upsert.push({ zoneId, rec });
        return { name: "www.example.com.", type: "A", ttl: "600", values: 1, replaced: false };
      },
      deleteRecordSet: async (oauth, zoneId, opts) => {
        calls.del.push({ zoneId, opts });
        return { name: "www.example.com.", type: "A", values: 1 };
      },
    },
    over || {}
  );
  return { cloud, calls };
}

function buildTools(over, settingsOver) {
  const { cloud, calls } = fakeCloud(over);
  const settings = Object.assign(
    {
      yandexOauthToken: "oauth-1",
      ycCloudId: "cloud-1",
      ycFolderId: "folder-1",
      ycFolderName: "prod",
      ycAllowAgentCreate: false,
      ycAllowAgentDelete: false,
      ycAllowAgentUpdate: false,
    },
    settingsOver || {}
  );
  const tools = createCloudTools({
    yandexCloud: cloud,
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
  return { tools, calls, settings };
}

(async () => {
  const stub = await startDnsStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  // ── Канал «yc:dns» через НАСТОЯЩИЙ registerYcIpc: окно подменено, всё
  // остальное — как в приложении (облако смотрит на стенд выше).
  function settingsFor(over) {
    return Object.assign(
      { yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "folder-1", ycFolderName: "prod" },
      over || {}
    );
  }
  function buildIpc(settings) {
    const handlers = new Map();
    registerYcIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      yandexCloud: yandex,
      ycConsole: {}, ycCosts: {}, ycVpc: {}, ycCompute: {}, ycIam: {}, ycFunctions: {},
      ycBilling: {}, ycCdn: {}, ycMonitoring: {}, ycAi: {}, ycMdb: {},
      fs: fs, path: path, resolvePath: (p) => String(p), agentWorkDir: () => ROOT,
      loadSettings: () => settings, saveSettings: () => {},
      svc: {
        YANDEX_OAUTH_URL: "https://oauth.yandex.ru/authorize",
        ycConfig: () => ({
          oauth: String(settings.yandexOauthToken || ""),
          cloudId: settings.ycCloudId || "",
          folderId: settings.ycFolderId || "",
          folderName: settings.ycFolderName || "",
          allowCreate: false, allowDelete: false, allowUpdate: false, allowPublic: false,
        }),
        ycRequireAuth: () => {},
        readYcLogsText: async () => "",
        ycCliStatus: () => ({}),
        ycCliInstall: async () => ({}),
      },
    });
    return { call: (args) => handlers.get("yc:dns")({}, args || {}) };
  }

  console.log("\n[1] Запись приводится к тому виду, который ждёт API");

  await test("ycDns: имя становится FQDN с точкой, тип — верхним регистром, ttl — строкой", () => {
    assert.deepStrictEqual(plain(yandex.normalizeRecordSet({ name: "www.example.com", type: "a", ttl: "3600", data: "1.2.3.4" })), {
      name: "www.example.com.", type: "A", ttl: "3600", data: ["1.2.3.4"], description: "",
    }, "запись нормализована неверно");
    assert.deepStrictEqual(plain(yandex.normalizeRecordSet({ name: "example.com.", type: "TXT", data: ["a", "b", "  "] })), {
      name: "example.com.", type: "TXT", ttl: "600", data: ["a", "b"], description: "",
    }, "пустые значения не отсеяны или TTL не по умолчанию");
    // Имя без точки — самая частая ошибка: Cloud DNS её не примет.
    assert.strictEqual(yandex.normalizeRecordSet({ name: "mail.example.com", type: "A" }).name, "mail.example.com.",
      "точка в конце имени не добавлена");
    assert.strictEqual(yandex.normalizeRecordSet({ name: "example.com.", type: "A" }).name, "example.com.",
      "вторая точка добавлена к уже готовому имени");
    assert.deepStrictEqual(plain(yandex.normalizeRecordSet({})).data, [], "у пустой записи появились значения");
  });

  console.log("\n[2] Настоящие запросы: строгий методы слышит порядок deletions → additions");

  await test("ycDns: новая запись уходит additions без deletions", async () => {
    stub.calls.length = 0;
    yandex.resetIamCache();
    const r = await yandex.upsertRecordSet("oauth-1", "dns-zone-1", { name: "api.example.com", type: "A", value: "203.0.113.10", ttl: 120 });
    assert.strictEqual(r.replaced, false, "новая запись помечена как замена");
    assert.strictEqual(r.name, "api.example.com.", "имя ушло без точки: " + r.name);
    const call = stub.calls.find((c) => c.url.indexOf(":updateRecordSets") >= 0);
    assert.ok(call, "запрос updateRecordSets не ушёл");
    const body = JSON.parse(call.body);
    assert.deepStrictEqual(plain(body.deletions), [], "у новой записи появились deletions");
    assert.deepStrictEqual(plain(body.additions), [
      { name: "api.example.com.", type: "A", ttl: "120", data: ["203.0.113.10"], description: "" },
    ], "тело additions собрано неверно: " + call.body);
    assert.ok(stub.calls.some((c) => c.url.indexOf("/operations/op-9") >= 0), "операция не дождалась завершения");
    assert.ok(stub.zone.recordSets.some((x) => x.name === "api.example.com."), "записи нет в зоне после вызова");
  });

  await test("ycDns: существующая пара «имя+тип» заменяется, а не падает", async () => {
    stub.calls.length = 0;
    const r = await yandex.upsertRecordSet("oauth-1", "dns-zone-1", { name: "www.example.com", type: "A", value: "2.2.2.2" });
    assert.strictEqual(r.replaced, true, "замена не распознана");
    const body = JSON.parse(stub.calls.find((c) => c.url.indexOf(":updateRecordSets") >= 0).body);
    assert.deepStrictEqual(plain(body.deletions), [
      { name: "www.example.com.", type: "A", ttl: "300", data: ["1.1.1.1"], description: "" },
    ], " удаление старого набора ушло не с тем TTL/значениями: " + JSON.stringify(body.deletions));
    assert.deepStrictEqual(plain(body.additions[0].data), ["2.2.2.2"], "новое значение не ушло");
    assert.strictEqual(stub.zone.recordSets.filter((x) => x.name === "www.example.com.").length, 1,
      "в зоне осталось два разных набора с одним именем");
    // Повторный вызов не должен падать: строгий API на второй add ответил бы ошибкой.
    const again = await yandex.upsertRecordSet("oauth-1", "dns-zone-1", { name: "www.example.com.", type: "A", value: "3.3.3.3" });
    assert.strictEqual(again.replaced, true, "вторая замена не сработала");
  });

  await test("ycDns: удаление убирает ровно то, что лежит в зоне, а пустое — честная ошибка", async () => {
    stub.calls.length = 0;
    const r = await yandex.deleteRecordSet("oauth-1", "dns-zone-1", { name: "example.com", type: "mx" });
    assert.deepStrictEqual(plain(r), { name: "example.com.", type: "MX", values: 1 }, "удаление ответило не тем: " + JSON.stringify(plain(r)));
    const body = JSON.parse(stub.calls.find((c) => c.url.indexOf(":updateRecordSets") >= 0).body);
    assert.deepStrictEqual(plain(body.additions), [], "при удалении что-то добавилось");
    assert.strictEqual(body.deletions[0].data[0], "10 mx.yandex.net.", "удаляется не то, что лежит в зоне");
    assert.ok(!stub.zone.recordSets.some((x) => x.type === "MX"), "запись осталась в зоне");

    stub.calls.length = 0;
    const missing = await yandex.deleteRecordSet("oauth-1", "dns-zone-1", { name: "nope.example.com.", type: "A" }).then(() => null, (e) => e);
    assert.ok(missing && /удалять нечего/.test(missing.message), "отсутствующая запись не объяснена: " + (missing && missing.message));
    assert.strictEqual(stub.calls.filter((c) => c.url.indexOf(":updateRecordSets") >= 0).length, 0, "запрос ушёл несмотря на отказ");
  });

  await test("ycDns: пустые поля ловятся до запроса", async () => {
    stub.calls.length = 0;
    const noName = await yandex.upsertRecordSet("oauth-1", "dns-zone-1", { type: "A", value: "1.1.1.1" }).then(() => null, (e) => e);
    assert.ok(noName && /нужно имя/.test(noName.message), "нет ошибки про имя: " + (noName && noName.message));
    const noType = await yandex.upsertRecordSet("oauth-1", "dns-zone-1", { name: "a.example.com", value: "1.1.1.1" }).then(() => null, (e) => e);
    assert.ok(noType && /нужен тип/.test(noType.message), "нет ошибки про тип: " + (noType && noType.message));
    const noData = await yandex.upsertRecordSet("oauth-1", "dns-zone-1", { name: "a.example.com", type: "A" }).then(() => null, (e) => e);
    assert.ok(noData && /нет значений/.test(noData.message), "нет ошибки про значения: " + (noData && noData.message));
    const noZone = await yandex.deleteRecordSet("oauth-1", "", { name: "a.example.com.", type: "A" }).then(() => null, (e) => e);
    assert.ok(noZone && /DNS-зоны/.test(noZone.message), "нет ошибки про зону: " + (noZone && noZone.message));
    assert.strictEqual(stub.calls.filter((c) => c.url.indexOf(":updateRecordSets") >= 0).length, 0, "запросы ушли при пустых полях");
  });

  console.log("\n[3] Панель: обёртки, канал, форма и удаление из таблицы");

  await test("ycDns: обёртки панели отвечают разборчиво и требуют зону", async () => {
    const up = await ycConsoleMain.upsertRecord("oauth-1", { zoneId: "dns-zone-1", name: "www.example.com", type: "a", ttl: 60, values: ["9.9.9.9"] });
    assert.strictEqual(up.ok, true, "запись не поставлена: " + JSON.stringify(plain(up)));
    assert.strictEqual(up.type, "A", "тип не приведён к верхнему регистру");
    const del = await ycConsoleMain.deleteRecord("oauth-1", { zoneId: "dns-zone-1", name: "www.example.com", type: "a" });
    assert.strictEqual(del.ok, true, "запись не удалена: " + JSON.stringify(plain(del)));
    const noZone = await ycConsoleMain.upsertRecord("oauth-1", { name: "a.example.com", type: "A", values: ["1.1.1.1"] }).then(() => null, (e) => e);
    assert.ok(noZone && /id DNS-зоны/.test(noZone.message), "обёртка панели не требует зону");
  });

  await test("ycDns: канал IPC, проброс в окно и свободный доступ человека", () => {
    assert.ok(IPC_SRC.includes('ipcMain.handle("yc:console:dnsRecord"'), "нет канала записи DNS");
    assert.ok(/ycConsole\.upsertRecord\(cfg\.oauth,/.test(IPC_SRC), "канал не зовёт постановку записи");
    assert.ok(/ycConsole\.deleteRecord\(cfg\.oauth,/.test(IPC_SRC), "канал не зовёт удаление записи");
    assert.ok(PRELOAD_SRC.includes('ycConsoleDnsRecord: (args) => ipcRenderer.invoke("yc:console:dnsRecord", args || {})'),
      "preload не пробрасывает запись DNS в окно");
    const from = IPC_SRC.indexOf("// Записи DNS-зоны из карточки в панели");
    assert.ok(from > 0, "канал записи DNS не подписан");
    const handler = IPC_SRC.slice(from, IPC_SRC.indexOf("yc:resources", from));
    assert.ok(handler.indexOf("allowCreate") === -1 && handler.indexOf("allowDelete") === -1,
      "запись DNS из панели закрыта разрешением агента");
    assert.ok(/Неизвестная операция с записью/.test(handler), "чужой op не отвергается");
  });

  await test("ycDns: в карточке зоны есть форма записи и удаление из таблицы", () => {
    assert.ok(CONSOLE_UI_SRC.includes("function dnsRecordForm()"), "нет формы записи");
    assert.ok(CONSOLE_UI_SRC.includes('state.serviceKey === "dns"') && CONSOLE_UI_SRC.includes("dnsRecordForm()"),
      "форма записи не подключена к карточке зоны");
    assert.ok(CONSOLE_UI_SRC.includes('apiCall("ycConsoleDnsRecord"'), "форма не вызывает канал записи");
    assert.ok(/canDeleteRecord/.test(CONSOLE_UI_SRC) && CONSOLE_UI_SRC.includes('op: "delete"'), "из таблицы записей нельзя удалить");
    assert.ok(/op: "upsert"/.test(CONSOLE_UI_SRC), "форма не отправляет постановку записи");
    for (const cls of [".ykc-record {", ".ykc-record-line", ".ykc-rec-name", ".ykc-rec-type", ".ykc-rec-value"]) {
      assert.ok(CONSOLE_CSS.includes(cls), "в стилях нет " + cls);
    }
  });

  console.log("\n[4] Инструмент агента ycDns");

  await test("ycDns: разрешения и чужое действие — до всякой сети", async () => {
    const env = buildTools();
    const add = await env.tools.ycDns({ action: "add", zone: "example.com.", name: "www.example.com.", type: "A", value: "1.1.1.1" }, {});
    assert.ok(/⛔/.test(add) && /создавать ресурсы/.test(add), "добавление без разрешения не отбито: " + add.slice(0, 120));
    assert.strictEqual(env.calls.upsert.length, 0, "запись ушла без разрешения");
    const del = await env.tools.ycDns({ action: "delete", zone: "example.com.", name: "www.example.com.", type: "A" }, {});
    assert.ok(/⛔/.test(del) && /удалять ресурсы/.test(del), "удаление без разрешения не отбито: " + del.slice(0, 120));
    assert.strictEqual(env.calls.del.length, 0, "удаление ушло без разрешения");
    const bad = await env.tools.ycDns({ action: "стирай" }, {});
    assert.ok(/неизвестное действие ycDns/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 120));
    assert.strictEqual(env.calls.list, 0, "при неизвестном действии пошли в облако");
  });

  await test("ycDns: records показывает записи и подсказывает, как менять", async () => {
    const env = buildTools();
    const out = await env.tools.ycDns({ action: "records", zone: "example.com." }, {});
    assert.ok(/Зона «example.com.»/.test(out), "зона не названа: " + out.slice(0, 120));
    assert.ok(/A www\.example\.com\. \(TTL 300\) → 1\.1\.1\.1/.test(out), "запись не показана: " + out.slice(0, 200));
    assert.ok(/action: "add"/.test(out) && /action: "delete"/.test(out), "не сказано, как менять записи");
  });

  await test("ycDns: зона ищется по имени и по id, а чужое имя честно перечисляет зоны", async () => {
    const byId = buildTools();
    const out = await byId.tools.ycDns({ action: "records", zone: "dns-zone-1" }, {});
    assert.ok(/dns-zone-1/.test(out), "зона по id не найдена: " + out.slice(0, 120));

    const many = buildTools({
      listService: async () => ({
        count: 2,
        items: [{ id: "z1", name: "a.example.com." }, { id: "z2", name: "b.example.com." }],
      }),
    });
    const ambiguous = await many.tools.ycDns({ action: "records" }, {});
    assert.ok(/Зон несколько/.test(ambiguous) && /a\.example\.com\./.test(ambiguous), "неоднозначность не объяснена: " + ambiguous.slice(0, 160));
    const wrong = await many.tools.ycDns({ action: "records", zone: "нет-такой" }, {});
    assert.ok(/Не нашёл зону/.test(wrong) && /b\.example\.com\./.test(wrong), "чужая зона не перечисляет доступные: " + wrong.slice(0, 160));

    const none = buildTools({ listService: async () => ({ count: 0, items: [] }) });
    const empty = await none.tools.ycDns({ action: "records" }, {});
    assert.ok(/DNS-зон в каталоге/.test(empty) && /ycCreate/.test(empty), "пустой каталог не подсказывает создание зоны: " + empty.slice(0, 160));
  });

  await test("ycDns: add и delete отвечают словами и говорят про распространение DNS", async () => {
    const env = buildTools({}, { ycAllowAgentCreate: true, ycAllowAgentDelete: true });
    const add = await env.tools.ycDns({ action: "add", zone: "example.com.", name: "www.example.com", type: "a", value: "2.2.2.2", ttl: 60 }, {});
    assert.ok(/✅/.test(add) && /А|A www\.example\.com\./.test(add), "запись не подтверждена: " + add.slice(0, 160));
    assert.deepStrictEqual(plain(env.calls.upsert[0].rec), { name: "www.example.com", type: "a", ttl: 60, data: "2.2.2.2" },
      "аргументы записи ушли искажённо: " + JSON.stringify(plain(env.calls.upsert[0].rec)));
    assert.ok(/обновление dns|распространение DNS|от минуты до часов/i.test(add), "не сказано, что DNS расходится не сразу: " + add.slice(0, 200));
    assert.ok(/checkUrl/.test(add), "не предложена проверка адреса");

    const del = await env.tools.ycDns({ action: "delete", zone: "example.com.", name: "www.example.com", type: "A" }, {});
    assert.ok(/🗑/.test(del) && /удалена/.test(del), "удаление не подтверждено: " + del.slice(0, 160));
    assert.deepStrictEqual(plain(env.calls.del[0].opts), { name: "www.example.com", type: "A" }, "удаление ушло не с теми полями");
    assert.ok(/records/.test(del), "после удаления не предложено посмотреть, что осталось");
  });

  await test("ycDns: без подключения и без каталога отвечает честно", async () => {
    const off = buildTools({}, { yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await off.tools.ycDns({ action: "records" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({}, { ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycDns({ action: "records" }, {})), "нет ответа про каталог");
  });

  console.log("\n[5] Согласованность: схема, промпт, политика, справочник");

  await test("ycDns: схема, группа облака, промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycDns"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 1900);
    for (const part of ["action", "zone", "name", "type", "value", "values", "ttl", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/создавать ресурсы/.test(schema) && /удалять ресурсы/.test(schema), "схема не называет разрешения");
    assert.ok(/БЕЗ точки/.test(schema) && /С точкой/.test(schema), "схема не объясняет точку в имени");
    // Границы записи, а не число знаков: окно в 800 знаков ломалось от каждого
    // нового ключевого слова группы (заход 2 части 91 добавил «балансировщик»),
    // хотя проверяемое свойство — «инструмент есть в группе облака» — не менялось.
    const gAt = CORE_SRC.indexOf('id: "cloud"');
    const gEnd = CORE_SRC.indexOf('id: "', gAt + 10);
    const group = CORE_SRC.slice(gAt, gEnd > gAt ? gEnd : gAt + 800);
    assert.ok(/ycDns/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycDns/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycDns \(записи зоны DNS/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycDns");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 260).includes('"ycDns"'), "нет назначения cloud.read для ycDns");
  });

  await test("ycDns: справочник агента учит точке в имени и порядку работы", () => {
    assert.ok(/ycDns/.test(GUIDE_SRC), "в yc.md нет ycDns");
    assert.ok(/БЕЗ точки/.test(GUIDE_SRC) && /С точкой/.test(GUIDE_SRC), "в yc.md не сказано про точку в имени записи");
    assert.ok(/разрешения «создавать ресурсы»|«создавать ресурсы»/.test(GUIDE_SRC), "в yc.md не сказано про разрешения");
    assert.ok(/расходится от минуты до часов/.test(GUIDE_SRC), "в yc.md нет предупреждения про распространение DNS");
  });

  console.log("\n[3.1] Плитка действий: семейство dns, проверки записи и канал yc:dns");

  await test("ycDns: проверки записи ловят кривой адрес и говорят, что стоит предупредить", async () => {
    const apex = yandex.checkDnsRecord({ name: "example.com.", type: "CNAME", value: "host.example.net." }, "example.com.");
    assert.ok(apex.problems.some((p) => /вершине зоны/.test(p)), "CNAME на вершине не отбит: " + JSON.stringify(apex.problems));
    const multi = yandex.checkDnsRecord({ name: "www.example.com.", type: "CNAME", value: ["a.example.net.", "b.example.net."] }, "example.com.");
    assert.ok(multi.problems.some((p) => /только одно значение/.test(p)), "CNAME с двумя значениями не отбит");
    const badA = yandex.checkDnsRecord({ name: "www.example.com.", type: "A", value: "пример" }, "example.com.");
    assert.ok(badA.problems.some((p) => /IPv4/.test(p)), "кривой адрес A не отбит: " + JSON.stringify(badA.problems));
    const badMx = yandex.checkDnsRecord({ name: "example.com.", type: "MX", value: "mx.yandex.net." }, "example.com.");
    assert.ok(badMx.problems.some((p) => /приоритета/.test(p)), "MX без приоритета не отбит");
    const odd = yandex.checkDnsRecord({ name: "www.example.com.", type: "WIDGET", value: "да" }, "example.com.");
    assert.deepStrictEqual(plain(odd.problems), [], "незнакомый тип отбит, хотя облако могло его принять");
    assert.ok(odd.warnings.some((w) => /не из привычного набора/.test(w)), "незнакомый тип не предупреждён: " + JSON.stringify(odd.warnings));
    const outside = yandex.checkDnsRecord({ name: "www.other.net.", type: "A", value: "203.0.113.10" }, "example.com.");
    assert.ok(outside.warnings.some((w) => /не оканчивается/.test(w)), "чужое имя зоны не предупреждено");
    // Та же проверка стоит и в самом upsertRecordSet: запись в облако не уходит.
    stub.calls.length = 0;
    const thrown = await yandex.upsertRecordSet("oauth-1", "dns-zone-1", { name: "www.example.com.", type: "A", value: "привет" }).then(() => null, (e) => e);
    assert.ok(thrown && /IPv4/.test(thrown.message), "upsert не проверил адрес: " + (thrown && thrown.message));
    assert.strictEqual(stub.calls.filter((c) => c.url.indexOf(":updateRecordSets") >= 0).length, 0, "запрос ушёл на запись, которую API не примет");
  });

  await test("yc:dns: канал отвечает зонами и записями, а запись ставит с двумя значениями", async () => {
    const env = buildIpc(settingsFor());
    const zones = await env.call({ op: "zones" });
    assert.strictEqual(zones.ok, true, "зоны не пришли: " + JSON.stringify(zones));
    assert.ok(zones.lines.some((l) => /example\.com\. — id dns-zone-1/.test(l)), "зона не названа строкой: " + JSON.stringify(zones.lines));
    assert.ok(zones.zones && zones.zones.length === 1, "канал не отдал зоны окну");

    stub.calls.length = 0;
    const added = await env.call({ op: "add", zone: "example.com", name: "panel.example.com", type: "A", ttl: 120, values: "203.0.113.7, 203.0.113.8" });
    assert.strictEqual(added.ok, true, "запись не поставлена: " + JSON.stringify(added));
    const body = JSON.parse(stub.calls.find((c) => c.url.indexOf(":updateRecordSets") >= 0).body);
    assert.deepStrictEqual(plain(body.additions[0].data), ["203.0.113.7", "203.0.113.8"], "значения через запятую уехали не двумя: " + JSON.stringify(body.additions));
    assert.strictEqual(added.record.values, 2, "канал не сказал, сколько значений ушло");
    assert.ok(/от минуты до часов/.test((added.warnings || []).join(" ")), "не сказано про распространение DNS");
    assert.ok(/panel\.example\.com\./.test(added.lines[0]), "строка ответа не называет запись: " + added.lines[0]);

    const records = await env.call({ op: "records", zone: "example.com." });
    assert.ok(records.lines.some((l) => /A panel\.example\.com\. \(TTL 120\) → 203\.0\.113\.7, 203\.0\.113\.8/.test(l)), "запись не видно в списке: " + JSON.stringify(records.lines.slice(0, 4)));
    const card = await env.call({ op: "card", zone: "dns-zone-1" });
    assert.ok(card.lines.some((l) => /Создана: 2026-08-01/.test(l)) && /Записей: /.test(card.lines.join(" ")), "карточка зоны не собрана: " + JSON.stringify(card.lines));
  });

  await test("yc:dns: удаление сначала называет запись, а снимает только по согласию", async () => {
    const env = buildIpc(settingsFor());
    stub.calls.length = 0;
    const ask = await env.call({ op: "delete", zone: "example.com.", name: "panel.example.com.", type: "A" });
    assert.strictEqual(ask.ok, false, "удаление прошло без согласия");
    assert.strictEqual(ask.needsConfirm, true, "канал не спросил согласие: " + JSON.stringify(ask));
    assert.ok(/перестать открываться|приходить/.test(ask.error), "не сказано, что перестанет работать");
    assert.ok(/panel\.example\.com\./.test(ask.lines.join(" ")), "согласие не показывает саму запись");
    assert.strictEqual(stub.calls.filter((c) => c.url.indexOf(":updateRecordSets") >= 0).length, 0, "запрос ушёл до согласия");

    const gone = await env.call({ op: "delete", zone: "example.com.", name: "panel.example.com.", type: "A", confirm: true });
    assert.strictEqual(gone.ok, true, "запись не удалена: " + JSON.stringify(gone));
    assert.ok(/удалена/.test(gone.lines.join(" ")), "ответ об удалении не назван");
    assert.ok(!stub.zone.recordSets.some((r) => r.name === "panel.example.com."), "запись осталась в зоне");
  });

  await test("yc:dns: CNAME на вершине и чужое действие отбиваются словами", async () => {
    const env = buildIpc(settingsFor());
    stub.calls.length = 0;
    const apex = await env.call({ op: "add", zone: "example.com.", name: "example.com.", type: "CNAME", values: "host.example.net." });
    assert.strictEqual(apex.ok, false, "CNAME на вершине принят");
    assert.ok(/вершине зоны/.test(apex.error), "вершина не объяснена: " + apex.error);
    assert.strictEqual(stub.calls.filter((c) => c.url.indexOf(":updateRecordSets") >= 0).length, 0, "запрос ушёл с CNAME на вершине");

    const bad = await env.call({ op: "стирай" });
    assert.ok(/Доступно: zones, card, records, add, delete/.test(bad.error), "чужое действие не перечисляет доступные: " + bad.error);

    const noFolder = buildIpc(settingsFor({ ycFolderId: "" }));
    const nowhere = await noFolder.call({ op: "zones" });
    assert.ok(/каталог/.test(nowhere.error), "без каталога нет честного ответа: " + nowhere.error);
  });

  await test("семейство dns: пять действий, подписи и опасное удаление", () => {
    const vm = require("vm");
    const ctx = { window: {}, document: undefined, navigator: {}, console: console };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(ACTIONS_SRC, ctx, { filename: "yc-actions.js" });
    const A = ctx.window.YcActions;
    assert.strictEqual(A.CHANNELS.dns, "ycDns", "семейство dns смотрит не в тот канал");
    assert.deepStrictEqual(Array.from(A.OPS.dns).sort(), ["add", "card", "delete", "records", "zones"], "список действий dns разошёлся");
    for (const need of ["zones", "records", "card", "add", "delete"]) {
      assert.ok(A.forService("dns").indexOf(need) >= 0, "у семейства нет действия " + need);
    }
    const add = A.describe("dns", "add");
    assert.strictEqual(add.paid, false, "постановка записи помечена платной, хотя она бесплатна");
    // Зона — ЦЕЛЬ формы (приходит из карточки или заполняется руками), а не
    // обычное поле: так же устроены машина, аккаунт и функция.
    const addAction = A.actionsFor("dns").find((a) => a.id === "add");
    assert.strictEqual(addAction.target && addAction.target.key, "zone", "у формы добавления нет цели-зоны");
    for (const f of ["name", "type", "ttl", "values"]) {
      assert.ok(add.fields.indexOf(f) >= 0, "в форме добавления нет поля " + f);
    }
    const del = A.describe("dns", "delete");
    assert.strictEqual(del.danger, true, "удаление записи не помечено опасным");
    assert.strictEqual(del.confirmArg, "confirm", "удаление просит согласие не тем полем");
    const req = A.request("dns", "add", { zone: "example.com.", name: "www.example.com.", type: "A", ttl: 600, values: "203.0.113.10" }, false);
    assert.strictEqual(req.args.zone, "example.com.", "зона не ушла в запрос");
    assert.strictEqual(req.args.confirm, undefined, "у постановки появилось согласие");
    const asked = A.request("dns", "delete", { zone: "example.com.", name: "www.example.com.", type: "A" }, true);
    assert.strictEqual(asked.args.confirm, true, "согласие на удаление не ушло");
    assert.ok(PRELOAD_SRC.includes('ycDns: (args) => ipcRenderer.invoke("yc:dns", args || {})'), "preload не пробрасывает yc:dns");
    assert.ok(SMOKE_SRC.includes('"yc:dns"'), "сторож каналов не знает yc:dns");
  });

  await test("ycDns: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-dns.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

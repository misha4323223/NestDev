"use strict";

/* ── Managed-базы: PostgreSQL, MySQL и ClickHouse ─────────────────────────────
   Запуск: node test/yc-mdb.test.js   (входит в общий `npm test`)

   Зачем набор. Managed-кластер — единственный ресурс облака, который нельзя
   «просто посмотреть»: он платный по часам, у него есть состояние (работает,
   остановлен, создаётся), роли хостов, базы, пользователи и логи. Ошибка здесь
   стоит денег и данных, поэтому проверяется не «вызвался ли метод», а то, что
   запрос уходит по НАСТОЯЩЕМУ адресу и с настоящим телом.

   Что стережётся (и почему именно это):
     • три базы — один API: пути различаются только сегментом
       (/managed-postgresql, /managed-mysql, /managed-clickhouse), а хост один
       (mdb.api.cloud.yandex.net). Проверяем каждый из трёх;
     • форма запроса по справочнику: список — folderId в строке, карточка —
       /clusters/{id}, хосты — /clusters/{id}/hosts, логи —
       /clusters/{id}:logs с fromTime/toTime БЕЗ миллисекунд и pageSize,
       классы — /resourcePresets;
     • КЛИКХАУС НЕ КАК ВСЕ: его класс и диск лежат ВНУТРИ configSpec.clickhouse,
       а администратору обязателен configSpec.adminPassword. Это проверяется
       разбором настоящего тела создания — иначе баг вылез бы только вживую;
     • адрес подключения собирается из ХОСТА-мастера, а не из константы: у
       кластера точки входа нет, и «подключение к кластеру» — это неправда;
     • ПАРОЛЬ: чтение паролей не отдаёт (их у облака и нет), а создание отдаёт
       ровно один раз и ровно в поле secret — не в строках ответа;
     • отказы ДО сети: пустое имя, кривое имя, нет версии/класса/подсети,
       защита от удаления, занятый кластер (идёт переход) — на всё это запрос
       уходить не должен, и это видно по счётчику обращений к облаку;
     • интерфейс и проводка: канал yc:mdb, проброс в окно, три семейства в
       yc-actions с подставленным engine, плитки полки с ОФИЦИАЛЬНЫМИ иконками,
       согласованность консоли и дашборда (их сверяет test/smoke/03-cloud.js);
     • согласованность: схема инструмента, обе строки промпта, группа «облако»,
       политика прав, справочник yc.md и цепочка npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE, как у остальных наборов облака). */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function test(name, fn) {
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
const mdbMod = require(path.join(ROOT, "src", "yc-mdb.js"));
const { createYcMdb } = mdbMod;
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const PANEL_SRC = read("src", "renderer", "yc-panel.js");
const LOGOS_SRC = read("src", "renderer", "yc-logos.js");
const CONSOLE_SRC = read("src", "yc-console.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke", "03-cloud.js");
const MAIN_SRC = read("src", "main.js");
const YANDEX_SRC = read("src", "yandex-cloud.js");
const PKG = JSON.parse(read("package.json"));
const LOGOS = require(path.join(ROOT, "src", "renderer", "yc-logos.js"));
const ycConsole = require(path.join(ROOT, "src", "yc-console.js"));

// ── Подменённое облако Managed-баз ──────────────────────────────────────────
// Четыре кластера, и каждый здесь не для красоты: обычный работающий (pg-1),
// остановленный с защитой от удаления (pg-prot), занятый переходом (pg-busy) и
// кластер ClickHouse с ДРУГОЙ формой config (ch-1) — именно на нём видно, что
// класс и диск читаются из config.clickhouse.
function startMdbStub() {
  const calls = [];
  const created = [];
  const deleted = new Set();
  const status = { "pg-1": "RUNNING", "pg-prot": "STOPPED", "pg-busy": "CREATING", "my-1": "RUNNING", "ch-1": "RUNNING" };
  const clusters = {
    "pg-1": {
      id: "pg-1", name: "db-main", folderId: "folder-1", createdAt: "2026-08-01T10:00:00Z", environment: "PRODUCTION",
      status: "RUNNING", health: "ALIVE", networkId: "net-1", deletionProtection: false,
      config: { version: "16", resources: { resourcePresetId: "s2.micro", diskSize: "21474836480", diskTypeId: "network-ssd" } },
    },
    "pg-prot": {
      id: "pg-prot", name: "db-protected", folderId: "folder-1", createdAt: "2026-07-01T10:00:00Z", environment: "PRODUCTION",
      status: "STOPPED", health: "ALIVE", networkId: "net-1", deletionProtection: true,
      config: { version: "15", resources: { resourcePresetId: "s2.small", diskSize: "10737418240", diskTypeId: "network-hdd" } },
    },
    "pg-busy": {
      id: "pg-busy", name: "db-busy", folderId: "folder-1", createdAt: "2026-09-30T09:00:00Z", environment: "PRODUCTION",
      status: "CREATING", health: "HEALTH_UNKNOWN", networkId: "net-1", deletionProtection: false,
      config: { version: "16", resources: { resourcePresetId: "s2.micro", diskSize: "10737418240", diskTypeId: "network-ssd" } },
    },
    "my-1": {
      id: "my-1", name: "mysql-main", folderId: "folder-1", createdAt: "2026-08-10T10:00:00Z", environment: "PRODUCTION",
      status: "RUNNING", health: "ALIVE", networkId: "net-1", deletionProtection: false,
      config: { version: "8.0", resources: { resourcePresetId: "s2.micro", diskSize: "10737418240", diskTypeId: "network-ssd" } },
    },
    "ch-1": {
      id: "ch-1", name: "analytics", folderId: "folder-1", createdAt: "2026-08-20T10:00:00Z", environment: "PRODUCTION",
      status: "RUNNING", health: "ALIVE", networkId: "net-1", deletionProtection: false,
      // Класс и диск ClickHouse — ВНУТРИ config.clickhouse, а не рядом с версией.
      config: { version: "24.8", clickhouse: { resources: { resourcePresetId: "s3.medium", diskSize: "34359738368", diskTypeId: "network-ssd" } } },
    },
  };
  const byEngine = { "managed-postgresql": ["pg-1", "pg-prot", "pg-busy"], "managed-mysql": ["my-1"], "managed-clickhouse": ["ch-1"] };

  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      const url = req.url || "";
      calls.push({ method: req.method, url: url, body: raw });
      const json = (o, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.indexOf("/iam/v1/tokens") >= 0) return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (url.indexOf("/operations/") >= 0) return json({ id: url.split("/").pop(), done: true });

      // Сеть VPC нужна только за одним полем — networkId подсети.
      if (url.indexOf("/vpc/v1/subnets") >= 0) {
        return json({ subnets: [{ id: "sub-1", name: "app-subnet", networkId: "net-1", zoneId: "ru-central1-a" }] });
      }

      const m = url.match(/^\/managed-(postgresql|mysql|clickhouse)\/v1\/(.+)$/);
      if (!m) return json({}, 404);
      const api = "managed-" + m[1];
      // Строка параметров в разборе пути не участвует, но нужна в calls — её
      // проверяют наборы (folderId, fromTime/toTime, serviceType, pageSize).
      let rest = m[2];
      const qIdx = rest.indexOf("?");
      if (qIdx >= 0) rest = rest.slice(0, qIdx);

      if (rest.indexOf("resourcePresets") === 0) {
        return json({ resourcePresets: [{ id: "s2.micro", cores: "2", memory: "8589934592", zoneIds: ["ru-central1-a", "ru-central1-b"], diskTypeIds: ["network-ssd"] }] });
      }
      if (rest === "clusters" && req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        created.push({ api: api, body: body });
        return json({ id: "op-create", metadata: { clusterId: api + "-new" } });
      }
      if (rest === "clusters") {
        return json({ clusters: (byEngine[api] || []).map((id) => Object.assign({}, clusters[id], { status: status[id] })) });
      }
      const cm = rest.match(/^clusters\/([^/:]+)(?::(start|stop|logs))?(\/(hosts|databases|users|operations))?$/);
      if (!cm) return json({}, 404);
      const id = cm[1];
      const action = cm[2];
      const sub = cm[3];
      if (req.method === "DELETE") {
        deleted.add(id);
        return json({ id: "op-del" });
      }
      if (action === "start" || action === "stop") {
        status[id] = action === "start" ? "RUNNING" : "STOPPED";
        return json({ id: "op-power" });
      }
      if (action === "logs") {
        return json({
          logs: [
            { timestamp: "2026-09-30T10:00:00Z", message: { message: "FATAL: no pg_hba.conf entry" } },
            { timestamp: "2026-09-30T10:00:01Z", message: { backend_type: "client backend", message: "connection received" } },
          ],
        });
      }
      if (sub === "/hosts") {
        return json({
          hosts: [
            { name: "rc1a-" + id + ".mdb.yandexcloud.net", clusterId: id, zoneId: "ru-central1-a", role: "MASTER", health: "ALIVE", resources: { diskSize: "21474836480" } },
            { name: "rc1b-" + id + ".mdb.yandexcloud.net", clusterId: id, zoneId: "ru-central1-b", role: "REPLICA", health: "ALIVE" },
          ],
        });
      }
      if (sub === "/databases") return json({ databases: [{ name: "db1", owner: "admin" }] });
      if (sub === "/users") return json({ users: [{ name: "admin", permissions: [{ databaseName: "db1" }], connLimit: "50" }] });
      if (sub === "/operations") {
        return json({ operations: [{ id: "op9", description: "Create PostgreSQL cluster", createdAt: "2026-08-01T09:00:00Z", done: true }] });
      }
      if (id === api + "-new") {
        return json({ id: id, name: "db-new", folderId: "folder-1", status: "CREATING", health: "HEALTH_UNKNOWN", config: { version: "16", resources: { resourcePresetId: "s2.micro", diskSize: "10737418240", diskTypeId: "network-ssd" } } });
      }
      if (deleted.has(id)) return json({ message: "Cluster not found" }, 404);
      const cl = clusters[id];
      if (!cl) return json({ message: "Cluster not found" }, 404);
      return json(Object.assign({}, cl, { status: status[id] }));
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server: server, calls: calls, created: created, base: "http://127.0.0.1:" + server.address().port }));
  });
}

const mdb = createYcMdb({
  fetchJson: yandex._fetchJson,
  endpoint: yandex.endpoint,
  getIamToken: yandex.getIamToken,
  waitOperation: yandex.waitOperation,
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
    ycMdb: mdb,
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
  const stub = await startMdbStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Три базы: имена, значения и адрес подключения");

  await test("ycMdb: база узнаётся по имени, включая «pg» и «постгрес»", () => {
    assert.deepStrictEqual(mdb.ENGINE_KEYS, ["postgresql", "mysql", "clickhouse"], "не те базы");
    assert.strictEqual(mdb.engineOf("postgresql").ru, "PostgreSQL");
    assert.strictEqual(mdb.engineOf("PG").key, "postgresql", "алиас pg не сработал");
    assert.strictEqual(mdb.engineOf("постгрес").key, "postgresql", "русское имя не сработало");
    assert.strictEqual(mdb.engineOf("MySQL").key, "mysql");
    assert.strictEqual(mdb.engineOf("клик").key, "clickhouse");
    assert.strictEqual(mdb.engineOf("oracle"), null, "незнакомая база не отвергнута");
    // Порт — часть адреса подключения, и у каждой базы он свой.
    assert.strictEqual(mdb.ENGINES.postgresql.port, 6432, "порт PostgreSQL: у Managed-кластера вход через пулер");
    assert.strictEqual(mdb.ENGINES.mysql.port, 3306);
    assert.strictEqual(mdb.ENGINES.clickhouse.port, 9440);
  });

  await test("ycMdb: байты, возраст и состояния переводятся словами", () => {
    assert.strictEqual(mdb.humanBytes("2147483648"), "2 ГБ");
    assert.strictEqual(mdb.humanBytes(5368709120), "5 ГБ");
    assert.strictEqual(mdb.humanBytes(""), "");
    assert.strictEqual(mdb.statusHuman("RUNNING"), "работает");
    assert.strictEqual(mdb.statusHuman("STOPPED"), "остановлен");
    assert.strictEqual(mdb.statusHuman("НЕВЕДОМОЕ"), "НЕВЕДОМОЕ", "незнакомое состояние должно показываться как есть");
    assert.strictEqual(mdb.healthHuman("DEGRADED"), "частично доступен");
    assert.strictEqual(mdb.isRunning("RUNNING"), true);
    assert.strictEqual(mdb.isRunning("STOPPED"), false);
    assert.strictEqual(mdb.isBusy("CREATING"), true, "создание — это «занят»");
    assert.strictEqual(mdb.isBusy("UPDATING"), true);
    assert.strictEqual(mdb.isBusy("RUNNING"), false);
    assert.ok(/дн|мес|г$/.test(mdb.humanUptime(new Date(Date.now() - 3 * 86400000).toISOString())), "возраст не посчитан");
  });

  await test("ycMdb: имя кластера проверяется по правилам облака", () => {
    assert.strictEqual(mdb.checkName("db-1"), "db-1");
    assert.throws(() => mdb.checkName(""), /Не указано имя/);
    assert.throws(() => mdb.checkName("1db"), /облако не примет/);
    assert.throws(() => mdb.checkName("Db_1"), /облако не примет/);
  });

  await test("ycMdb: пароль подходит облаку и не ломает строку подключения", () => {
    for (let i = 0; i < 40; i++) {
      const p = mdb.generatePassword();
      assert.ok(p.length >= 8 && p.length <= 128, "длина пароля вне правил: " + p.length);
      assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p), "в пароле нет нужного класса символов: " + p);
      assert.ok(!/["'`\\\s$]/.test(p), "пароль сломает строку подключения: " + p);
    }
  });

  await test("ycMdb: адрес подключения берётся у ХОСТА, а не у кластера", () => {
    const hosts = [
      { name: "rc1b-x.mdb.yandexcloud.net", role: "REPLICA" },
      { name: "rc1a-x.mdb.yandexcloud.net", role: "MASTER" },
    ];
    const pg = mdb.connection("postgresql", { name: "db-main" }, hosts, { database: "db1", user: "admin" });
    assert.strictEqual(pg.host, "rc1a-x.mdb.yandexcloud.net", "мастер не выбран");
    assert.strictEqual(pg.port, 6432);
    assert.ok(/host=rc1a-x\.mdb\.yandexcloud\.net port=6432 dbname=db1 user=admin sslmode=require/.test(pg.line), "строка подключения: " + pg.line);
    const my = mdb.connection("mysql", {}, hosts, {});
    assert.ok(/mysql --host rc1a-x\.mdb\.yandexcloud\.net --port 3306/.test(my.line), "mysql-строка: " + my.line);
    const ch = mdb.connection("clickhouse", {}, hosts, {});
    assert.strictEqual(ch.port, 9440);
    assert.ok(/clickhouse-client --host rc1a-x\.mdb\.yandexcloud\.net --port 9440 --secure/.test(ch.line), "clickhouse-строка: " + ch.line);
    // Хостов нет — строка пустая, а не выдуманный адрес.
    assert.strictEqual(mdb.connection("postgresql", {}, [], {}).line, "");
  });

  await test("ycMdb: КЛИКХАУС читается иначе — класс и диск внутри config.clickhouse", () => {
    const ch = mdb.clusterInfo({
      id: "ch-1", name: "analytics", status: "RUNNING",
      config: { version: "24.8", clickhouse: { resources: { resourcePresetId: "s3.medium", diskSize: "34359738368", diskTypeId: "network-ssd" } } },
    });
    assert.strictEqual(ch.version, "24.8");
    assert.strictEqual(ch.resourcePresetId, "s3.medium", "класс ClickHouse не найден (он лежит внутри config.clickhouse)");
    assert.strictEqual(ch.diskHuman, "32 ГБ");
    const pg = mdb.clusterInfo({ id: "pg-1", config: { version: "16", resources: { resourcePresetId: "s2.micro", diskSize: "10737418240" } } });
    assert.strictEqual(pg.resourcePresetId, "s2.micro", "класс обычной базы не найден");
    assert.strictEqual(pg.diskHuman, "10 ГБ");
  });

  console.log("\n[2] Чтение: пути, разбор ответов и отказы до сети");

  await test("ycMdb: список уходит по адресу своей базы, с каталогом и размером страницы", async () => {
    const before = stub.calls.length;
    const pg = await mdb.clusters("oauth-1", "postgresql", "folder-1");
    const my = await mdb.clusters("oauth-1", "mysql", "folder-1");
    const ch = await mdb.clusters("oauth-1", "clickhouse", "folder-1");
    assert.strictEqual(pg.length, 3);
    assert.strictEqual(my.length, 1);
    assert.strictEqual(ch.length, 1);
    assert.ok(stub.calls.slice(before).some((c) => c.url === "/managed-postgresql/v1/clusters?folderId=folder-1&pageSize=1000"), "путь PostgreSQL");
    assert.ok(stub.calls.slice(before).some((c) => c.url === "/managed-mysql/v1/clusters?folderId=folder-1&pageSize=1000"), "путь MySQL");
    assert.ok(stub.calls.slice(before).some((c) => c.url === "/managed-clickhouse/v1/clusters?folderId=folder-1&pageSize=1000"), "путь ClickHouse");
    assert.strictEqual(pg[0].name, "db-main");
    assert.strictEqual(pg[0].running, true);
  });

  await test("ycMdb: карточка, хосты, базы и пользователи — своими путями", async () => {
    const cl = await mdb.findCluster("oauth-1", "postgresql", "folder-1", "db-main");
    assert.strictEqual(cl.id, "pg-1");
    const one = await mdb.cluster("oauth-1", "postgresql", "pg-1");
    assert.strictEqual(one.version, "16");
    const hs = await mdb.hosts("oauth-1", "postgresql", "pg-1");
    assert.strictEqual(hs.length, 2);
    assert.strictEqual(hs[0].roleHuman, "мастер", "роль хоста не переведена");
    assert.strictEqual(hs[1].roleHuman, "реплика");
    assert.strictEqual(hs[0].diskHuman, "20 ГБ");
    const dbs = await mdb.databases("oauth-1", "postgresql", "pg-1");
    assert.deepStrictEqual(dbs, [{ name: "db1", owner: "admin" }]);
    const us = await mdb.users("oauth-1", "postgresql", "pg-1");
    assert.deepStrictEqual(us.map((u) => u.name), ["admin"]);
    assert.deepStrictEqual(us[0].permissions, ["db1"]);
    assert.ok(stub.calls.some((c) => c.url === "/managed-postgresql/v1/clusters/pg-1/hosts"), "путь хостов");
    assert.ok(stub.calls.some((c) => c.url === "/managed-postgresql/v1/clusters/pg-1/databases"), "путь баз");
    assert.ok(stub.calls.some((c) => c.url === "/managed-postgresql/v1/clusters/pg-1/users"), "путь пользователей");
    // Паролей в ответе нет и быть не может: облако их в чтении не отдаёт.
    assert.ok(!/password/i.test(JSON.stringify(us)), "в списке пользователей появился пароль");
  });

  await test("ycMdb: логи уходят GET-ом со временем БЕЗ миллисекунд и типом логов", async () => {
    const before = stub.calls.length;
    const r = await mdb.logs("oauth-1", "postgresql", "pg-1", { minutes: 30, serviceType: "postgresql", limit: 50 });
    const url = stub.calls.slice(before).find((c) => c.url.indexOf(":logs") >= 0).url;
    assert.ok(url.startsWith("/managed-postgresql/v1/clusters/pg-1:logs?"), "путь логов: " + url);
    assert.ok(/fromTime=[^&]*T[^&]*Z/.test(url) && !/%2E%2E%2E|\.\d{3}Z/.test(decodeURIComponent(url)), "время с миллисекундами: " + decodeURIComponent(url));
    assert.ok(/toTime=/.test(url) && /pageSize=50/.test(url) && /serviceType=POSTGRESQL/.test(url), "строка логов неполная: " + decodeURIComponent(url));
    assert.strictEqual(r.rows.length, 2);
    assert.ok(/no pg_hba/.test(r.rows[0].text), "одна колонка в message должна читаться как текст");
    assert.ok(/backend_type=client backend/.test(r.rows[1].text), "несколько колонок должны читаться парами «колонка=значение»");
    assert.ok(r.from && r.to && r.minutes === 30);
  });

  await test("ycMdb: классы хостов и операции читаются, а не выдумываются", async () => {
    const presets = await mdb.presets("oauth-1", "postgresql");
    assert.strictEqual(presets[0].id, "s2.micro");
    assert.strictEqual(presets[0].memoryHuman, "8 ГБ");
    assert.ok(stub.calls.some((c) => c.url === "/managed-postgresql/v1/resourcePresets?pageSize=1000"), "путь классов");
    const ops = await mdb.operations("oauth-1", "postgresql", "pg-1", {});
    assert.strictEqual(ops[0].id, "op9");
    assert.strictEqual(ops[0].done, true);
    assert.ok(/Create PostgreSQL cluster/.test(ops[0].description));
  });

  await test("ycMdb: пустой каталог и незнакомая база — отказ до сети (негативный контроль)", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => mdb.clusters("oauth-1", "postgresql", ""), /Не выбран каталог/);
    await assert.rejects(() => mdb.clusters("oauth-1", "oracle", "folder-1"), /Неизвестная база/);
    await assert.rejects(() => mdb.cluster("oauth-1", "postgresql", ""), /Не указан id кластера/);
    await assert.rejects(() => mdb.hosts("oauth-1", "postgresql", ""), /Не указан id кластера/);
    await assert.rejects(() => mdb.power("oauth-1", "postgresql", "перезагрузить", "pg-1", {}), /неизвестное действие/);
    assert.strictEqual(stub.calls.length, before, "при ошибке всё-таки ушли запросы");
  });

  console.log("\n[3] Питание: идемпотентность и занятый кластер");

  await test("ycMdb: «уже работает» и «уже остановлен» — это не ошибка, а ответ", async () => {
    const before = stub.calls.length;
    const started = await mdb.power("oauth-1", "postgresql", "start", "db-main", { folderId: "folder-1" });
    assert.strictEqual(started.changed, false);
    assert.ok(/уже работает/.test(started.message), started.message);
    assert.strictEqual(callsTo({ calls: stub.calls.slice(before) }, ":start").length, 0, "на «уже работает» ушёл запрос питания");
    const stopped = await mdb.power("oauth-1", "postgresql", "stop", "db-protected", { folderId: "folder-1" });
    assert.strictEqual(stopped.changed, false);
    assert.ok(/уже остановлен/.test(stopped.message), stopped.message);
  });

  await test("ycMdb: stop уходит POST-ом :stop и говорит, что диск всё равно платный", async () => {
    const r = await mdb.power("oauth-1", "mysql", "stop", "mysql-main", { folderId: "folder-1" });
    assert.strictEqual(r.changed, true);
    assert.ok(stub.calls.some((c) => c.method === "POST" && c.url === "/managed-mysql/v1/clusters/my-1:stop"), "путь :stop");
    assert.ok((r.warnings || []).some((w) => /диск и резервные копии/.test(w)), "не сказано про платный диск: " + JSON.stringify(r.warnings));
    const after = await mdb.cluster("oauth-1", "mysql", "my-1");
    assert.strictEqual(after.statusHuman, "остановлен", "состояние не перечитано");
  });

  await test("ycMdb: занятый кластер (идёт переход) отбивается до сети", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => mdb.power("oauth-1", "postgresql", "start", "db-busy", { folderId: "folder-1" }), /сейчас занят/);
    assert.strictEqual(callsTo({ calls: stub.calls.slice(before) }, ":start").length, 0, "питание ушло занятому кластеру");
  });

  console.log("\n[4] Создание и удаление: тело запроса, секрет и отказы");

  await test("ycMdb: PostgreSQL создаётся с базой, владельцем и паролем; сеть берётся из подсети", async () => {
    const r = await mdb.create("oauth-1", "postgresql", {
      folderId: "folder-1", name: "db-new", version: "16", preset: "s2.micro", diskGb: 10, subnet: "app-subnet",
    });
    const made = stub.created[stub.created.length - 1];
    assert.strictEqual(made.api, "managed-postgresql");
    assert.strictEqual(made.body.folderId, "folder-1");
    assert.strictEqual(made.body.name, "db-new");
    assert.strictEqual(made.body.networkId, "net-1", "сеть не определена по подсети");
    assert.strictEqual(made.body.hostSpecs[0].subnetId, "app-subnet");
    assert.strictEqual(made.body.hostSpecs[0].zoneId, "ru-central1-a");
    assert.strictEqual(made.body.configSpec.version, "16");
    assert.strictEqual(made.body.configSpec.resources.resourcePresetId, "s2.micro");
    assert.strictEqual(made.body.configSpec.resources.diskSize, "10737418240");
    assert.deepStrictEqual(made.body.databaseSpecs, [{ name: "db1", owner: "admin" }]);
    assert.strictEqual(made.body.userSpecs[0].name, "admin");
    assert.ok(String(made.body.userSpecs[0].password).length >= 8, "пользователь создан без пароля");
    assert.strictEqual(r.secret, made.body.userSpecs[0].password, "пароль наружу ушёл не тот, что уехал в облако");
    assert.ok((r.warnings || []).some((w) => /тарифицируются почасово/.test(w)), "нет предупреждения о цене");
    assert.ok((r.warnings || []).some((w) => /ОДИН раз/.test(w)), "не сказано, что пароль показывается один раз");
  });

  await test("ycMdb: ClickHouse создаётся иначе — класс внутри config.clickhouse, админу пароль", async () => {
    const r = await mdb.create("oauth-1", "clickhouse", {
      folderId: "folder-1", name: "ch-new", version: "24.8", preset: "s3.medium", diskGb: 32, subnet: "sub-1",
    });
    const made = stub.created[stub.created.length - 1];
    assert.strictEqual(made.api, "managed-clickhouse");
    assert.strictEqual(made.body.configSpec.version, "24.8");
    assert.strictEqual(made.body.configSpec.clickhouse.resources.resourcePresetId, "s3.medium", "класс ClickHouse ушёл не туда");
    assert.strictEqual(made.body.configSpec.resources, undefined, "у ClickHouse не бывает configSpec.resources");
    assert.ok(String(made.body.configSpec.adminPassword).length >= 8, "у ClickHouse не выставлен adminPassword");
    assert.strictEqual(made.body.hostSpecs[0].type, "CLICKHOUSE");
    assert.strictEqual(made.body.userSpecs, undefined, "ClickHouse не принимает databaseSpecs/userSpecs как PostgreSQL");
    assert.strictEqual(r.secret, made.body.configSpec.adminPassword, "наружу ушёл не пароль администратора");
    assert.strictEqual(r.user, "admin");
  });

  await test("ycMdb: MySQL создаётся как PostgreSQL, но по своему пути", async () => {
    const r = await mdb.create("oauth-1", "mysql", {
      folderId: "folder-1", name: "my-new", version: "8.0", preset: "s2.micro", subnet: "app-subnet", diskGb: 20,
    });
    const made = stub.created[stub.created.length - 1];
    assert.strictEqual(made.api, "managed-mysql");
    assert.ok(made.body.configSpec.resources, "у MySQL класс должен стоять рядом с версией");
    assert.ok(r.message.indexOf("MySQL") >= 0, "в ответе не названа база: " + r.message);
  });

  await test("ycMdb: создание без версии, класса или подсети — отказ ДО сети", async () => {
    const before = stub.created.length;
    const callsBefore = stub.calls.length;
    await assert.rejects(() => mdb.create("oauth-1", "postgresql", { folderId: "folder-1", name: "db-x", preset: "s2.micro", subnet: "app-subnet" }), /Не указана версия базы/);
    await assert.rejects(() => mdb.create("oauth-1", "postgresql", { folderId: "folder-1", name: "db-x", version: "16", subnet: "app-subnet" }), /Не указан класс хоста/);
    await assert.rejects(() => mdb.create("oauth-1", "postgresql", { folderId: "folder-1", name: "db-x", version: "16", preset: "s2.micro" }), /Не указана подсеть/);
    await assert.rejects(() => mdb.create("oauth-1", "postgresql", { folderId: "folder-1", name: "Плохое Имя", version: "16", preset: "s2.micro", subnet: "app-subnet" }), /облако не примет/);
    assert.strictEqual(stub.created.length, before, "при отказе кластер всё-таки создавался");
    assert.strictEqual(stub.calls.length, callsBefore, "при отказе всё-таки ушли запросы");
  });

  await test("ycMdb: удаление необратимо, но защита от удаления останавливает его ДО сети", async () => {
    const before = stub.calls.filter((c) => c.method === "DELETE").length;
    await assert.rejects(() => mdb.remove("oauth-1", "postgresql", { name: "db-protected", folderId: "folder-1" }), /защита от удаления/);
    assert.strictEqual(stub.calls.filter((c) => c.method === "DELETE").length, before, "удаление ушло защищённому кластеру");
    const r = await mdb.remove("oauth-1", "postgresql", { name: "db-main", folderId: "folder-1" });
    assert.strictEqual(r.deleted, true);
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url === "/managed-postgresql/v1/clusters/pg-1"), "путь удаления");
    assert.ok((r.warnings || []).some((w) => /Резервные копии удалены/.test(w)), "не сказано про резервные копии: " + JSON.stringify(r.warnings));
  });

  console.log("\n[5] Карточка и инструмент агента");

  await test("ycMdb: карточка собирает состояние, хосты и готовую строку подключения", async () => {
    const r = await mdb.cardLines("oauth-1", "postgresql", "db-main", { folderId: "folder-1" });
    const text = r.lines.join("\n");
    assert.strictEqual(r.cluster.id, "pg-1");
    assert.strictEqual(r.hosts.length, 2);
    assert.ok(/Кластер «db-main»/.test(text), text);
    assert.ok(/Хосты \(2\)/.test(text), "в карточке нет хостов");
    assert.ok(/Подключение: psql "host=rc1a-pg-1\.mdb\.yandexcloud\.net port=6432/.test(text), "в карточке нет строки подключения: " + text);
  });

  await test("ycMdb (агент): overview без engine показывает все три базы сразу", async () => {
    const { tools } = buildTools();
    const out = await tools.ycMdb({ action: "overview" });
    assert.ok(/PostgreSQL — 3 кластер/.test(out), out);
    assert.ok(/MySQL — 1 кластер/.test(out), out);
    assert.ok(/ClickHouse — 1 кластер/.test(out), out);
    assert.ok(/Всего кластеров: 5/.test(out), out);
    assert.ok(/confirm: true/.test(out) && /тарифицируется почасово/.test(out), "не сказано про платное создание");
    assert.ok(/stop/.test(out) && /резервные копии/.test(out), "не сказано, что остановка не бесплатна");
  });

  await test("ycMdb (агент): чужие действия и отсутствие каталога отбиваются словами", async () => {
    const { tools } = buildTools();
    const bad = await tools.ycMdb({ action: "vacuum" });
    assert.ok(/неизвестное действие/.test(bad) && /create/.test(bad), bad);
    const noEngine = await tools.ycMdb({ action: "presets" });
    assert.ok(/укажи engine/.test(noEngine), noEngine);
    const noFolder = buildTools({ ycFolderId: "" }).tools;
    const out = await noFolder.ycMdb({ action: "overview" });
    assert.ok(/выбери каталог/.test(out), out);
  });

  await test("ycMdb (агент): создание без согласия — не отказ, а цена и вопрос", async () => {
    const { tools } = buildTools();
    const before = stub.created.length;
    const out = await tools.ycMdb({ action: "create", engine: "postgresql", name: "db-x", version: "16", preset: "s2.micro", subnet: "app-subnet" });
    assert.ok(/ПЛАТНОЕ/.test(out), out);
    assert.ok(/confirm: true/.test(out), out);
    assert.ok(/ОДИН раз/.test(out), "не сказано, что пароль показывается один раз");
    assert.strictEqual(stub.created.length, before, "кластер создался без согласия");
    const missing = await tools.ycMdb({ action: "create", engine: "postgresql", name: "db-x" });
    assert.ok(/нужно указать/.test(missing) && /version/.test(missing) && /preset/.test(missing) && /subnet/.test(missing), missing);
  });

  await test("ycMdb (агент): удаление без согласия перечисляет последствия и не трогает облако", async () => {
    const { tools } = buildTools();
    const before = stub.calls.filter((c) => c.method === "DELETE").length;
    const out = await tools.ycMdb({ action: "delete", engine: "postgresql", cluster: "db-main" });
    assert.ok(/НЕОБРАТИМО/.test(out) && /РЕЗЕРВНЫЕ КОПИИ/.test(out), out);
    assert.ok(/confirm: true/.test(out), out);
    assert.strictEqual(stub.calls.filter((c) => c.method === "DELETE").length, before, "удаление ушло без согласия");
    const prot = await tools.ycMdb({ action: "delete", engine: "postgresql", cluster: "db-protected", confirm: true });
    assert.ok(/защита от удаления|deletionProtection/.test(prot), prot);
  });

  await test("ycMdb (агент): логи и пользователи отвечают честно, а не пустой строкой", async () => {
    const { tools } = buildTools();
    const users = await tools.ycMdb({ action: "users", engine: "postgresql", cluster: "db-main" });
    assert.ok(/admin/.test(users), users);
    assert.ok(/пароли облако в чтении не отдаёт/i.test(users), "не сказано про пароли: " + users);
    const logs = await tools.ycMdb({ action: "logs", engine: "postgresql", cluster: "db-main", minutes: 15 });
    assert.ok(/no pg_hba/.test(logs), logs);
    assert.ok(/за 15 мин/.test(logs), logs);
    const card = await tools.ycMdb({ action: "card", engine: "clickhouse", cluster: "analytics" });
    assert.ok(/24\.8/.test(card) && /s3\.medium/.test(card), "карточка ClickHouse без класса: " + card);
  });

  console.log("\n[6] Интерфейс: канал, семейства, плитки и иконки");

  await test("yc:mdb: канал есть в мосте, а из main.js убран; формы и сводка — в окне", () => {
    assert.ok(IPC_SRC.indexOf('ipcMain.handle("yc:mdb"') > 0, "нет канала yc:mdb");
    assert.ok(!MAIN_SRC.includes('ipcMain.handle("yc:mdb"'), "канал остался в main.js");
    assert.ok(/ycMdb: \(args\) => ipcRenderer\.invoke\("yc:mdb"/.test(PRELOAD_SRC), "окно не видит канал yc:mdb");
    assert.ok(/ycMdb,\n\s+readYcLogsText/.test(MAIN_SRC) || /ycMdb,/.test(MAIN_SRC), "модуль не передан инструментам");
    assert.ok(/const ycMdb = createYcMdb\(/.test(MAIN_SRC), "модуль Managed-баз не собран в main.js");
    assert.ok(/registerYcIpc\(\{[\s\S]{0,400}?ycMdb,/.test(MAIN_SRC), "канал IPC не получает модуль Managed-баз");
    // Отказ канала обязан знать ровно те действия, что перечислены в yc-actions.
    // Список у этого канала — ОДНА правда: массив ALL, и текст отказа собирается
    // из него же (`join`). Поэтому разбор идёт и по массиву, и по тому, что отказ
    // называет именно его: копии списка в тексте нет, и разойтись им негде.
    const sec = section(IPC_SRC, "yc:mdb");
    const allowed = (sec.match(/const ALL = \[([^\]]+)\];/) || [])[1];
    assert.ok(allowed, "в канале нет списка доступных действий");
    assert.ok(/Доступно:\s*" \+ ALL\.join\(", "\)/.test(sec), "отказ канала не называет действия из ALL");
    assert.deepStrictEqual(allowed.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).sort(), ["card", "create", "databases", "delete", "hosts", "list", "logs", "operations", "presets", "start", "stop", "users"].sort());
    assert.ok(/needsConfirm: true/.test(sec) && /a\.confirm !== true/.test(sec), "канал не спрашивает согласие на платное");
    assert.ok(/secret: r\.secret/.test(sec), "пароль создания не уходит окну отдельным полем");
  });

  await test("yc-actions: три семейства в одном канале, engine подставляется формой", () => {
    const vm = require("vm");
    const ctx = { window: {}, document: undefined, navigator: {}, console: console };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(ACTIONS_SRC, ctx, { filename: "yc-actions.js" });
    const A = ctx.window.YcActions;
    for (const key of ["postgresql", "mysql", "clickhouse"]) {
      assert.strictEqual(A.CHANNELS[key], "ycMdb", "семейство " + key + " смотрит не в тот канал");
      const ids = A.forService(key);
      for (const need of ["list", "presets", "card", "create", "hosts", "databases", "users", "logs", "operations", "start", "stop", "delete"]) {
        assert.ok(ids.indexOf(need) >= 0, "у " + key + " нет действия " + need);
      }
      const d = A.describe(key, "create");
      assert.strictEqual(d.paid, true, key + ": создание не помечено платным");
      assert.strictEqual(d.confirmArg, "confirm");
      assert.ok(d.fields.indexOf("name") >= 0 && d.fields.indexOf("preset") >= 0 && d.fields.indexOf("subnet") >= 0, key + ": в форме создания нет обязательных полей");
      // Действие «удалить» — необратимое, и это видно по описанию.
      assert.strictEqual(A.describe(key, "delete").danger, true, key + ": удаление не помечено опасным");
      // engine берётся из семейства: кнопка на плитке уже знает, какая это база.
      // Негативный контроль: без fixed запрос ушёл бы без engine.
      const req = A.request(key, "list", {}, false);
      assert.strictEqual(req.args.engine, key, "engine не подставлен: " + JSON.stringify(req.args));
      assert.strictEqual(req.args.op, "list");
      const confirmed = A.request(key, "create", { name: "db-1" }, true);
      assert.strictEqual(confirmed.args.confirm, true, "подтверждение не ушло");
      const notConfirmed = A.request(key, "create", { name: "db-1" }, false);
      assert.strictEqual(notConfirmed.args.confirm, undefined, "лишний confirm: false сбил бы проверку канала");
    }
  });

  await test("полка: три плитки, официальные иконки и русские формы слова", () => {
    const keys = ["postgresql", "mysql", "clickhouse"];
    for (const k of keys) {
      const svc = yandex.SERVICES.find((s) => s.key === k);
      assert.ok(svc, "нет сервиса " + k + " в SERVICES");
      assert.ok(/[А-Яа-яЁё]/.test(svc.ru), "плитка названа не по-русски: " + svc.ru);
      assert.ok(svc.svc.indexOf("managed-") === 0, "плитка ходит не в сервис Managed-*: " + svc.svc);
      assert.ok(svc.listPath.indexOf("/clusters") >= 0, "плитка смотрит не на кластеры: " + svc.listPath);
      // Адрес сервиса лежит в KNOWN_ENDPOINTS (наружу не экспортируется): без
      // него первый же опрос ждал бы каталог эндпоинтов.
      assert.ok(new RegExp('"' + svc.svc + '": "https://mdb\\.api\\.cloud\\.yandex\\.net"').test(YANDEX_SRC), "нет выверенного адреса для " + svc.svc);
      assert.ok(LOGOS.has(k), "у плитки " + k + " нет официальной иконки");
      assert.ok(/viewBox="0 0 32 32"/.test(LOGOS.LOGOS[k]), "иконка " + k + " не 32×32");
      assert.ok(LOGOS.isSafe(LOGOS.LOGOS[k]), "в иконке " + k + " что-то исполняемое");
      // Консоль и дашборд обязаны видеть ОДИН набор сервисов (сторожит smoke).
      assert.ok(ycConsole.SERVICE_ENDPOINT[k], "консоль не знает сервис " + k);
      assert.ok(ycConsole.DETAIL_PATHS[k], "у карточки " + k + " нет пути");
      assert.ok(Array.isArray(ycConsole.RELATIONS[k]) && ycConsole.RELATIONS[k].length >= 3, "у " + k + " нет связей (хосты, базы, пользователи)");
      assert.ok(PANEL_SRC.indexOf(k + ': ["кластер"') > 0, "в полке нет русской формы слова для " + k);
    }
    const rel = ycConsole.RELATIONS.postgresql.map((r) => r.key).sort();
    assert.deepStrictEqual(rel, ["databases", "hosts", "users"], "связи PostgreSQL: " + rel.join(", "));
    assert.ok(ycConsole.RELATIONS.postgresql.find((r) => r.key === "hosts").attempts[0].path({ id: "pg-1" }).indexOf("/managed-postgresql/v1/clusters/pg-1/hosts") === 0, "путь хостов в консоли");
    assert.ok(ycConsole.RELATIONS.clickhouse.find((r) => r.key === "databases").attempts[0].path({ id: "ch-1" }).indexOf("/managed-clickhouse/") === 0, "консоль ходит не в тот сервис");
  });

  console.log("\n[7] Согласованность: схема, промпт, политика, справочник");

  await test("ycMdb: схема, группа «облако», промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycMdb"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 6200);
    for (const part of ["action", "engine", "cluster", "version", "preset", "subnet", "userPassword", "confirm", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/ПАРОЛЬ/.test(schema) && /ОДИН РАЗ/.test(schema), "схема молчит про то, что пароль показывается один раз");
    assert.ok(/необратимо/.test(schema) && /deletionProtection/.test(schema), "схема молчит про необратимость удаления");
    assert.ok(/6432/.test(schema) && /9440/.test(schema), "схема не говорит порты подключения");
    const groupAt = CORE_SRC.indexOf('id: "cloud"');
    assert.ok(groupAt > 0 && CORE_SRC.slice(groupAt, groupAt + 1400).includes('"ycMdb"'), "инструмента нет в группе «облако»");
    assert.ok(/postgresql/.test(CORE_SRC.slice(groupAt, groupAt + 1400)), "в ключевых словах группы нет баз данных");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycMdb/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycMdb \(УПРАВЛЯЕМЫЕ БАЗЫ/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycMdb");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 300).includes('"ycMdb"'), "нет назначения cloud.read для ycMdb");
    assert.ok(SMOKE_SRC.includes('"yc:mdb"'), "smoke-набор не знает про канал yc:mdb");
  });

  await test("ycMdb: справочник агента учит формам, деньгам и паролю", () => {
    assert.ok(/ycMdb/.test(GUIDE_SRC), "в yc.md нет ycMdb");
    assert.ok(/ИМЯ ХОСТА/.test(GUIDE_SRC), "в yc.md не сказано, что адрес подключения — это хост");
    assert.ok(/ПАРОЛЬ пользователя облако отдаёт РОВНО ОДИН раз/.test(GUIDE_SRC), "в yc.md не сказано про пароль");
    assert.ok(/создание ПЛАТНОЕ/.test(GUIDE_SRC) && /presets/.test(GUIDE_SRC), "в yc.md нет правила про цену и класс");
    assert.ok(/deletionProtection/.test(GUIDE_SRC), "в yc.md не сказано про защиту от удаления");
  });

  await test("ycMdb: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-mdb.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало" + (failed ? " — есть ошибки" : ""));
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ── Группы логов Cloud Logging: создать, поправить, удалить и посмотреть ──────
   Запуск: node test/yc-log-groups.test.js   (входит в общий `npm test`)

   Зачем набор. Сервис «Логи» на полке уже был, но показывал только список:
   создать лог-группу из окна было нечем. Между тем группа — это «куда собирать
   логи», и без неё ни ревизия контейнера, ни разбор запросов балансировщика
   некуда направить. Заход 11 части 91 закрыл это в четырёх слоях.

   Главная тонкость. Записи логирования HTTP-привязки НЕ имеют (только gRPC —
   канал yc:logs), а вот сами лог-группы — обычный REST того же хоста
   (logging.api.cloud.yandex.net), и изменяющие методы возвращают OPERATION,
   который надо ДОЖДАТЬСЯ (waitOperation). Набор проверяет именно это: тело
   создания, маску правки (без неё облако сбросило бы неназванное), двухшаговое
   удаление и то, что чужое действие отвергается словами, а не молчанием.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE уводит туда и logging, и operation). */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
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
const ycLogs = require(path.join(ROOT, "src", "yc-logs.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const { createYcService } = require(path.join(ROOT, "src", "yc-service.js"));
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const POLICY_SRC = read("src", "tool-policy.js");
const SMOKE_SRC = require(path.join(__dirname, "smoke", "source.js"));
const PKG = JSON.parse(read("package.json"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "yc-logs-work-"));

// ── Подменённое облако: REST лог-групп + operations ─────────────────────────
function startLogStub() {
  const calls = [];
  const state = {
    groups: [
      {
        id: "grp1",
        folderId: "f1",
        name: "app-logs",
        description: "Логи приложения",
        status: "ACTIVE",
        createdAt: "2026-09-01T10:00:00Z",
        retentionPeriod: "720h",
        labels: { env: "prod" },
      },
    ],
  };
  let seq = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const raw = req.url || "";
      calls.push({ method: req.method, url: raw, body: body.toString("utf8") });
      const json = (o) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (raw.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (raw.indexOf("/operations/") >= 0) {
        return json({ id: raw.split("/").pop(), done: true, response: {} });
      }
      const op = (response) => ({ id: "op-" + ++seq, done: true, response: response || null });
      const one = /^\/logging\/v1\/logGroups\/([^?]+)/.exec(raw);
      if (one) {
        const id = decodeURIComponent(one[1]);
        const g = state.groups.find((x) => x.id === id);
        if (!g) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ message: "not found" }));
        }
        if (req.method === "PATCH") {
          let sent = {};
          try {
            sent = JSON.parse(body.toString("utf8") || "{}");
          } catch {}
          // Без маски настоящий сервис сбросил бы неназванное — это и проверяем.
          if (!sent.updateMask) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ message: "updateMask is required" }));
          }
          for (const f of String(sent.updateMask).split(",")) {
            if (f === "name" && sent.name != null) g.name = sent.name;
            if (f === "description" && sent.description != null) g.description = sent.description;
            if (f === "retention_period" && sent.retentionPeriod != null) g.retentionPeriod = sent.retentionPeriod;
            if (f === "data_stream" && sent.dataStream != null) g.dataStream = sent.dataStream;
            if (f === "labels" && sent.labels != null) g.labels = sent.labels;
          }
          return json(op(g));
        }
        if (req.method === "DELETE") {
          state.groups = state.groups.filter((x) => x.id !== id);
          return json(op(null));
        }
        return json(g);
      }
      if (raw.indexOf("/logging/v1/logGroups") >= 0) {
        if (req.method === "POST") {
          let sent = {};
          try {
            sent = JSON.parse(body.toString("utf8") || "{}");
          } catch {}
          const g = {
            id: "grp-" + ++seq,
            folderId: sent.folderId,
            name: sent.name,
            description: sent.description || "",
            status: "CREATING",
            retentionPeriod: sent.retentionPeriod || "",
            dataStream: sent.dataStream || "",
            labels: sent.labels || {},
          };
          state.groups.push(g);
          return json(op(g));
        }
        return json({ groups: state.groups });
      }
      return json({});
    });
  });
  return new Promise((r) => {
    const reset = () => {
      state.groups = [
        { id: "grp1", folderId: "f1", name: "app-logs", description: "Логи приложения", status: "ACTIVE", createdAt: "2026-09-01T10:00:00Z", retentionPeriod: "720h", labels: { env: "prod" } },
      ];
    };
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

// ── Инструмент агента на подменённом облаке ─────────────────────────────────
function buildTool(settingsOver, cloudOver) {
  const settings = Object.assign(
    { yandexOauthToken: "oauth-1", ycFolderId: "f1", ycFolderName: "prod", ycAllowAgentCreate: false, ycAllowAgentDelete: false, ycAllowAgentUpdate: false },
    settingsOver || {}
  );
  const cloud = Object.assign(
    {
      endpoint: async () => stub.base,
      getIamToken: async () => "iam-1",
      waitOperation: async () => ({ response: {} }),
    },
    cloudOver || {}
  );
  const tools = createCloudTools({
    ycDb: {},
    path,
    fs,
    yandexCloud: cloud,
    ycLogs: ycLogs,
    ycJsonArg: (v) => {
      if (v == null) return undefined;
      if (typeof v === "object") return v;
      if (typeof v === "string") {
        try {
          const j = JSON.parse(v.trim());
          return j && typeof j === "object" ? j : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    readYcLogsText: async () => "Логи за последние 3 ч — 1 запись.",
    resolvePath: (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(work, String(p))),
    agentWorkDir: () => work,
    ycConfig: (s) => {
      const st = s || settings;
      return {
        oauth: String(st.yandexOauthToken || ""),
        folderId: st.ycFolderId || "",
        folderName: st.ycFolderName || "",
        allowCreate: !!st.ycAllowAgentCreate,
        allowDelete: !!st.ycAllowAgentDelete,
        allowUpdate: !!st.ycAllowAgentUpdate,
      };
    },
    loadSettings: () => settings,
  });
  return { tools, settings };
}

let stub = null;

(async function main() {
  stub = await startLogStub();

  console.log("\n[1] Модуль yc-logs.js: REST лог-групп и мелочи формы");

  await test("yc-logs: срок хранения — часы в длительность, пусто/0 — без срока", () => {
    assert.strictEqual(ycLogs.retentionOf(720), "720h", "число часов не стало длительностью");
    assert.strictEqual(ycLogs.retentionOf("48"), "48h", "строка часов не стала длительностью");
    assert.strictEqual(ycLogs.retentionOf(0), "", "ноль должен значить «без срока»");
    assert.strictEqual(ycLogs.retentionOf(""), "", "пусто должно значить «без срока»");
    assert.strictEqual(ycLogs.retentionOf("1h30m"), "1h30m", "готовая длительность должна пройти как есть");
  });

  await test("yc-logs: строка группы называет имя, статус, срок и поток", () => {
    const line = ycLogs.logGroupLine({ id: "grp1", name: "app-logs", status: "ACTIVE", retentionPeriod: "720h", dataStream: "ds-1" });
    assert.ok(/app-logs/.test(line) && /ACTIVE/.test(line) && /720h/.test(line) && /ds-1/.test(line), "строка потеряла поля: " + line);
    assert.ok(/без срока/.test(ycLogs.logGroupLine({ id: "g", name: "x" })), "отсутствие срока не названо");
  });

  await test("yc-logs: список, карточка и ОТКАЗЫ до сети (пустое имя, плохое имя, нечего менять)", async () => {
    stub.reset();
    const iam = "iam-1";
    const groups = await ycLogs.listLogGroups(iam, stub.base, "f1");
    assert.ok(groups.length === 1 && groups[0].name === "app-logs", "список лог-групп не прочитан: " + JSON.stringify(groups));

    const one = await ycLogs.getLogGroup(iam, stub.base, "grp1");
    assert.ok(one.name === "app-logs" && one.description === "Логи приложения" && one.retentionPeriod === "720h", "карточка группы не прочитана: " + JSON.stringify(one));

    await assert.rejects(() => ycLogs.createLogGroup(iam, stub.base, { folderId: "f1" }), /name/, "создание без имени не отвергнуто");
    await assert.rejects(() => ycLogs.createLogGroup(iam, stub.base, { folderId: "f1", name: "Плохое Имя" }), /имя лог-группы/, "плохое имя не отвергнуто до сети");
    await assert.rejects(() => ycLogs.updateLogGroup(iam, stub.base, "grp1", {}), /нечего менять/, "правка без полей не отвергнута");
    await assert.rejects(() => ycLogs.getLogGroup(iam, stub.base, ""), /id/, "пустой id не отвергнут");
  });

  await test("yc-logs: создание телом, правка МАСКОЙ и удаление — настоящие REST-запросы", async () => {
    stub.reset();
    const iam = "iam-1";
    stub.calls.length = 0;
    const op = await ycLogs.createLogGroup(iam, stub.base, { folderId: "f1", name: "new-logs", description: "новые", retentionPeriod: 24, labels: { env: "dev" } });
    assert.ok(op && op.id, "создание не вернуло операцию: " + JSON.stringify(op));
    const posted = stub.calls.find((c) => c.method === "POST" && c.url.indexOf("/logging/v1/logGroups") >= 0);
    assert.ok(posted, "POST создания не ушёл");
    const sent = JSON.parse(posted.body);
    assert.strictEqual(sent.folderId, "f1", "не ушёл каталог");
    assert.strictEqual(sent.name, "new-logs", "не ушло имя");
    assert.strictEqual(sent.retentionPeriod, "24h", "часы не стали длительностью");
    assert.deepStrictEqual(sent.labels, { env: "dev" }, "не ушли метки");

    stub.calls.length = 0;
    await ycLogs.updateLogGroup(iam, stub.base, "grp1", { description: "другое" });
    const patched = stub.calls.find((c) => c.method === "PATCH");
    assert.ok(patched, "PATCH правки не ушёл");
    const pbody = JSON.parse(patched.body);
    assert.strictEqual(pbody.updateMask, "description", "маска назвала не то: " + pbody.updateMask);
    assert.strictEqual(pbody.description, "другое", "описание не ушло");

    stub.calls.length = 0;
    await ycLogs.deleteLogGroup(iam, stub.base, "grp1");
    assert.ok(stub.calls.some((c) => c.method === "DELETE"), "DELETE удаления не ушёл");
  });

  console.log("\n[2] Инструмент агента ycLogs: группы под разрешениями");

  await test("ycLogs: список и карточка группы читаются, чужое действие названо списком", async () => {
    stub.reset();
    const { tools } = buildTool({ ycAllowAgentCreate: true });
    const groups = await tools.ycLogs({ action: "groups" }, {});
    assert.ok(/app-logs/.test(groups) && /Лог-группы каталога/.test(groups), "список групп не показан: " + groups.slice(0, 160));
    const card = await tools.ycLogs({ action: "group", group: "app-logs" }, {});
    assert.ok(/720h/.test(card) && /Логи приложения/.test(card), "карточка группы не показана: " + card.slice(0, 200));
    const bad = await tools.ycLogs({ action: "стереть" }, {});
    assert.ok(/неизвестное действие ycLogs/.test(bad) && /createGroup/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 200));
  });

  await test("ycLogs: создание, правка и удаление заперты разрешениями ДО сети", async () => {
    stub.reset();
    const off = buildTool({});
    const cr = await off.tools.ycLogs({ action: "createGroup", name: "x-logs" }, {});
    assert.ok(/⛔/.test(cr) && /создавать/.test(cr), "создание группы не заперто: " + cr.slice(0, 120));
    const up = await off.tools.ycLogs({ action: "updateGroup", group: "app-logs", description: "x" }, {});
    assert.ok(/⛔/.test(up) && /Править/.test(up) && /ЗАПРЕЩЕНО/.test(up), "правка группы не заперта: " + up.slice(0, 120));
    const del = await off.tools.ycLogs({ action: "deleteGroup", group: "app-logs" }, {});
    assert.ok(/⛔/.test(del) && /удалять/.test(del), "удаление группы не заперто: " + del.slice(0, 120));
  });

  await test("ycLogs: с разрешением группа создаётся и удаляется по-настоящему", async () => {
    stub.reset();
    const { tools } = buildTool({ ycAllowAgentCreate: true, ycAllowAgentDelete: true, ycAllowAgentUpdate: true });
    const made = await tools.ycLogs({ action: "createGroup", name: "extra-logs", description: "ещё", retention: 48 }, {});
    assert.ok(/✅ Лог-группа создана/.test(made) && /extra-logs/.test(made), "группа не создана: " + made.slice(0, 200));
    assert.ok(stub.calls.some((c) => c.method === "POST" && JSON.parse(c.body).retentionPeriod === "48h"), "тело создания не ушло с длительностью");
    const upd = await tools.ycLogs({ action: "updateGroup", group: "app-logs", description: "обновлено" }, {});
    assert.ok(/✅ Лог-группа изменена/.test(upd), "группа не изменена: " + upd.slice(0, 200));
    const del = await tools.ycLogs({ action: "deleteGroup", group: "extra-logs" }, {});
    assert.ok(/🗑 Лог-группа удалена/.test(del), "группа не удалена: " + del.slice(0, 200));
  });

  console.log("\n[3] Канал окна: yc:logGroups зовёт тот же модуль, что и агент");

  function logChannel(settingsOver) {
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
    const settings = Object.assign(
      { workingDir: work, yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "f1", ycFolderName: "prod" },
      settingsOver || {}
    );
    const svc = createYcService({
      app: { getPath: () => work },
      path,
      net: {},
      secrets: {},
      yandexCloud: yandex,
      ycCli: {},
      ycLogs: ycLogs,
      ycEnsurePath: () => {},
      loadSettings: () => settings,
    });
    registerYcIpc({
      ipcMain,
      yandexCloud: yandex,
      ycLogs: ycLogs,
      loadSettings: () => settings,
      saveSettings: () => {},
      svc,
    });
    assert.ok(handlers.has("yc:logGroups"), "канал yc:logGroups не зарегистрирован");
    return (args) => handlers.get("yc:logGroups")(null, args);
  }

  process.env.AI_AGENT_YC_BASE = stub.base;

  await test("yc:logGroups: список, карточка, создание и ПРАВКА МАСКОЙ", async () => {
    stub.reset();
    yandex.resetIamCache();
    const call = logChannel();

    const list = await call({ op: "list" });
    assert.ok(list.ok && /app-logs/.test(list.lines.join(" ")) && list.groups.length === 1, "список групп не показан: " + JSON.stringify(list).slice(0, 200));

    const card = await call({ op: "group", group: "grp1" });
    assert.ok(card.ok && /720h/.test(card.lines.join(" ")) && /Логи приложения/.test(card.lines.join(" ")), "карточка группы не показана: " + JSON.stringify(card).slice(0, 200));

    stub.calls.length = 0;
    const created = await call({ op: "create", name: "win-logs", description: "из окна", retention: 12 });
    assert.ok(created.ok && created.changed && /Лог-группа создана/.test(created.lines.join(" ")), "группа не создана из окна: " + JSON.stringify(created).slice(0, 240));
    const posted = stub.calls.find((c) => c.method === "POST" && c.url.indexOf("/logging/v1/logGroups") >= 0);
    assert.ok(posted && JSON.parse(posted.body).retentionPeriod === "12h", "тело создания из окна неполно");

    const upd = await call({ op: "update", group: "app-logs", description: "правка из окна" });
    assert.ok(upd.ok && /Лог-группа изменена/.test(upd.lines.join(" ")), "группа не изменена из окна: " + JSON.stringify(upd).slice(0, 200));
    assert.strictEqual(upd.group.description, "правка из окна", "правка не применилась: " + JSON.stringify(upd.group));
  });

  await test("yc:logGroups: удаление ДВУХШАГОВОЕ, честные отказы и отсутствие агентских запретов", async () => {
    stub.reset();
    yandex.resetIamCache();
    const call = logChannel();

    const bad = await call({ op: "стереть" });
    assert.ok(bad.ok === false && /Доступно: list, group, create, update, delete\./.test(bad.error), "чужое действие не назвало список: " + bad.error);

    const noName = await call({ op: "create" });
    assert.ok(noName.ok === false && /Укажи имя/.test(noName.error), "создание без имени не отвергнуто: " + noName.error);

    // Удаление: без согласия канал ОБЯЗАН отказать, а не выполнить.
    const delNo = await call({ op: "delete", group: "grp1" });
    assert.ok(delNo.ok === false && delNo.needsConfirm === true, "группа удалена без согласия");
    assert.ok(stub.state.groups.some((g) => g.id === "grp1"), "группа исчезла без согласия");
    const del = await call({ op: "delete", group: "grp1", confirmed: true });
    assert.ok(del.ok && del.deleted, "группа не удалена с согласием: " + JSON.stringify(del).slice(0, 200));
    assert.ok(!stub.state.groups.some((g) => g.id === "grp1"), "группа осталась после удаления");

    const off = await logChannel({ yandexOauthToken: "" })({ op: "list" });
    assert.ok(/не подключён/.test(off.error), "нет ответа про подключение: " + off.error);
    const noFolder = await logChannel({ ycFolderId: "" })({ op: "list" });
    assert.ok(/каталог/.test(noFolder.error), "нет ответа про каталог: " + noFolder.error);
  });

  delete process.env.AI_AGENT_YC_BASE;

  console.log("\n[4] Согласованность: канал, мост, окно, схема, справочник и цепочка");

  await test("yc:logGroups: канал, мост окна и семейство logging в окне на месте", () => {
    assert.ok(/ipcMain\.handle\("yc:logGroups"/.test(IPC_SRC), "канала нет в yc-ipc.js");
    const found = [...IPC_SRC.matchAll(/ipcMain\.handle\("(yc:[^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(found.length, 41, "каналов в мосте должно быть 41: " + found.length);
    assert.ok(/ycLogGroups: \(args\) => ipcRenderer\.invoke\("yc:logGroups"/.test(PRELOAD_SRC), "нет моста ycLogGroups");
    assert.ok(/logging: "ycLogGroups"/.test(ACTIONS_SRC), "семейство logging не знает свой канал");
    assert.ok(/logging: \["list", "group", "create", "update", "delete"\]/.test(ACTIONS_SRC), "OPS семейства logging не совпадают");
    assert.ok(/logging: loggingActions\(\)/.test(ACTIONS_SRC), "семейство logging не собрано");
  });

  await test("yc:logGroups: модуль, инструмент, схема, промпт и справочник знают группы логов", () => {
    assert.ok(/createLogGroup/.test(read("src", "yc-logs.js")), "модуль не умеет создавать группы");
    assert.ok(/name: "ycLogs"/.test(SCHEMAS_SRC) && /createGroup/.test(SCHEMAS_SRC) && /groups \| group/.test(SCHEMAS_SRC), "схема ycLogs не знает действия по группам");
    assert.ok(/ycLogs/.test(PROMPTS_SRC), "промпт не знает ycLogs");
    assert.ok(/ycLogs/.test(POLICY_SRC), "политика прав не знает ycLogs");
    assert.ok(/лог-группы/.test(GUIDE_SRC), "справочник yc.md не знает групп логов");
    assert.ok(/ycLogs/.test(read("src", "renderer", "agent-core.js")), "ядро роутера не знает ycLogs");
  });

  await test("yc:logGroups: сторож каналов и цепочка npm test знают группу логов", () => {
    assert.ok(SMOKE_SRC.indexOf('"yc:logGroups"') >= 0, "список каналов в smoke не знает yc:logGroups");
    assert.ok(/каналов в мосте должно быть 41/.test(SMOKE_SRC), "сторож каналов не пересчитан");
    assert.ok(PKG.scripts.test.indexOf("test/yc-log-groups.test.js") >= 0, "набор не в цепочке npm test");
  });

  await new Promise((r) => stub.server.close(r));
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

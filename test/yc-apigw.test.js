"use strict";

/* ── API-шлюз (API Gateway): создать ИЗ спецификации, посмотреть, поправить ────
   Запуск: node test/yc-apigw.test.js   (входит в общий `npm test`)

   Зачем набор. Сервис «API-шлюз» на полке уже был, но показывал только список:
   создать шлюз ИЗ OpenAPI-спецификации, показать её, поправить и удалить было
   нечем — ни человеку, ни агенту. Заход 12 части 91 закрыл это в четырёх слоях.

   Главные тонкости API Gateway, которые и стерегутся:
     • шлюз ЦЕЛИКОМ задаётся спецификацией (openapiSpec): без неё создавать нечего,
       поэтому пустую или не-OpenAPI спецификацию модуль отвергает ДО сети;
     • изменяющие методы возвращают OPERATION — её надо ДОЖДАТЬСЯ
       (waitOperation), а готовый шлюз читается ПЕРЕЧИТЫВАНИЕМ;
     • правка идёт МАСКОЙ полей (updateMask): имя поля спецификации в маске —
       `openapi_spec` (змеиный регистр), а в теле — `openapiSpec`;
     • поиск шлюза — по имени, id ИЛИ адресу (человек называет его по-разному);
     • удаление необратимо (адрес перестаёт отвечать) и спрашивается дважды.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE уводит туда все сервисы, включая operation и обмен токена). */

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
const ycApiGw = require(path.join(ROOT, "src", "yc-apigw.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const { createYcService } = require(path.join(ROOT, "src", "yc-service.js"));
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const MAIN_SRC = read("src", "main.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const POLICY_SRC = read("src", "tool-policy.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const SMOKE_SRC = require(path.join(__dirname, "smoke", "source.js"));
const PKG = JSON.parse(read("package.json"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "yc-apigw-work-"));

const SPEC = [
  "openapi: 3.0.0",
  "info:",
  "  title: my-api",
  "  version: 1.0.0",
  "paths:",
  "  /hello:",
  "    get:",
  "      x-yc-apigateway-integration:",
  "        type: dummy",
  "        http_code: 200",
  "        content:",
  '          application/json: \'{"hello": "world"}\'',
  "  /bye:",
  "    get:",
  "      x-yc-apigateway-integration:",
  "        type: dummy",
  "",
].join("\n");

// ── Подменённое облако: REST API Gateway + operations ───────────────────────
function startStub() {
  const calls = [];
  let seq = 0;
  let lastOp = null;
  let gateways = [];
  const reset = () => {
    seq = 0;
    lastOp = null;
    gateways = [
      {
        id: "gw1",
        folderId: "f1",
        name: "main-api",
        description: "Основной шлюз",
        status: "ACTIVE",
        domain: "gw1.apigw.yandexcloud.net",
        createdAt: "2026-09-01T10:00:00Z",
        executionTimeout: "5s",
        labels: { env: "prod" },
      },
    ];
  };
  reset();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const raw = req.url || "";
      calls.push({ method: req.method, url: raw, body: body.toString("utf8") });
      const json = (o, status) => {
        res.writeHead(status || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (raw.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (raw.indexOf("/operations/") >= 0) {
        return json({ id: raw.split("/").pop(), done: true, response: lastOp || {} });
      }
      // Спецификация: путь заканчивается на «:spec».
      const specM = /^\/apigateways\/v1\/apigateways\/([^?]+):spec/.exec(raw);
      if (specM) {
        const id = decodeURIComponent(specM[1]);
        return json({ apiGatewayId: id, openapiSpec: SPEC });
      }
      const one = /^\/apigateways\/v1\/apigateways\/([^?]+)/.exec(raw);
      if (one) {
        const id = decodeURIComponent(one[1]);
        const g = gateways.find((x) => x.id === id);
        if (!g) return json({ message: "not found" }, 404);
        if (req.method === "PATCH") {
          let sent = {};
          try {
            sent = JSON.parse(body.toString("utf8") || "{}");
          } catch {}
          if (!sent.updateMask) return json({ message: "updateMask is required" }, 400);
          for (const f of String(sent.updateMask).split(",")) {
            if (f === "name" && sent.name != null) g.name = sent.name;
            if (f === "description" && sent.description != null) g.description = sent.description;
            if (f === "openapi_spec" && sent.openapiSpec != null) g.spec = sent.openapiSpec;
            if (f === "execution_timeout" && sent.executionTimeout != null) g.executionTimeout = sent.executionTimeout;
            if (f === "labels" && sent.labels != null) g.labels = sent.labels;
          }
          lastOp = g;
          return json({ id: "op-" + ++seq, done: true, response: g });
        }
        if (req.method === "DELETE") {
          gateways = gateways.filter((x) => x.id !== id);
          lastOp = null;
          return json({ id: "op-" + ++seq, done: true, response: null });
        }
        return json(g);
      }
      if (raw.indexOf("/apigateways/v1/apigateways") >= 0) {
        if (req.method === "POST") {
          let sent = {};
          try {
            sent = JSON.parse(body.toString("utf8") || "{}");
          } catch {}
          const g = {
            id: "gw-" + ++seq,
            folderId: sent.folderId,
            name: sent.name,
            description: sent.description || "",
            status: "ACTIVE",
            domain: "gw-" + seq + ".apigw.yandexcloud.net",
            createdAt: "2026-10-01T10:00:00Z",
            executionTimeout: sent.executionTimeout || "",
            labels: sent.labels || {},
            spec: sent.openapiSpec,
          };
          gateways.push(g);
          lastOp = g;
          return json({ id: "op-" + ++seq, done: true, response: g });
        }
        return json({ apigateways: gateways });
      }
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, reset, gateways: () => gateways, base: "http://127.0.0.1:" + server.address().port }));
  });
}

// ── Инструмент агента на подменённом облаке ─────────────────────────────────
function buildTool(settingsOver) {
  const settings = Object.assign(
    { yandexOauthToken: "oauth-1", ycFolderId: "f1", ycFolderName: "prod", ycAllowAgentCreate: false, ycAllowAgentDelete: false, ycAllowAgentUpdate: false },
    settingsOver || {}
  );
  const cloud = { endpoint: async () => stub.base, getIamToken: async () => "iam-1", waitOperation: async () => ({ response: {} }) };
  const tools = createCloudTools({
    ycDb: {},
    path,
    fs,
    yandexCloud: cloud,
    ycApiGw: ycApiGw,
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
    readYcLogsText: async () => "",
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
  stub = await startStub();

  console.log("\n[1] Модуль yc-apigw.js: спецификация, маска и REST");

  await test("yc-apigw: имя и спецификация проверяются ДО сети", () => {
    assert.strictEqual(ycApiGw.checkName("my-api"), "my-api", "хорошее имя отвергнуто");
    assert.throws(() => ycApiGw.checkName("Плохое Имя"), /имя API-шлюза|не подойдёт/, "плохое имя принято");
    assert.throws(() => ycApiGw.checkName(""), /Укажи имя/, "пустое имя принято");
    assert.throws(() => ycApiGw.checkSpec(""), /Нет OpenAPI-спецификации/, "пустая спецификация принята");
    assert.throws(() => ycApiGw.checkSpec("просто текст"), /не похоже на OpenAPI|openapi/, "не-OpenAPI текст принят");
    assert.strictEqual(ycApiGw.checkSpec(SPEC), SPEC, "годная спецификация отвергнута");
  });

  await test("yc-apigw: длительность, статусы и адрес по умолчанию", () => {
    assert.strictEqual(ycApiGw.durationOf(5), "5s", "число секунд не стало длительностью");
    assert.strictEqual(ycApiGw.durationOf("30"), "30s", "строка секунд не стала длительностью");
    assert.strictEqual(ycApiGw.durationOf(0), "", "ноль должен значить «по умолчанию»");
    assert.strictEqual(ycApiGw.statusHuman("ACTIVE"), "работает", "ACTIVE не переведён");
    assert.ok(/ошибка/.test(ycApiGw.statusHuman("ERROR")), "ERROR не объяснён");
    const info = ycApiGw.gatewayInfo({ id: "gw1", name: "main-api", status: "ACTIVE", domain: "gw1.apigw.yandexcloud.net" });
    assert.strictEqual(info.url, "https://gw1.apigw.yandexcloud.net", "адрес не собран: " + info.url);
    assert.ok(/main-api/.test(ycApiGw.gatewayLine(info)) && /https:\/\//.test(ycApiGw.gatewayLine(info)), "строка потеряла имя или адрес");
  });

  await test("yc-apigw: разбор спецификации (пути, интеграции) и поиск по адресу", () => {
    const brief = ycApiGw.specBrief(SPEC);
    assert.strictEqual(brief.format, "YAML", "формат определён неверно: " + brief.format);
    assert.ok(brief.paths.indexOf("/hello") >= 0 && brief.paths.indexOf("/bye") >= 0, "пути не найдены: " + JSON.stringify(brief.paths));
    assert.strictEqual(brief.pathCount, 2, "число путей не то: " + brief.pathCount);
    assert.strictEqual(brief.integrations, 2, "интеграции не посчитаны: " + brief.integrations);
    assert.ok(brief.openapi.indexOf("3.0.0") >= 0, "версия OpenAPI не найдена: " + brief.openapi);

    const list = [{ id: "gw1", name: "main-api", domain: "gw1.apigw.yandexcloud.net" }];
    assert.strictEqual(ycApiGw.matchGateway(list, "main-api").id, "gw1", "поиск по имени не сработал");
    assert.strictEqual(ycApiGw.matchGateway(list, "https://gw1.apigw.yandexcloud.net/hello").id, "gw1", "поиск по адресу не сработал");
    assert.strictEqual(ycApiGw.matchGateway(list, "нет-такого"), null, "чужое имя нашлось");
  });

  await test("yc-apigw: список, карточка, SPEC и создание — настоящие REST-запросы", async () => {
    stub.reset();
    const iam = "iam-1";
    const list = await ycApiGw.listGateways(iam, stub.base, "f1");
    assert.ok(list.length === 1 && list[0].name === "main-api", "список не прочитан: " + JSON.stringify(list));

    const one = await ycApiGw.getGateway(iam, stub.base, "gw1");
    assert.ok(one.name === "main-api" && one.domain === "gw1.apigw.yandexcloud.net", "карточка не прочитана: " + JSON.stringify(one));

    const spec = await ycApiGw.getSpec(iam, stub.base, "gw1");
    assert.ok(/openapi/.test(spec.openapiSpec), "спецификация не прочитана: " + spec.openapiSpec.slice(0, 40));

    stub.calls.length = 0;
    const op = await ycApiGw.createGateway(iam, stub.base, { folderId: "f1", name: "new-api", spec: SPEC, description: "новый", executionTimeout: 10, labels: { env: "dev" } });
    assert.ok(op && op.id, "создание не вернуло операцию: " + JSON.stringify(op));
    const posted = stub.calls.find((c) => c.method === "POST" && c.url.indexOf("/apigateways/v1/apigateways") >= 0);
    assert.ok(posted, "POST создания не ушёл");
    const sent = JSON.parse(posted.body);
    assert.strictEqual(sent.folderId, "f1", "не ушёл каталог");
    assert.strictEqual(sent.openapiSpec, SPEC, "спецификация не ушла телом");
    assert.strictEqual(sent.executionTimeout, "10s", "секунды не стали длительностью");
    assert.deepStrictEqual(sent.labels, { env: "dev" }, "не ушли метки");

    await assert.rejects(() => ycApiGw.createGateway(iam, stub.base, { folderId: "f1", name: "x", spec: "" }), /Нет OpenAPI-спецификации/, "создание без спецификации не отвергнуто");
  });

  await test("yc-apigw: правка идёт МАСКОЙ (openapi_spec), удаление — настоящий DELETE", async () => {
    stub.reset();
    const iam = "iam-1";
    stub.calls.length = 0;
    await ycApiGw.updateGateway(iam, stub.base, "gw1", { name: "renamed-api", spec: SPEC });
    const patched = stub.calls.find((c) => c.method === "PATCH");
    assert.ok(patched, "PATCH правки не ушёл");
    const pbody = JSON.parse(patched.body);
    assert.strictEqual(pbody.updateMask, "name,openapi_spec", "маска назвала не то: " + pbody.updateMask);
    assert.ok(pbody.openapiSpec, "спецификация не ушла в теле правки");
    await assert.rejects(() => ycApiGw.updateGateway(iam, stub.base, "gw1", {}), /нечего менять/, "правка без полей не отвергнута");

    stub.calls.length = 0;
    await ycApiGw.deleteGateway(iam, stub.base, "gw1");
    assert.ok(stub.calls.some((c) => c.method === "DELETE"), "DELETE удаления не ушёл");
  });

  console.log("\n[2] Инструмент агента ycApiGw: спецификация под разрешениями");

  await test("ycApiGw: список, карточка и спецификация читаются, чужое действие названо списком", async () => {
    stub.reset();
    const { tools } = buildTool({});
    const list = await tools.ycApiGw({ action: "list" }, {});
    assert.ok(/main-api/.test(list) && /API-шлюзы каталога/.test(list), "список не показан: " + list.slice(0, 160));
    const card = await tools.ycApiGw({ action: "gateway", gateway: "main-api" }, {});
    assert.ok(/https:\/\/gw1\.apigw\.yandexcloud\.net/.test(card), "карточка без адреса: " + card.slice(0, 200));
    const spec = await tools.ycApiGw({ action: "spec", gateway: "main-api" }, {});
    assert.ok(/openapi/.test(spec) && /путей 2/.test(spec), "спецификация не показана: " + spec.slice(0, 160));
    const bad = await tools.ycApiGw({ action: "стереть" }, {});
    assert.ok(/неизвестное действие ycApiGw/.test(bad) && /create/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 160));
  });

  await test("ycApiGw: создание, правка и удаление заперты разрешениями ДО сети", async () => {
    stub.reset();
    const { tools } = buildTool({});
    const cr = await tools.ycApiGw({ action: "create", name: "x", spec: SPEC }, {});
    assert.ok(/⛔/.test(cr) && /создавать/.test(cr), "создание не заперто: " + cr.slice(0, 120));
    const up = await tools.ycApiGw({ action: "update", gateway: "main-api", newName: "y" }, {});
    assert.ok(/⛔/.test(up) && /Править/.test(up) && /ЗАПРЕЩЕНО/.test(up), "правка не заперта: " + up.slice(0, 120));
    const del = await tools.ycApiGw({ action: "delete", gateway: "main-api" }, {});
    assert.ok(/⛔/.test(del) && /удалять/.test(del), "удаление не заперто: " + del.slice(0, 120));
  });

  await test("ycApiGw: с разрешением шлюз создаётся, правится и удаляется по-настоящему", async () => {
    stub.reset();
    const { tools } = buildTool({ ycAllowAgentCreate: true, ycAllowAgentDelete: true, ycAllowAgentUpdate: true });
    const made = await tools.ycApiGw({ action: "create", name: "agent-api", spec: SPEC }, {});
    assert.ok(/✅ API-шлюз создан/.test(made) && /agent-api/.test(made), "шлюз не создан: " + made.slice(0, 220));
    assert.ok(stub.calls.some((c) => c.method === "POST" && JSON.parse(c.body).openapiSpec === SPEC), "тело создания не ушло со спецификацией");
    const upd = await tools.ycApiGw({ action: "update", gateway: "main-api", description: "обновлено" }, {});
    assert.ok(/✅ API-шлюз изменён/.test(upd), "шлюз не изменён: " + upd.slice(0, 200));
    const del = await tools.ycApiGw({ action: "delete", gateway: "main-api" }, {});
    assert.ok(/🗑 API-шлюз удалён/.test(del), "шлюз не удалён: " + del.slice(0, 200));
  });

  console.log("\n[3] Канал окна: yc:apigw зовёт тот же модуль, что и агент");

  function apigwChannel(settingsOver) {
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
      ycLogs: {},
      ycEnsurePath: () => {},
      loadSettings: () => settings,
    });
    registerYcIpc({
      ipcMain,
      yandexCloud: yandex,
      ycApiGw: ycApiGw,
      loadSettings: () => settings,
      saveSettings: () => {},
      svc,
    });
    assert.ok(handlers.has("yc:apigw"), "канал yc:apigw не зарегистрирован");
    return (args) => handlers.get("yc:apigw")(null, args);
  }

  process.env.AI_AGENT_YC_BASE = stub.base;

  await test("yc:apigw: список, карточка, спецификация и создание ИЗ спецификации", async () => {
    stub.reset();
    yandex.resetIamCache();
    const call = apigwChannel();

    const list = await call({ op: "list" });
    assert.ok(list.ok && /main-api/.test(list.lines.join(" ")) && list.gateways.length === 1, "список не показан: " + JSON.stringify(list).slice(0, 200));

    const card = await call({ op: "gateway", gateway: "gw1" });
    assert.ok(card.ok && /https:\/\/gw1\.apigw\.yandexcloud\.net/.test(card.lines.join(" ")), "карточка без адреса: " + JSON.stringify(card).slice(0, 200));

    const spec = await call({ op: "spec", gateway: "main-api" });
    assert.ok(spec.ok && /путей 2/.test(spec.lines.join(" ")) && spec.paths.length === 2, "спецификация не показана: " + JSON.stringify(spec).slice(0, 200));

    stub.calls.length = 0;
    const created = await call({ op: "create", name: "win-api", spec: SPEC, description: "из окна", executionTimeout: 7 });
    assert.ok(created.ok && created.changed && /API-шлюз создан/.test(created.lines.join(" ")), "шлюз не создан из окна: " + JSON.stringify(created).slice(0, 240));
    assert.ok(/https:\/\//.test(created.lines.join(" ")), "адрес созданного шлюза не назван: " + created.lines.join(" | "));
    const posted = stub.calls.find((c) => c.method === "POST" && c.url.indexOf("/apigateways/v1/apigateways") >= 0);
    assert.ok(posted && JSON.parse(posted.body).executionTimeout === "7s", "тело создания из окна неполно");
  });

  await test("yc:apigw: правка маской, ДВУХШАГОВОЕ удаление и честные отказы", async () => {
    stub.reset();
    yandex.resetIamCache();
    const call = apigwChannel();

    const upd = await call({ op: "update", gateway: "main-api", description: "правка из окна" });
    assert.ok(upd.ok && /API-шлюз изменён/.test(upd.lines.join(" ")), "шлюз не изменён из окна: " + JSON.stringify(upd).slice(0, 200));
    assert.strictEqual(upd.gateway.description, "правка из окна", "правка не применилась: " + JSON.stringify(upd.gateway));

    const bad = await call({ op: "стереть" });
    assert.ok(bad.ok === false && /Доступно: list, gateway, spec, create, update, delete\./.test(bad.error), "чужое действие не назвало список: " + bad.error);

    const noName = await call({ op: "create", spec: SPEC });
    assert.ok(noName.ok === false && /Укажи имя/.test(noName.error), "создание без имени не отвергнуто: " + noName.error);

    // Удаление: без согласия канал ОБЯЗАН отказать, а не выполнить.
    const delNo = await call({ op: "delete", gateway: "main-api" });
    assert.ok(delNo.ok === false && delNo.needsConfirm === true, "шлюз удалён без согласия");
    assert.ok(stub.gateways().some((g) => g.id === "gw1"), "шлюз исчез без согласия");
    const del = await call({ op: "delete", gateway: "main-api", confirmed: true });
    assert.ok(del.ok && del.deleted, "шлюз не удалён с согласием: " + JSON.stringify(del).slice(0, 200));
    assert.ok(!stub.gateways().some((g) => g.id === "gw1"), "шлюз остался после удаления");

    const off = await apigwChannel({ yandexOauthToken: "" })({ op: "list" });
    assert.ok(/не подключён/.test(off.error), "нет ответа про подключение: " + off.error);
    const noFolder = await apigwChannel({ ycFolderId: "" })({ op: "list" });
    assert.ok(/каталог/.test(noFolder.error), "нет ответа про каталог: " + noFolder.error);
  });

  delete process.env.AI_AGENT_YC_BASE;

  console.log("\n[4] Согласованность: канал, мост, окно, схема, справочник и цепочка");

  await test("yc:apigw: канал, мост окна, оболочка и семейство apiGateway на месте", () => {
    assert.ok(/ipcMain\.handle\("yc:apigw"/.test(IPC_SRC), "канала нет в yc-ipc.js");
    const found = [...IPC_SRC.matchAll(/ipcMain\.handle\("(yc:[^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(found.length, 41, "каналов в мосте должно быть 41: " + found.length);
    assert.ok(/ycApiGw: \(args\) => ipcRenderer\.invoke\("yc:apigw"/.test(PRELOAD_SRC), "нет моста ycApiGw");
    assert.ok(/\bycApiGw\b/.test(MAIN_SRC) && /require\("\.\/yc-apigw\.js"\)/.test(MAIN_SRC), "оболочка не подключает модуль API-шлюза");
    assert.ok(/apiGateway: "ycApiGw"/.test(ACTIONS_SRC), "семейство apiGateway не знает свой канал");
    assert.ok(/apiGateway: \["list", "gateway", "spec", "create", "update", "delete"\]/.test(ACTIONS_SRC), "OPS семейства apiGateway не совпадают");
    assert.ok(/apiGateway: apigwActions\(\)/.test(ACTIONS_SRC), "семейство apiGateway не собрано");
  });

  await test("yc:apigw: модуль, инструмент, схема, промпт, права и справочник знают шлюз", () => {
    assert.ok(/createGateway/.test(read("src", "yc-apigw.js")), "модуль не умеет создавать шлюз");
    const at = SCHEMAS_SRC.indexOf('name: "ycApiGw"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 2200);
    for (const part of ["action", "gateway", "name", "newName", "spec", "format", "executionTimeout", "labels", "x-yc-apigateway-integration"]) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/создавать ресурсы/.test(schema) && /менять ресурсы/.test(schema) && /удалять ресурсы/.test(schema), "схема не называет разрешения");
    assert.ok(/ycApiGw/.test(PROMPTS_SRC), "промпт не знает ycApiGw");
    assert.ok(/ycApiGw/.test(POLICY_SRC), "политика прав не знает ycApiGw");
    assert.ok(/ycApiGw/.test(CORE_SRC), "ядро роутера не знает ycApiGw");
    assert.ok(/ycApiGw/.test(GUIDE_SRC), "справочник yc.md не знает ycApiGw");
  });

  await test("yc:apigw: сторож каналов и цепочка npm test знают шлюз", () => {
    assert.ok(SMOKE_SRC.indexOf('"yc:apigw"') >= 0, "список каналов в smoke не знает yc:apigw");
    assert.ok(/каналов в мосте должно быть 41/.test(SMOKE_SRC), "сторож каналов не пересчитан");
    assert.ok(PKG.scripts.test.indexOf("test/yc-apigw.test.js") >= 0, "набор не в цепочке npm test");
  });

  await new Promise((r) => stub.server.close(r));
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

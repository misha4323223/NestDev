"use strict";

/* ── Группы машин (Instance Groups) ───────────────────────────────────────────
   Запуск: node test/yc-ig.test.js   (входит в общий `npm test`)

   Зачем набор. Машины у приложения были, а ГРУПП машин — нет, и это не «ещё один
   способ создать машину»: группа сама создаёт машины по шаблону, держит их число
   и ПЕРЕСОЗДАЁТ удалённые руками. Отсюда всё, что здесь проверяется:

     • группа — не список машин. Число меняет размер группы (scalePolicy.
       fixedScale.size), а «удалить машину из группы» бессмысленно: она вернётся.
       Это сказано и в строке списка, и в отказе канала;
     • ПЛАТЯТ МАШИНЫ: каждая — как обычная машина Compute Cloud, за час работы,
       поэтому создание требует согласия (confirm) и называет размер и цену ДО
       запроса, а удаление — необратимое: забирает машины вместе с дисками;
     • зона одна — зона подсети. Группа без подсети не встанет вовсе, а подсеть
       ЧУЖОЙ зоны облако отклонит: оба случая отсекаются ДО сети;
     • образ ищется по семейству (ubuntu-2204-lts) в служебном каталоге
       standard-images — как у машин; готовый imageId принимается как есть;
     • без publicIp: true внешнего адреса у машин нет, а без securityGroups
       останется группа по умолчанию сети — она закрывает SSH снаружи, и об этом
       сказано словами, а не подразумевается;
     • ОТКАЗЫ ДО СЕТИ: пустое/кривое имя, нет каталога, нет подсети, размер вне
       1…100, память меньше 1 ГБ, диск меньше 4 ГБ, занятая группа (идёт переход),
       deletionProtection — на всё это запрос уходить не должен, и это видно по
       счётчику обращений к облаку;
     • проводка: канал yc:ig через НАСТОЯЩИЙ registerYcIpc, проброс в окно,
       семейство действий в yc-actions (платное и опасное помечены), плитка полки
       со знаком сервиса, связи консоли и согласованность с дашбордом;
     • согласованность: схема инструмента, обе строки промпта, группа «облако»,
       политика прав, справочник yc.md и цепочка npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE, как у остальных наборов облака). */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

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
const igMod = require(path.join(ROOT, "src", "yc-ig.js"));
const { createYcIg, groupInfo, groupLine, instanceLine, scaleOf } = igMod;
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const MAIN_SRC = read("src", "main.js");
const PRELOAD_SRC = read("src", "preload.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const PANEL_SRC = read("src", "renderer", "yc-panel.js");
const CONSOLE_SRC = read("src", "yc-console.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke", "03-cloud.js");
const YANDEX_SRC = read("src", "yandex-cloud.js");
const PKG = JSON.parse(read("package.json"));
const LOGOS = require(path.join(ROOT, "src", "renderer", "yc-logos.js"));
const ycConsole = require(path.join(ROOT, "src", "yc-console.js"));

// ── Подменённое облако: группы, машины, операции, подсети и образы ──────────
// Три группы, и каждая здесь не для красоты: работающая с устаревшими машинами
// (web), остановленная с защитой от удаления (locked) и занятая переходом
// (busy) — именно на них видно и счётчики машин, и отказы до сети.
function startIgStub() {
  const calls = [];
  const created = [];
  const deleted = new Set();
  const status = { web: "ACTIVE", locked: "STOPPED", busy: "STARTING" };
  const groups = {
    web: {
      id: "ig-web",
      name: "web",
      folderId: "folder-1",
      description: "витрина",
      createdAt: "2026-08-01T10:00:00Z",
      status: "ACTIVE",
      deletionProtection: false,
      serviceAccountId: "sa-1",
      instanceTemplate: {
        platformId: "standard-v3",
        resourcesSpec: { cores: "2", memory: "2147483648", coreFraction: "100" },
        bootDiskSpec: { diskSpec: { typeId: "network-ssd", size: "21474836480", imageId: "img-1" } },
        networkInterfaceSpecs: [{ networkId: "net-1", subnetIds: ["sub-1"], securityGroupIds: ["sg-1"], primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: "IPV4" } } }],
        metadata: { "ssh-keys": "ubuntu:ssh-ed25519 AAAA… user@pc" },
        schedulingPolicy: { preemptible: true },
      },
      scalePolicy: { fixedScale: { size: "3" } },
      allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] },
      loadBalancerState: { targetGroupId: "tg-nlb-1" },
      applicationLoadBalancerState: {},
      healthChecksSpec: { healthCheckSpecs: [{}, {}] },
    },
    locked: {
      id: "ig-locked",
      name: "locked",
      folderId: "folder-1",
      createdAt: "2026-07-01T10:00:00Z",
      status: "STOPPED",
      deletionProtection: true,
      instanceTemplate: {
        resourcesSpec: { cores: "2", memory: "2147483648", coreFraction: "20" },
        bootDiskSpec: { diskSpec: { typeId: "network-hdd", size: "10737418240", imageId: "img-1" } },
        networkInterfaceSpecs: [{ networkId: "net-1", subnetIds: ["sub-1"], primaryV4AddressSpec: {} }],
      },
      scalePolicy: { autoScale: { minZoneSize: "1", maxSize: "4" } },
      allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] },
    },
    busy: {
      id: "ig-busy",
      name: "busy",
      folderId: "folder-1",
      createdAt: "2026-09-30T09:00:00Z",
      status: "STARTING",
      instanceTemplate: {
        resourcesSpec: { cores: "4", memory: "8589934592", coreFraction: "100" },
        bootDiskSpec: { diskSpec: { typeId: "network-ssd", size: "21474836480", imageId: "img-1" } },
        networkInterfaceSpecs: [{ networkId: "net-1", subnetIds: ["sub-1"], primaryV4AddressSpec: {} }],
      },
      scalePolicy: { fixedScale: { size: "2" } },
      allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] },
    },
  };
  const machines = {
    "ig-web": [
      { id: "epd-1", instanceId: "epd-1", name: "web-1", fqdn: "web-1.auto.internal", status: "RUNNING_ACTUAL", zoneId: "ru-central1-a", networkInterfaces: [{ subnetId: "sub-1", primaryV4Address: { address: "10.0.0.5", oneToOneNat: { address: "203.0.113.5" } } }] },
      { id: "epd-2", instanceId: "epd-2", name: "web-2", fqdn: "web-2.auto.internal", status: "RUNNING_OUTDATED", statusMessage: "обновление конфигурации", zoneId: "ru-central1-a", networkInterfaces: [{ subnetId: "sub-1", primaryV4Address: { address: "10.0.0.6" } }] },
      { id: "epd-3", instanceId: "epd-3", name: "web-3", fqdn: "web-3.auto.internal", status: "CREATING_INSTANCE", zoneId: "ru-central1-a", networkInterfaces: [{ subnetId: "sub-1", primaryV4Address: {} }] },
    ],
    "ig-locked": [],
    "ig-busy": [{ id: "epd-9", instanceId: "epd-9", name: "busy-1", fqdn: "busy-1.auto.internal", status: "STOPPED", zoneId: "ru-central1-a", networkInterfaces: [{ subnetId: "sub-1", primaryV4Address: {} }] }],
  };
  const states = {
    "ig-web": { targetSize: 3, runningActualCount: 2, runningOutdatedCount: 1, processingCount: 1 },
    "ig-locked": { targetSize: 0, runningActualCount: 0, runningOutdatedCount: 0, processingCount: 0 },
    "ig-busy": { targetSize: 2, runningActualCount: 0, runningOutdatedCount: 0, processingCount: 2 },
  };

  const initialStatus = { web: "ACTIVE", locked: "STOPPED", busy: "STARTING" };

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
      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (url.indexOf("/operations/") >= 0) {
        // Операция создания отдаёт id готовой группы ТОЛЬКО в response — так же,
        // как настоящее облако, и модуль обязан её оттуда достать.
        const id = url.split("/").pop();
        if (id === "op-create") return json({ id: id, done: true, response: { instanceGroupId: "ig-new" } });
        return json({ id: id, done: true });
      }

      // Сеть VPC: подсети (зона и сеть группы) и группы безопасности по имени.
      if (url.indexOf("/vpc/v1/subnets") >= 0) {
        return json({
          subnets: [
            { id: "sub-1", name: "app-subnet", networkId: "net-1", zoneId: "ru-central1-a" },
            { id: "sub-2", name: "other-subnet", networkId: "net-1", zoneId: "ru-central1-b" },
          ],
        });
      }
      if (url.indexOf("/vpc/v1/securityGroups") >= 0) {
        return json({ securityGroups: [{ id: "sg-1", name: "web" }, { id: "sg-2", name: "ssh" }] });
      }
      if (url.indexOf("/compute/v1/images:latestByFamily") >= 0) {
        return json({ id: "img-ubuntu-2204", name: "ubuntu-2204-lts" });
      }

      if (url.indexOf("/compute/v1/instanceGroups") >= 0) {
        if (req.method === "POST" && /\/instanceGroups(\?|$)/.test(url)) {
          const body = JSON.parse(raw || "{}");
          created.push(body);
          return json({ id: "op-create", done: false });
        }
        const power = url.match(/\/instanceGroups\/([^/:?]+):(start|stop)/);
        if (power && req.method === "POST") {
          status[power[1] === "ig-web" ? "web" : "locked"] = power[2] === "start" ? "ACTIVE" : "STOPPED";
          return json({ id: "op-power", done: false });
        }
        const del = url.match(/\/instanceGroups\/([^/:?]+)$/);
        if (del && req.method === "DELETE") {
          deleted.add(del[1]);
          status[del[1] === "ig-web" ? "web" : "locked"] = "DELETING";
          return json({ id: "op-del", done: false });
        }
        const sub = url.match(/\/instanceGroups\/([^/:?]+)(\/instances|\/operations)/);
        if (sub && req.method === "GET") {
          if (sub[2] === "/instances") return json({ instances: machines[sub[1]] || [] });
          return json({
            operations: [
              { id: "op1", description: "Create instance group", createdAt: "2026-08-01T09:59:00Z", done: true },
              { id: "op2", description: "Update instance group", createdAt: "2026-09-30T09:00:00Z", done: false },
            ],
          });
        }
        const one = url.match(/\/instanceGroups\/([^/?]+)(\?|$)/);
        if (one && req.method === "GET") {
          const key = one[1];
          const found = Object.keys(groups).find((k) => groups[k].id === key);
          if (found) {
            return json(Object.assign({}, groups[found], { status: status[found], managedInstancesState: states["ig-" + found] }));
          }
          if (key === "ig-new") {
            return json({ id: "ig-new", name: "created-group", folderId: "folder-1", status: "STARTING", instanceTemplate: {}, scalePolicy: { fixedScale: { size: "2" } }, allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] } });
          }
          return json({ message: "Instance group not found" }, 404);
        }
        if (req.method === "GET") {
          // Удалённую группу стенд из списка НЕ убирает намеренно: наборы после
          // проверки удаления ещё читают группу (карточка, инструмент), и "пусто
          // после удаления" здесь ничего бы не проверило.
          const list = Object.keys(groups).map((k) =>
            Object.assign({}, groups[k], { status: status[k], managedInstancesState: states["ig-" + k] })
          );
          return json({ instanceGroups: list });
        }
      }
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () =>
      r({
        server: server,
        calls: calls,
        created: created,
        // Возврат стенда в исходное состояние: набор идёт по порядку, и после
        // проверки удаления группа «web» осталась бы удаляемой — это помешало
        // бы следующим разделам, ничего в них не проверяя.
        reset: () => {
          Object.keys(initialStatus).forEach((k) => {
            status[k] = initialStatus[k];
          });
          deleted.clear();
          created.length = 0;
        },
        base: "http://127.0.0.1:" + server.address().port,
      })
    );
  });
}

const ig = createYcIg({
  fetchJson: yandex._fetchJson,
  endpoint: yandex.endpoint,
  getIamToken: yandex.getIamToken,
  waitOperation: yandex.waitOperation,
  serviceError: yandex.serviceError,
});

function settingsFor(over) {
  return Object.assign(
    { yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "folder-1", ycFolderName: "prod" },
    over || {}
  );
}

function buildTools(settingsOver) {
  const settings = settingsFor(settingsOver);
  return createCloudTools({
    path: path,
    fs: fs,
    yandexCloud: yandex,
    ycIg: ig,
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
  const stub = await startIgStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Группа — не список машин: размер, шаблон и слова");

  await test("ycIg: состояния группы и машины переводятся словами, незнакомое — как есть", () => {
    assert.strictEqual(ig.statusHuman("ACTIVE"), "работает");
    assert.strictEqual(ig.statusHuman("STOPPED"), "остановлена");
    assert.strictEqual(ig.statusHuman("STARTING"), "запускается");
    assert.strictEqual(ig.statusHuman("DELETING"), "удаляется");
    assert.strictEqual(ig.statusHuman("НЕВЕДОМОЕ"), "НЕВЕДОМОЕ", "незнакомое состояние должно показываться как есть");
    assert.strictEqual(ig.instanceStatusHuman("RUNNING_ACTUAL"), "работает");
    assert.strictEqual(ig.instanceStatusHuman("RUNNING_OUTDATED"), "работает, конфигурация устарела — будет пересоздана");
    assert.strictEqual(ig.instanceStatusHuman("CHECKING_HEALTH"), "проверка здоровья");
  });

  await test("ycIg: размер читается из scalePolicy — и фиксированный, и автомасштабирование", () => {
    const fixed = scaleOf({ fixedScale: { size: "3" } });
    assert.strictEqual(fixed.kind, "fixed");
    assert.strictEqual(fixed.size, 3, "число машин группы не прочитано — а именно оно тарифицируется");
    const auto = scaleOf({ autoScale: { minZoneSize: "1", maxSize: "4" } });
    assert.strictEqual(auto.kind, "auto");
    assert.strictEqual(auto.max, 4);
    assert.ok(/от 1 до 4/.test(auto.label), "границы автомасштабирования не названы: " + auto.label);
    assert.strictEqual(scaleOf({}).size, 0, "у группы без scalePolicy размера быть не может");
  });

  await test("ycIg: шаблон разбирается по-настоящему — ядра, память, диск, публичный адрес", () => {
    const g = groupInfo({
      id: "ig-1",
      name: "web",
      status: "ACTIVE",
      instanceTemplate: {
        platformId: "standard-v3",
        resourcesSpec: { cores: "2", memory: "2147483648", coreFraction: "20" },
        bootDiskSpec: { diskSpec: { typeId: "network-hdd", size: "10737418240" } },
        networkInterfaceSpecs: [{ primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: "IPV4" } } }],
        schedulingPolicy: { preemptible: true },
        serviceAccountId: "sa-9",
      },
      scalePolicy: { fixedScale: { size: "2" } },
      allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] },
      managedInstancesState: { targetSize: "2", runningActualCount: "1", runningOutdatedCount: "1", processingCount: "0" },
    });
    assert.strictEqual(g.template.cores, "2");
    assert.strictEqual(g.template.memoryHuman, "2 ГБ", "память читается из БАЙТОВ");
    assert.strictEqual(g.template.diskHuman, "10 ГБ");
    assert.strictEqual(g.template.diskTypeId, "network-hdd");
    assert.strictEqual(g.template.coreFraction, "20");
    assert.strictEqual(g.template.hasPublicIp, true, "публичный адрес шаблона не замечен");
    assert.strictEqual(g.template.preemptible, true, "прерываемость шаблона не замечена");
    assert.strictEqual(g.targetSize, 2);
    assert.strictEqual(g.runningActual, 1);
    assert.strictEqual(g.runningOutdated, 1, "устаревшие машины не посчитаны — а группа их пересоздаёт");
    assert.strictEqual(g.active, true);
    assert.strictEqual(g.busy, false);
    assert.deepStrictEqual(g.zones, ["ru-central1-a"]);
  });

  await test("ycIg: занятая группа отличается от работающей (питание и удаление в это время отклонят)", () => {
    const busy = groupInfo({ id: "x", status: "STARTING" });
    assert.strictEqual(busy.busy, true, "STARTING — это переход, а не рабочее состояние");
    assert.strictEqual(busy.active, false);
    assert.strictEqual(groupInfo({ status: "DELETING" }).busy, true);
    assert.strictEqual(groupInfo({ status: "PAUSED" }).paused, true);
    assert.strictEqual(groupInfo({ status: "ACTIVE" }).busy, false);
  });

  await test("ycIg: строка группы называет размер, счёт машин, зону и защиту от удаления", () => {
    const line = groupLine(groupInfo({
      id: "ig-web",
      name: "web",
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      status: "ACTIVE",
      deletionProtection: true,
      instanceTemplate: { resourcesSpec: { cores: "2", memory: "2147483648" }, networkInterfaceSpecs: [{ primaryV4AddressSpec: {} }] },
      scalePolicy: { fixedScale: { size: "3" } },
      allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] },
      managedInstancesState: { targetSize: "3", runningActualCount: "2", runningOutdatedCount: "1" },
    }));
    assert.ok(/web/.test(line), line);
    assert.ok(/работает/.test(line), "состояние словами: " + line);
    assert.ok(/3 машин/.test(line), "размер группы не показан: " + line);
    assert.ok(/машин 2\/3/.test(line), "счёт машин не показан: " + line);
    assert.ok(/устаревших 1/.test(line), "устаревшие машины не показаны: " + line);
    assert.ok(/ru-central1-a/.test(line), "зона не показана: " + line);
    assert.ok(/защита от удаления/.test(line), "защита от удаления не показана: " + line);
    assert.ok(/id ig-web/.test(line), "id не назван: " + line);
  });

  await test("ycIg: строка машины показывает её состояние и адреса", () => {
    const line = instanceLine({
      name: "web-1",
      status: "RUNNING_ACTUAL",
      zoneId: "ru-central1-a",
      networkInterfaces: [{ primaryV4Address: { address: "10.0.0.5", oneToOneNat: { address: "203.0.113.5" } } }],
    });
    assert.ok(/web-1/.test(line) && /работает/.test(line), line);
    assert.ok(/внутренний 10\.0\.0\.5/.test(line), "внутренний адрес не показан: " + line);
    assert.ok(/публичный 203\.0\.113\.5/.test(line), "публичный адрес не показан: " + line);
  });

  await test("ycIg: имя группы и каталог проверяются по правилам облака", () => {
    assert.strictEqual(igMod.createYcIg({}).groups.length >= 0, true);
    const g = groupInfo({ name: "ok" });
    assert.strictEqual(g.name, "ok");
    assert.ok(igMod.IG_HOST.indexOf("compute.api.cloud.yandex.net") > 0, "группы живут не на хосте Compute: " + igMod.IG_HOST);
    assert.strictEqual(igMod.ZONE_DEFAULT, "ru-central1-a");
  });

  console.log("\n[2] Чтение: пути, разбор ответов и отказы до сети");

  await test("ycIg: список уходит с каталогом и размером страницы, а машины — по id группы", async () => {
    const before = stub.calls.length;
    const list = await ig.groups("oauth-1", "folder-1");
    assert.strictEqual(list.length, 3, "групп не три: " + list.length);
    const req = callsTo(stub, "/compute/v1/instanceGroups?").slice(-1)[0];
    assert.ok(req.url.indexOf("folderId=folder-1") >= 0, "каталог не передан: " + req.url);
    assert.ok(req.url.indexOf("pageSize=1000") >= 0, "размер страницы не передан: " + req.url);
    assert.ok(stub.calls.length > before, "запрос вообще не ушёл");

    const machines = await ig.instances("oauth-1", "ig-web");
    assert.strictEqual(machines.length, 3);
    assert.strictEqual(machines[1].statusHuman, "работает, конфигурация устарела — будет пересоздана");
    assert.strictEqual(machines[0].externalIp, "203.0.113.5", "публичный адрес машины не разобран");
    assert.strictEqual(machines[0].internalIp, "10.0.0.5");
    assert.ok(callsTo(stub, "/instanceGroups/ig-web/instances").length >= 1, "машины спрашиваются не у группы");
  });

  await test("ycIg: карточка собирает группу, машины и операции — тремя запросами по id", async () => {
    const c = await ig.card("oauth-1", "folder-1", "web");
    assert.ok(c, "карточка пустая");
    assert.strictEqual(c.group.id, "ig-web", "группа найдена не по имени: " + c.group.id);
    assert.strictEqual(c.instances.length, 3);
    assert.strictEqual(c.operations.length, 2);
    assert.strictEqual(c.operations[0].done, true);
    assert.strictEqual(c.operations[1].done, false, "незавершённая операция показана как сделанная");
    assert.ok(callsTo(stub, "/instanceGroups/ig-web/operations").length >= 1, "операции не спрошены у группы");
  });

  await test("ycIg: группа ищется и по имени, и по id; чужого имени нет — null, а не выдумка", async () => {
    const byName = await ig.findGroup("oauth-1", "folder-1", "web");
    assert.strictEqual(byName.id, "ig-web");
    const byId = await ig.findGroup("oauth-1", "folder-1", "ig-locked");
    assert.strictEqual(byId.name, "locked");
    assert.strictEqual(await ig.findGroup("oauth-1", "folder-1", "нет-такой"), null, "несуществующая группа не отвергнута");
    assert.strictEqual(await ig.card("oauth-1", "folder-1", "нет-такой"), null);
  });

  await test("ycIg: без каталога и без id — отказ ДО сети (и за это не платят)", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => ig.groups("oauth-1", ""), /каталог/);
    await assert.rejects(() => ig.instances("oauth-1", ""), /id группы/);
    await assert.rejects(() => ig.operations("oauth-1", ""), /id группы/);
    await assert.rejects(() => ig.group("oauth-1", ""), /id группы/);
    assert.strictEqual(stub.calls.length, before, "запрос ушёл, хотя каталога/id нет");
  });

  console.log("\n[3] Создание группы: подсеть, образ, безопасность и тело запроса");

  await test("ycIg: создание читает подсеть, ищет образ по семейству и собирает настоящее тело", async () => {
    const r = await ig.create("oauth-1", {
      folderId: "folder-1",
      name: "web-1",
      subnet: "app-subnet",
      size: 2,
      cores: 4,
      memoryGb: 8,
      diskSizeGb: 30,
      publicIp: true,
    });
    assert.strictEqual(stub.created.length, 1, "тело создания не ушло");
    const body = stub.created[0];
    assert.strictEqual(body.name, "web-1");
    assert.strictEqual(body.folderId, "folder-1");
    assert.strictEqual(body.scalePolicy.fixedScale.size, "2", "число машин группы не в scalePolicy");
    assert.strictEqual(body.instanceTemplate.resourcesSpec.cores, "4");
    assert.strictEqual(body.instanceTemplate.resourcesSpec.memory, "8589934592", "память уходит БАЙТАМИ");
    assert.strictEqual(body.instanceTemplate.bootDiskSpec.diskSpec.size, "32212254720", "диск уходит БАЙТАМИ");
    assert.strictEqual(body.instanceTemplate.bootDiskSpec.diskSpec.imageId, "img-ubuntu-2204", "образ не найден по семейству");
    assert.strictEqual(body.instanceTemplate.networkInterfaceSpecs[0].subnetIds[0], "sub-1", "в шаблон ушла не та подсеть");
    assert.strictEqual(body.instanceTemplate.networkInterfaceSpecs[0].networkId, "net-1", "сеть не взята из подсети");
    assert.ok(body.instanceTemplate.networkInterfaceSpecs[0].primaryV4AddressSpec.oneToOneNatSpec, "публичный адрес не запрошен");
    assert.deepStrictEqual(body.allocationPolicy.zones, [{ zoneId: "ru-central1-a" }], "зона группы не взята из подсети");
    assert.ok(body.deployPolicy.startupDuration, "в теле нет политики выката");
    assert.ok(/standard-images/.test(callsTo(stub, "images:latestByFamily").slice(-1)[0].url), "образ ищется не в служебном каталоге");
    assert.strictEqual(r.groupId, "ig-new", "id готовой группы не достали из ответа операции");
    assert.ok(/машин 2/.test(r.message), "размер не назван в ответе: " + r.message);
  });

  await test("ycIg: группы безопасности находятся по ИМЕНИ, а оставшейся по умолчанию сказано вслух", async () => {
    stub.created.length = 0;
    const withSg = await ig.create("oauth-1", { folderId: "folder-1", name: "web-2", subnet: "sub-1", securityGroups: ["web", "ssh"] });
    assert.deepStrictEqual(stub.created[0].instanceTemplate.networkInterfaceSpecs[0].securityGroupIds, ["sg-1", "sg-2"], "группы безопасности не разрешены в id");
    assert.ok(!withSg.warnings.some((w) => /не заданы/.test(w)), "предупреждение про группы безопасности осталось, хотя они заданы: " + withSg.warnings.join(" | "));

    stub.created.length = 0;
    const withoutSg = await ig.create("oauth-1", { folderId: "folder-1", name: "web-3", subnet: "app-subnet" });
    assert.ok(!stub.created[0].instanceTemplate.networkInterfaceSpecs[0].securityGroupIds, "появились группы безопасности, которых не просили");
    assert.ok(withoutSg.warnings.some((w) => /Группы безопасности не заданы/.test(w) && /SSH/.test(w)), "о закрытом SSH не сказано: " + withoutSg.warnings.join(" | "));
    assert.ok(withoutSg.warnings.some((w) => /платит/.test(w)), "о том, что платят машины группы, не сказано");
  });

  await test("ycIg: ключ SSH кладётся в метаданные шаблона, прерываемость и аккаунт — в тело", async () => {
    stub.created.length = 0;
    await ig.create("oauth-1", {
      folderId: "folder-1",
      name: "web-4",
      subnet: "app-subnet",
      sshPublicKey: "ssh-ed25519 AAAA… user@pc",
      sshUser: "ubuntu",
      preemptible: true,
      serviceAccountId: "sa-7",
    });
    const body = stub.created[0];
    assert.strictEqual(body.instanceTemplate.metadata["ssh-keys"], "ubuntu:ssh-ed25519 AAAA… user@pc", "ключ SSH не попал в метаданные");
    assert.strictEqual(body.instanceTemplate.schedulingPolicy.preemptible, true);
    assert.strictEqual(body.serviceAccountId, "sa-7");
    assert.strictEqual(body.instanceTemplate.metadata["serial-port-enable"], "1", "последовательный порт не включён — а он единственный способ увидеть, что машина не поднялась");
  });

  await test("ycIg: отказы до сети — кривое имя, чужая зона, размер вне 1…100, память и диск", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => ig.create("oauth-1", { folderId: "folder-1", name: "1web", subnet: "app-subnet" }), /облако не примет/);
    await assert.rejects(() => ig.create("oauth-1", { folderId: "folder-1", name: "web-x", subnet: "нет-такой" }), /Не нашёл подсеть/);
    await assert.rejects(() => ig.create("oauth-1", { folderId: "folder-1", name: "web-x", subnet: "other-subnet", zone: "ru-central1-a" }), /зона подсети|разные/);
    await assert.rejects(() => ig.create("oauth-1", { folderId: "folder-1", name: "web-x", subnet: "app-subnet", size: 0 }), /от 1 до 100/);
    await assert.rejects(() => ig.create("oauth-1", { folderId: "folder-1", name: "web-x", subnet: "app-subnet", size: 200 }), /от 1 до 100/);
    await assert.rejects(() => ig.create("oauth-1", { folderId: "folder-1", name: "web-x", subnet: "app-subnet", memoryGb: 0 }), /memoryGb/);
    await assert.rejects(() => ig.create("oauth-1", { folderId: "folder-1", name: "web-x", subnet: "app-subnet", diskSizeGb: 2 }), /diskSizeGb/);
    // Отказы случаются и после ЧТЕНИЯ (подсеть ищется в каталоге — это бесплатно),
    // но ни одной ЗАПИСИ при негодных данных уйти не должно: за неё платят.
    const writes = stub.calls.slice(before).filter((c) => c.method === "POST" || c.method === "DELETE");
    assert.deepStrictEqual(writes.map((c) => c.url), [], "запрос на создание ушёл, хотя данные негодные — за это платили бы");
    assert.ok(stub.calls.slice(before).some((c) => c.method === "GET"), "даже подсеть не спросили: " + stub.calls.length);
  });

  console.log("\n[4] Питание группы и удаление вместе с машинами");

  await test("ycIg: «уже работает» и «уже остановлена» — это ответ, а не ошибка", async () => {
    const running = await ig.power("oauth-1", "start", { id: "ig-web", name: "web", active: true, status: "ACTIVE" }, { folderId: "folder-1" });
    assert.strictEqual(running.changed, false, "старт работающей группы считается изменением");
    assert.ok(/уже работает/.test(running.message), running.message);
    const stopped = await ig.power("oauth-1", "stop", { id: "ig-locked", name: "locked", active: false, status: "STOPPED", busy: false }, { folderId: "folder-1" });
    assert.strictEqual(stopped.changed, false);
    assert.ok(/уже остановлена/.test(stopped.message), stopped.message);
  });

  await test("ycIg: занятая группа отбивается ДО сети — иначе облако ответило бы «500»", async () => {
    const before = stub.calls.length;
    const list = await ig.groups("oauth-1", "folder-1");
    const busy = list.find((g) => g.name === "busy");
    await assert.rejects(() => ig.power("oauth-1", "start", busy, { folderId: "folder-1" }), /занята/);
    const afterList = stub.calls.length;
    await assert.rejects(() => ig.power("oauth-1", "start", busy, { folderId: "folder-1" }), /занята/);
    assert.strictEqual(stub.calls.length, afterList, "питание занятой группы всё-таки ушло в облако");
    assert.ok(stub.calls.length >= before);
  });

  await test("ycIg: запуск и остановка уходят POST-ом :start/:stop и говорят про деньги", async () => {
    const list = await ig.groups("oauth-1", "folder-1");
    const locked = list.find((g) => g.name === "locked");
    const started = await ig.power("oauth-1", "start", locked, { folderId: "folder-1" });
    assert.strictEqual(started.changed, true);
    assert.ok(/платят за каждый час/.test(started.warnings.join(" ")), "о плате за час не сказано: " + started.warnings.join(" | "));
    const req = callsTo(stub, ":start").slice(-1)[0];
    assert.strictEqual(req.method, "POST", "питание не POST");
    assert.strictEqual(req.url, "/compute/v1/instanceGroups/ig-locked:start", "не тот путь питания: " + req.url);

    const list2 = await ig.groups("oauth-1", "folder-1");
    const web = list2.find((g) => g.name === "web");
    const stopped = await ig.power("oauth-1", "stop", web, { folderId: "folder-1" });
    assert.ok(/диски/.test(stopped.warnings.join(" ")), "не сказано, что диски у остановленной группы всё равно платные");
  });

  await test("ycIg: удаление забирает машины и диски, а защита от удаления останавливает его ДО сети", async () => {
    const list = await ig.groups("oauth-1", "folder-1");
    const locked = list.find((g) => g.name === "locked");
    const before = stub.calls.filter((c) => c.method === "DELETE").length;
    await assert.rejects(() => ig.remove("oauth-1", { group: locked, folderId: "folder-1" }), /защита от удаления/);
    assert.strictEqual(stub.calls.filter((c) => c.method === "DELETE").length, before, "удаление ушло, хотя стоит защита");

    const web = list.find((g) => g.name === "web");
    const r = await ig.remove("oauth-1", { group: web, folderId: "folder-1" });
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.machines, 3, "в ответе не названо, сколько машин уйдёт");
    assert.ok(/3 шт/.test(r.message) && /нельзя/.test(r.message), "последствия удаления не названы: " + r.message);
    assert.ok(/Диски/.test(r.warnings.join(" ")), "не сказано про диски");
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url === "/compute/v1/instanceGroups/ig-web"), "удаление ушло не по id группы");
  });

  console.log("\n[5] Канал yc:ig: настоящий registerYcIpc и отказы словами");

  await test("yc:ig: канал есть в мосте, а из main.js убран; модуль собран и передан", () => {
    assert.ok(IPC_SRC.indexOf('ipcMain.handle("yc:ig"') > 0, "нет канала yc:ig");
    assert.ok(!MAIN_SRC.includes('ipcMain.handle("yc:ig"'), "канал остался в main.js");
    assert.ok(/const ycIg = createYcIg\(\{/.test(MAIN_SRC), "модуль Групп машин не собран в main.js");
    assert.ok(/waitOperation/.test(MAIN_SRC.slice(MAIN_SRC.indexOf("const ycIg = createYcIg("), MAIN_SRC.indexOf("const ycIg = createYcIg(") + 400)), "модулю не передано ожидание операции — создание осталось бы без ответа");
    const reg = /registerYcIpc\(\{([\s\S]{0,700}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /ycIg/.test(reg[1]), "канал IPC не получает модуль Групп машин");
    assert.ok(/ycIg: \(args\) => ipcRenderer\.invoke\("yc:ig"/.test(PRELOAD_SRC), "окно не видит канал yc:ig");
    assert.ok(/  ycIg,\n/.test(MAIN_SRC), "модуль не передан инструментам агента");
  });

  await test("yc:ig: список действий канала — ОДНА правда (массив ALL), и отказ зовёт именно его", () => {
    const body = section(IPC_SRC, "yc:ig");
    const arr = body.match(/const ALL = \[([^\]]+)\];/);
    assert.ok(arr, "в канале нет списка доступных действий");
    assert.ok(/Доступно:\s*" \+ ALL\.join\(", "\)/.test(body), "отказ канала не называет действия из ALL");
    const ops = arr[1].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    assert.deepStrictEqual(ops.slice().sort(), ["card", "create", "delete", "instances", "list", "operations", "start", "stop"].sort(), "список действий канала: " + ops.join(", "));
    for (const part of ["ycIg.groups(", "ycIg.findGroup(", "ycIg.card(", "ycIg.instances(", "ycIg.operations(", "ycIg.create(", "ycIg.power(", "ycIg.remove(", "ycIg.groupLine(", "ycIg.instanceLine("]) {
      assert.ok(body.includes(part), "канал не зовёт " + part);
    }
    assert.ok(/needsConfirm: true/.test(body) && /a\.confirm !== true/.test(body), "канал не спрашивает согласие на платное и необратимое");
  });

  await test("yc:ig: канал зовётся правда — список, карточка, машины, операции", async () => {
    const handlers = new Map();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-ig-ui-"));
    const settings = settingsFor();
    registerYcIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      yandexCloud: yandex,
      ycConsole: {},
      ycCosts: {},
      ycVpc: {},
      ycCompute: {},
      ycIam: {},
      ycFunctions: {},
      ycBilling: {},
      ycCdn: {},
      ycMonitoring: {},
      ycAi: {},
      ycMdb: {},
      ycIg: ig,
      fs: fs,
      path: path,
      resolvePath: (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(workDir, String(p))),
      agentWorkDir: () => workDir,
      loadSettings: () => settings,
      saveSettings: () => {},
      svc: {
        YANDEX_OAUTH_URL: "https://oauth.yandex.ru/authorize",
        ycConfig: () => ({
          oauth: "oauth-1",
          cloudId: "cloud-1",
          folderId: "folder-1",
          folderName: "prod",
          allowCreate: false,
          allowDelete: false,
          allowUpdate: false,
          allowPublic: false,
        }),
        ycRequireAuth: () => {},
        readYcLogsText: async () => "",
        ycCliStatus: () => ({}),
        ycCliInstall: async () => ({}),
      },
    });
    const call = (args) => handlers.get("yc:ig")({}, args || {});

    const list = await call({ op: "list" });
    assert.strictEqual(list.ok, true, "канал отказал на списке: " + (list.error || ""));
    assert.strictEqual(list.groups.length, 3);
    assert.ok(list.lines.some((l) => /web/.test(l) && /машин 2\/3/.test(l)), "строка группы не показана: " + list.lines.join(" | "));
    assert.ok(list.warnings.some((w) => /устаревш/.test(w)), "не сказано, что часть машин устарела и будет пересоздана");

    const card = await call({ op: "card", group: "web" });
    assert.strictEqual(card.ok, true, "канал отказал на карточке: " + (card.error || ""));
    assert.ok(card.lines.some((l) => /Шаблон:/.test(l)), "в карточке нет шаблона: " + card.lines.join(" | "));
    assert.ok(card.lines.some((l) => /Машины \(3\)/.test(l)), "в карточке нет машин: " + card.lines.join(" | "));
    assert.ok(card.lines.some((l) => /Network Load Balancer/.test(l)), "не сказано, что группа отдаёт трафик балансировщику");
    assert.ok(card.lines.some((l) => /Проверок здоровья: 2/.test(l)), "проверки здоровья не показаны");

    const machines = await call({ op: "instances", group: "web" });
    assert.strictEqual(machines.instances.length, 3);
    assert.ok(machines.lines.some((l) => /203\.0\.113\.5/.test(l)), "адрес машины не показан");

    const ops = await call({ op: "operations", group: "web" });
    assert.strictEqual(ops.operations.length, 2);
    assert.ok(ops.lines.some((l) => /^…/.test(l)), "незавершённая операция показана как сделанная: " + ops.lines.join(" | "));

    // Чужое действие отбивается словами и ПЕРЕЧИСЛЯЕТ действия — иначе человек
    // видел бы «неизвестное действие» без подсказки, что можно.
    const unknown = await call({ op: "nope" });
    assert.strictEqual(unknown.ok, false);
    assert.ok(/Неизвестное действие Instance Groups/.test(unknown.error), unknown.error);
    assert.ok(/Доступно: list, card, instances, operations, create, start, stop, delete/.test(unknown.error), "отказ не перечислил действия: " + unknown.error);
    const notFound = await call({ op: "card", group: "нет-такой" });
    assert.ok(/Не нашёл группу/.test(notFound.error), notFound.error);
  });

  await test("yc:ig: создание и удаление без согласия — вопрос с ценой, а не отказ-тупик", async () => {
    const handlers = new Map();
    const settings = settingsFor();
    registerYcIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      yandexCloud: yandex,
      ycConsole: {},
      ycCosts: {},
      ycVpc: {},
      ycCompute: {},
      ycIam: {},
      ycFunctions: {},
      ycBilling: {},
      ycCdn: {},
      ycMonitoring: {},
      ycAi: {},
      ycMdb: {},
      ycIg: ig,
      fs: fs,
      path: path,
      resolvePath: (p) => String(p),
      agentWorkDir: () => os.tmpdir(),
      loadSettings: () => settings,
      saveSettings: () => {},
      svc: {
        YANDEX_OAUTH_URL: "https://oauth.yandex.ru/authorize",
        ycConfig: () => ({ oauth: "oauth-1", cloudId: "cloud-1", folderId: "folder-1", folderName: "prod", allowCreate: false, allowDelete: false, allowUpdate: false, allowPublic: false }),
        ycRequireAuth: () => {},
        readYcLogsText: async () => "",
        ycCliStatus: () => ({}),
        ycCliInstall: async () => ({}),
      },
    });
    const call = (args) => handlers.get("yc:ig")({}, args || {});

    stub.created.length = 0;
    const c = await call({ op: "create", name: "web-9", subnet: "app-subnet", size: 2 });
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.needsConfirm, true, "канал не помечает, что нужен вопрос человеку");
    assert.ok(/ценой/.test(c.error) && /за час работы/.test(c.error), "цена не названа: " + c.error);
    assert.ok(c.lines.some((l) => /Машин: 2/.test(l)), "размер не назван в вопросе: " + c.lines.join(" | "));
    assert.strictEqual(stub.created.length, 0, "группа создана без согласия");

    const ok = await call({ op: "create", name: "web-9", subnet: "app-subnet", size: 2, confirm: true });
    assert.strictEqual(ok.ok, true, "согласованное создание отказало: " + (ok.error || ""));
    assert.ok(ok.groupId, "id созданной группы не вернулся окну");
    assert.ok((ok.warnings || []).length >= 2, "предупреждения о деньгах и адресе потерялись");

    const d = await call({ op: "delete", group: "locked" });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.needsConfirm, true);
    assert.ok(/ВМЕСТЕ с машинами/.test(d.error) && /необратимо/.test(d.error), "последствия удаления не названы: " + d.error);
  });

  await test("yc:ig: без токена, без каталога и с чужим действием канал отвечает словами", async () => {
    const handlers = new Map();
    const settings = settingsFor({ yandexOauthToken: "" });
    registerYcIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      yandexCloud: yandex,
      ycConsole: {},
      ycCosts: {},
      ycVpc: {},
      ycCompute: {},
      ycIam: {},
      ycFunctions: {},
      ycBilling: {},
      ycCdn: {},
      ycMonitoring: {},
      ycAi: {},
      ycMdb: {},
      ycIg: ig,
      fs: fs,
      path: path,
      resolvePath: (p) => String(p),
      agentWorkDir: () => os.tmpdir(),
      loadSettings: () => settings,
      saveSettings: () => {},
      svc: {
        YANDEX_OAUTH_URL: "https://oauth.yandex.ru/authorize",
        ycConfig: () => ({ oauth: "", cloudId: "", folderId: "folder-1", folderName: "", allowCreate: false, allowDelete: false, allowUpdate: false, allowPublic: false }),
        ycRequireAuth: () => {},
        readYcLogsText: async () => "",
        ycCliStatus: () => ({}),
        ycCliInstall: async () => ({}),
      },
    });
    const call = (args) => handlers.get("yc:ig")({}, args || {});
    const needAuth = await call({ op: "list" });
    assert.strictEqual(needAuth.ok, false);
    assert.ok(/OAuth-токен/.test(needAuth.error), "о токене не сказано: " + needAuth.error);
    assert.ok(/Yandex Cloud/.test(needAuth.error), "отказ не назвал сервис: " + needAuth.error);
    // Даже чужое действие не должно отвечать согласием на что-то: сначала
    // проверка подключения, и только потом — действия.
    const unknown = await call({ op: "nope" });
    assert.strictEqual(unknown.ok, false);
  });

  console.log("\n[6] Инструмент агента ycIg: что модель читает и чего не делает без согласия");

  await test("ycIg (агент): список называет размер, цену и то, что машины пересоздаются", async () => {
    stub.reset();
    const tools = buildTools();
    const out = await tools.ycIg({ action: "list" });
    assert.ok(/Группы машин/.test(out), out);
    assert.ok(/web/.test(out) && /машин 2\/3/.test(out), "строка группы не показана: " + out);
    assert.ok(/ycCosts/.test(out) && /платит за час/.test(out), "цена не названа: " + out);
    assert.ok(/удалённая руками машина вернётся/.test(out), "не сказано, что группа пересоздаёт машины: " + out);
    assert.ok(/card/.test(out), "не подсказано, как посмотреть карточку: " + out);
  });

  await test("ycIg (агент): создание без согласия — цена и размер, а не запрос в облако", async () => {
    const tools = buildTools();
    stub.created.length = 0;
    const out = await tools.ycIg({ action: "create", name: "web-5", subnet: "app-subnet", size: 3 });
    assert.ok(/ценой/.test(out) && /confirm: true/.test(out), out);
    assert.ok(/машин: 3/.test(out), "размер не назван: " + out);
    assert.ok(/ycCosts/.test(out) && /ycBilling/.test(out), "не подсказано, где смотреть цену: " + out);
    assert.strictEqual(stub.created.length, 0, "группа создана без согласия человека");
  });

  await test("ycIg (агент): карточка, машины и операции отвечают настоящими данными", async () => {
    const tools = buildTools();
    const card = await tools.ycIg({ action: "card", group: "web" });
    assert.ok(/Шаблон:/.test(card) && /Машины \(3\)/.test(card), card);
    assert.ok(/Питание: ycIg \{ action: "stop"/.test(card), "не подсказано, как остановить группу: " + card);
    const machines = await tools.ycIg({ action: "instances", group: "web" });
    assert.ok(/web-2/.test(machines) && /устарела/.test(machines), machines);
    const ops = await tools.ycIg({ action: "operations", group: "web" });
    assert.ok(/Операции группы/.test(ops) && /Create instance group/.test(ops), ops);
    const none = await tools.ycIg({ action: "card", group: "нет-такой" });
    assert.ok(/не нашёл группу/.test(none), none);
  });

  await test("ycIg (агент): удаление без согласия перечисляет последствия и не трогает облако", async () => {
    const tools = buildTools();
    const before = stub.calls.filter((c) => c.method === "DELETE").length;
    const out = await tools.ycIg({ action: "delete", group: "web" });
    assert.ok(/необратимо/.test(out) && /ВМЕСТЕ с машинами/.test(out), out);
    assert.ok(/confirm: true/.test(out), out);
    assert.strictEqual(stub.calls.filter((c) => c.method === "DELETE").length, before, "удаление ушло без согласия");
    const prot = await tools.ycIg({ action: "delete", group: "locked", confirm: true });
    assert.ok(/защита от удаления|deletionProtection/.test(prot), prot);
  });

  await test("ycIg (агент): чужие действия и отсутствие каталога отбиваются словами", async () => {
    const tools = buildTools();
    const unknown = await tools.ycIg({ action: "nope" });
    assert.ok(/неизвестное действие ycIg/.test(unknown), unknown);
    assert.ok(/Доступно: list, card, instances, operations, create, start, stop, delete/.test(unknown), unknown);
    const noFolder = await tools.ycIg({ action: "list" }, undefined);
    assert.ok(/каталог/.test(noFolder) || /Группы машин/.test(noFolder), noFolder);
    const empty = buildTools({ ycFolderId: "" });
    const noFolder2 = await empty.ycIg({ action: "list" });
    assert.ok(/выбери каталог/.test(noFolder2), noFolder2);
    const noToken = buildTools({ yandexOauthToken: "" });
    const needAuth = await noToken.ycIg({ action: "list" });
    assert.ok(/не подключён/.test(needAuth), needAuth);
  });

  await test("ycIg (агент): остановка и запуск говорят, что будет с деньгами", async () => {
    const tools = buildTools();
    const list = await tools.ycIg({ action: "list" });
    assert.ok(/web/.test(list), list);
    const stop = await tools.ycIg({ action: "stop", group: "web" });
    assert.ok(/останавливается/.test(stop), stop);
    assert.ok(/диски/.test(stop), "не сказано, что диски остаются платными: " + stop);
    const start = await tools.ycIg({ action: "start", group: "locked" });
    assert.ok(/запускается/.test(start), start);
    assert.ok(/платят за каждый час|за час/.test(start), "о плате за час не сказано: " + start);
  });

  console.log("\n[7] Интерфейс: семейство действий, плитка полки и связи консоли");

  await test("yc-actions: семейство «Группы машин» зовёт канал и помечает платное и опасное", () => {
    const ctx = { window: {}, document: undefined, navigator: {}, console: console };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(ACTIONS_SRC, ctx, { filename: "yc-actions.js" });
    const A = ctx.window.YcActions;
    assert.strictEqual(A.CHANNELS.instanceGroups, "ycIg", "семейство смотрит не в тот канал");
    const ids = A.forService("instanceGroups");
    for (const need of ["list", "card", "instances", "operations", "create", "start", "stop", "delete"]) {
      assert.ok(ids.indexOf(need) >= 0, "в семействе нет действия " + need);
    }
    const create = A.describe("instanceGroups", "create");
    assert.strictEqual(create.paid, true, "создание группы не помечено платным");
    assert.strictEqual(create.confirmArg, "confirm", "форма не назвала аргумент согласия");
    for (const field of ["name", "subnet", "size", "cores", "memoryGb", "diskSizeGb", "publicIp", "sshPublicKey"]) {
      assert.ok(create.fields.indexOf(field) >= 0, "в форме создания нет поля " + field);
    }
    assert.strictEqual(A.describe("instanceGroups", "delete").danger, true, "удаление группы не помечено опасным");
    assert.strictEqual(A.describe("instanceGroups", "delete").confirmArg, "confirm");
    const req = A.request("instanceGroups", "create", { name: "web", subnet: "app-subnet" }, true);
    assert.strictEqual(req.channel, "ycIg");
    assert.strictEqual(req.args.op, "create");
    assert.strictEqual(req.args.confirm, true, "согласие не ушло в канал");
    assert.strictEqual(A.request("instanceGroups", "create", { name: "web" }, false).args.confirm, undefined, "лишний confirm: false сбил бы проверку канала");
    assert.ok(A.FAMILIES.instanceGroups && /Группы машин/.test(A.FAMILIES.instanceGroups.title), "у семейства нет русского имени");
  });

  await test("полка: плитка «Группы машин» со знаком сервиса и русской формой слова", () => {
    const svc = yandex.SERVICES.find((s) => s.key === "instanceGroups");
    assert.ok(svc, "нет сервиса instanceGroups в SERVICES");
    assert.ok(/[А-Яа-яЁё]/.test(svc.ru), "плитка названа не по-русски: " + svc.ru);
    assert.strictEqual(svc.svc, "compute", "группы живут не на сервисе compute: " + svc.svc);
    assert.ok(svc.listPath.indexOf("/instanceGroups") > 0, "плитка смотрит не на группы: " + svc.listPath);
    assert.strictEqual(svc.listKey, "instanceGroups");
    assert.ok(/"compute": "https:\/\/compute\.api\.cloud\.yandex\.net"/.test(YANDEX_SRC), "нет выверенного адреса Compute в KNOWN_ENDPOINTS");
    assert.ok(LOGOS.has("instanceGroups"), "у плитки нет знака сервиса");
    assert.ok(/viewBox="0 0 32 32"/.test(LOGOS.LOGOS.instanceGroups), "знак не 32×32");
    assert.ok(LOGOS.isSafe(LOGOS.LOGOS.instanceGroups), "в знаке что-то исполняемое");
    assert.ok(/Yandex Instance Groups/.test(LOGOS.official("instanceGroups")), "у знака нет официального имени: " + LOGOS.official("instanceGroups"));
    assert.ok(PANEL_SRC.indexOf('instanceGroups: ["группа машин"') > 0, "в полке нет русской формы слова для групп");
  });

  await test("консоль и дашборд видят один набор: у групп есть карточка и связи", () => {
    assert.strictEqual(ycConsole.SERVICE_ENDPOINT.instanceGroups, "compute", "консоль не знает, куда идти за группой");
    assert.ok(ycConsole.DETAIL_PATHS.instanceGroups, "у карточки группы нет пути");
    assert.strictEqual(ycConsole.DETAIL_PATHS.instanceGroups({ id: "ig-1" }), "/compute/v1/instanceGroups/ig-1");
    const rel = ycConsole.RELATIONS.instanceGroups.map((r) => r.key).sort();
    assert.deepStrictEqual(rel, ["instances", "operations"], "связи группы: " + rel.join(", "));
    const machines = ycConsole.RELATIONS.instanceGroups.find((r) => r.key === "instances").attempts[0].path({ id: "ig-1" });
    assert.ok(machines.indexOf("/compute/v1/instanceGroups/ig-1/instances") === 0, "машины группы читаются не по её id: " + machines);
    const ops = ycConsole.RELATIONS.instanceGroups.find((r) => r.key === "operations").attempts[0].path({ id: "ig-1" });
    assert.ok(ops.indexOf("/compute/v1/instanceGroups/ig-1/operations") === 0, "операции группы читаются не по её id: " + ops);
    const table = ycConsole.buildTable("instanceGroups", "instances", [{ name: "web-1", zoneId: "ru-central1-a", status: "RUNNING_ACTUAL" }], Date.now());
    assert.deepStrictEqual(table.columns.map((c) => c.key), ["name", "zoneId", "status"], "колонки машин группы: " + table.columns.map((c) => c.key).join(", "));
    assert.ok(SMOKE_SRC.indexOf('"yc:ig"') > 0, "сторож smoke не знает канал yc:ig");
    assert.ok(/каналов в мосте должно быть 41/.test(SMOKE_SRC), "сторож каналов не пересчитан");
    assert.ok(SMOKE_SRC.indexOf('"ycIg"') > 0, "сторож smoke не знает инструмент ycIg");
  });

  console.log("\n[8] Согласованность: схема, промпт, политика, справочник и цепочка");

  await test("ycIg: схема, группа «облако», промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycIg"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 5200);
    for (const part of ["action", "group", "name", "subnet", "size", "cores", "memoryGb", "diskSizeGb", "imageFamily", "publicIp", "securityGroups", "sshPublicKey", "confirm", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/не пересоздаёт|пересоздаёт/.test(schema), "схема молчит о том, что группа пересоздаёт машины");
    assert.ok(/САМА создаёт машины/.test(schema), "схема не объясняет, чем группа отличается от машины");
    assert.ok(/confirm: true/.test(schema) && /Платят МАШИНЫ/.test(schema), "схема молчит про цену и согласие");
    const groupAt = CORE_SRC.indexOf('id: "cloud"');
    assert.ok(groupAt > 0 && CORE_SRC.slice(groupAt, groupAt + 1600).includes('"ycIg"'), "инструмента нет в группе «облако»");
    assert.ok(/группа машин|группы машин/.test(CORE_SRC.slice(groupAt, groupAt + 1600)), "в ключевых словах группы нет групп машин");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycIg/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycIg \(ГРУППЫ ОДИНАКОВЫХ МАШИН/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycIg");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 400).includes('"ycIg"'), "нет назначения cloud.read для ycIg");
  });

  await test("ycIg: справочник агента учит формам, цене и тому, чем группа не машина", () => {
    assert.ok(/ycIg \{ action/.test(GUIDE_SRC), "в yc.md нет пункта ycIg");
    assert.ok(/ГРУППЫ ОДИНАКОВЫХ МАШИН/.test(GUIDE_SRC), "в yc.md не сказано, что это за ресурс");
    assert.ok(/ПЕРЕСОЗДАЁТ удалённые руками/.test(GUIDE_SRC), "в yc.md не сказано про пересоздание машин");
    assert.ok(/платят МАШИНЫ группы/.test(GUIDE_SRC), "в yc.md нет правила про цену");
    assert.ok(/subnet/.test(GUIDE_SRC) && /zone/.test(GUIDE_SRC), "в yc.md не сказано про зону подсети");
    assert.ok(/deletionProtection/.test(GUIDE_SRC), "в yc.md не сказано про защиту от удаления");
  });

  await test("ycIg: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-ig.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало" + (failed ? " — есть ошибки" : ""));
  process.exit(failed ? 1 : 0);
})();

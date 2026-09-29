"use strict";

/* ── Compute Cloud: машины, диски, снимки, консоль и метрики ─────────────────
   Запуск: node test/yc-compute.test.js   (входит в общий `npm test`)

   Зачем набор. Облако умело всё, кроме главного: самих машин. Машина — это
   «компьютер в дата-центре», на котором живёт сайт, бот или база. Пока её
   нельзя было ни поднять, ни посмотреть, ни остановить, весь путь «свой сервер»
   человек проходил руками в чужой консоли.

   Что проверяется и почему именно это:

     • перевод единиц: облако ждёт память и диск в БАЙТАХ строкой, а человек
       думает в гигабайтах. Ошибка здесь — это отказ сервиса «неверный размер»
       на середине создания;
     • зона: у машины, подсети и статического адреса она одна. Если зона не
       названа, она берётся ИЗ ПОДСЕТИ, а не из константы: иначе облако отвечает
       «subnet is in a different zone». Проверяем и понятный отказ при
       расхождении;
     • тело создания целиком (одним deepStrictEqual): образ по семейству,
       подсеть по имени, группа безопасности по имени, ключ SSH и serial-консоль
       в метаданных, публичный адрес только по просьбе;
     • результат, а не факт отправки: после удаления машина перечитывается (иначе
       агент отчитается об удалении, которого не было), после правки питания —
       тоже;
     • деньги: удаление машины НЕ удаляет её диски (если не попросили), и об
       оставшихся платных дисках сказано прямо; снимок предлагается до удаления;
     • serial-консоль и метрики — единственный «экран» машины: пустая консоль
       объясняется, а при пустых данных метрик ничего не выдумывается;
     • инструмент агента ycCompute: права (создание / питание / удаление)
       проверяются ДО запроса, наборы конфигураций отдаются с ценой, а без
       подтверждения машина не создаётся;
     • проводка: канал yc:compute, мост окна, схема, группа «облако» в ядре,
       промпт, политика прав, справочник агента и цепочка npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а инструмент агента получает НАСТОЯЩИЙ модуль машин. */

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
const GB = 1024 * 1024 * 1024;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
const ycCosts = require(path.join(ROOT, "src", "yc-costs.js"));
const compute = require(path.join(ROOT, "src", "yc-compute.js"));
const { createYcCompute, bytesFromHuman, humanBytes, humanSpeed, humanUptime, statusHuman, isBusy, isRunning, parseCores, parseFraction, checkName, instanceInfo, looksLikePublicKey, generateSshKeyPair, sshUserForImage } = compute;
const { createYcVpc } = require(path.join(ROOT, "src", "yc-vpc.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const MAIN_SRC = read("src", "main.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke.test.js");
const PKG = JSON.parse(read("package.json"));

// ── Подменённый Yandex Cloud: Compute + VPC + Monitoring ────────────────────
// Настоящая машина состояний: создание, питание и удаление меняют то, что отдаёт
// чтение. Поэтому проверяется не форма запроса, а то, что после вызова в каталоге
// действительно стало иначе.
function initialState() {
  return {
    subnets: [
      { id: "sub-1", name: "app-subnet-a", networkId: "net-1", zoneId: "ru-central1-a", v4CidrBlocks: ["10.10.0.0/24"] },
      { id: "sub-2", name: "app-subnet-b", networkId: "net-1", zoneId: "ru-central1-b", v4CidrBlocks: ["10.11.0.0/24"] },
    ],
    networks: [{ id: "net-1", name: "my-net", defaultSecurityGroupId: "sg-default" }],
    securityGroups: [
      { id: "sg-default", name: "default-sg", networkId: "net-1", ruleSpecs: [] },
      { id: "sg-1", name: "web-sg", networkId: "net-1", ruleSpecs: [] },
    ],
    addresses: [
      { id: "ip-1", name: "web-ip", used: true, reserved: true, externalIpv4Address: { address: "203.0.113.10", zoneId: "ru-central1-a" } },
      { id: "ip-idle", name: "idle-ip", used: false, reserved: true, externalIpv4Address: { address: "203.0.113.99", zoneId: "ru-central1-a" } },
    ],
    disks: [
      { id: "disk-boot-1", name: "web-1-boot", typeId: "network-ssd", zoneId: "ru-central1-a", size: 20 * GB, status: "READY", instanceIds: ["vm-1"], sourceImageId: "img-ubuntu" },
      // autoDelete=false: такой диск ПЕРЕЖИВАЕТ машину и продолжает тарифицироваться.
      { id: "disk-data-1", name: "web-1-data", typeId: "network-hdd", zoneId: "ru-central1-a", size: 10 * GB, status: "READY", instanceIds: ["vm-1"] },
      { id: "disk-boot-2", name: "db-1-boot", typeId: "network-ssd", zoneId: "ru-central1-b", size: 20 * GB, status: "READY", instanceIds: ["vm-2"] },
      { id: "disk-orphan-1", name: "old-disk", typeId: "network-hdd", zoneId: "ru-central1-a", size: 10 * GB, status: "READY", instanceIds: [] },
    ],
    snapshots: [
      { id: "snap-1", name: "web-1-snap", sourceDiskId: "disk-boot-1", diskSize: 20 * GB, storageSize: 5 * GB, status: "READY", createdAt: daysAgo(3) },
      { id: "snap-2", name: "web-1-snap-old", sourceDiskId: "disk-boot-1", diskSize: 20 * GB, storageSize: 5 * GB, status: "READY", createdAt: daysAgo(30) },
      // Снимок диска, которого больше нет в каталоге: чистая плата за хранение.
      { id: "snap-gone", name: "dropped-snap", sourceDiskId: "disk-gone", diskSize: 20 * GB, storageSize: 4 * GB, status: "READY", createdAt: daysAgo(40) },
    ],
    instances: [
      {
        id: "vm-1",
        name: "web-1",
        folderId: "folder-1",
        zoneId: "ru-central1-a",
        platformId: "standard-v3",
        status: "RUNNING",
        createdAt: daysAgo(10),
        fqdn: "web-1.ru-central1.internal",
        resources: { cores: 2, memory: String(2 * GB), coreFraction: "20" },
        bootDisk: { diskId: "disk-boot-1", deviceName: "boot", mode: "READ_WRITE", autoDelete: true },
        secondaryDisks: [{ diskId: "disk-data-1", deviceName: "data", mode: "READ_WRITE", autoDelete: false }],
        networkInterfaces: [
          {
            index: 0,
            macAddress: "aa:bb:cc:00:00:01",
            subnetId: "sub-1",
            primaryV4Address: { address: "10.10.0.5", oneToOneNat: { address: "203.0.113.10" } },
            securityGroupIds: ["sg-1"],
          },
        ],
        metadata: { "serial-port-enable": "1", "ssh-keys": "ubuntu:ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test" },
      },
      {
        id: "vm-2",
        name: "db-1",
        folderId: "folder-1",
        zoneId: "ru-central1-b",
        platformId: "standard-v3",
        status: "STOPPED",
        createdAt: daysAgo(40),
        fqdn: "db-1.ru-central1.internal",
        resources: { cores: 2, memory: String(4 * GB), coreFraction: "100" },
        bootDisk: { diskId: "disk-boot-2", deviceName: "boot", mode: "READ_WRITE", autoDelete: true },
        secondaryDisks: [],
        networkInterfaces: [{ index: 0, macAddress: "aa:bb:cc:00:00:02", subnetId: "sub-2", primaryV4Address: { address: "10.11.0.5" }, securityGroupIds: [] }],
        metadata: {},
      },
    ],
    images: {
      "ubuntu-2204-lts": { id: "img-ubuntu", name: "ubuntu-2204-lts", family: "ubuntu-2204-lts", size: 2 * GB, minDiskSize: 10 * GB, status: "READY", os: { type: "LINUX" } },
    },
    zones: [
      { id: "ru-central1-a", status: "UP", regionId: "ru-central1" },
      { id: "ru-central1-b", status: "UP", regionId: "ru-central1" },
      { id: "ru-central1-d", status: "UP", regionId: "ru-central1" },
    ],
    serial: {
      "vm-1": [
        "Linux version 5.15.0",
        "[ OK ] Reached target Basic System",
        "[ OK ] Started nginx.service",
        "eth0: 10.10.0.5",
        "[ OK ] Finished cloud-init",
        "login:",
      ].join("\n"),
    },
    metricValues: {
      cpu_usage: [40, 60, 50],
      network_received_bytes: [1024, 2048],
      network_sent_bytes: [512],
      "disk.read_bytes": [4096],
      "disk.write_bytes": [2048],
    },
  };
}

function startComputeStub() {
  const calls = [];
  const state = initialState();
  // quiet — «облако делает вид, что сделало»: так проверяется, что обещание
  // подтверждается ПЕРЕЧТЕНИЕМ, а не фактом отправки запроса.
  const quiet = { deleteInstanceNoop: false };
  let seq = 500;
  const ops = new Map();

  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = String(req.url || "");
      const method = String(req.method || "GET").toUpperCase();
      const pathOnly = url.split("?")[0];
      calls.push({ method, url, body });

      if (pathOnly === "/iam/v1/tokens") {
        return json(res, 200, { iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }

      // Ожидание операции: подтверждаем сразу и отдаём id созданного объекта.
      if (pathOnly.indexOf("/operations/") === 0) {
        const id = pathOnly.slice("/operations/".length);
        return json(res, 200, { id, done: true, response: ops.get(id) || {} });
      }

      const op = (createdId) => {
        const id = "op-" + ++seq;
        if (createdId) ops.set(id, { id: createdId });
        return { id, done: false };
      };

      // ── сеть (её читает модуль машин: подсеть нужна до создания) ──
      if (pathOnly === "/vpc/v1/subnets") return json(res, 200, { subnets: plain(state.subnets) });
      if (pathOnly === "/vpc/v1/networks") return json(res, 200, { networks: plain(state.networks) });
      if (pathOnly === "/vpc/v1/securityGroups") return json(res, 200, { securityGroups: plain(state.securityGroups) });
      if (pathOnly === "/vpc/v1/addresses") {
        if (method === "GET") return json(res, 200, { addresses: plain(state.addresses) });
        const id = pathOnly.slice("/vpc/v1/addresses/".length);
        state.addresses = state.addresses.filter((a) => a.id !== id);
        return json(res, 200, op());
      }

      // ── метрики (Monitoring: отдельный сервис) ──
      if (pathOnly === "/monitoring/v2/data/read") {
        const b = JSON.parse(body || "{}");
        const m = /^([a-z_.]+)\{/.exec(String(b.query || ""));
        const name = m ? m[1] : "";
        const values = (state.metricValues || {})[name] || [];
        // Тело ответа — как у настоящего Monitoring: массив метрик, у каждой
        // timeseries с точками. Пустой список = «данных нет».
        return json(res, 200, { metrics: values.length ? [{ timeseries: { doubleValues: values } }] : [] });
      }

      if (pathOnly === "/compute/v1/zones") return json(res, 200, { zones: plain(state.zones) });

      if (pathOnly === "/compute/v1/images:latestByFamily") {
        const family = decodeURIComponent((url.split("family=")[1] || "").split("&")[0]);
        const img = state.images[family];
        return img ? json(res, 200, plain(img)) : json(res, 404, { code: 5, message: "Requested image not found" });
      }

      // ── машины ──
      if (pathOnly === "/compute/v1/instances") {
        if (method === "GET") return json(res, 200, { instances: plain(state.instances) });
        const b = JSON.parse(body || "{}");
        if (!b.name || !b.zoneId || !b.folderId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: name, zoneId и folderId обязательны" });
        const iface = (b.networkInterfaceSpecs || [])[0];
        if (!iface || !iface.subnetId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: сетевой интерфейс без подсети" });
        const subnet = state.subnets.find((s) => s.id === iface.subnetId);
        if (!subnet) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: subnet not found" });
        // Настоящий сервис отвечает именно так — и это самая частая ошибка в теле.
        if (subnet.zoneId !== b.zoneId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: subnet " + subnet.name + " is in a different zone" });
        if (!b.resourcesSpec || !b.resourcesSpec.memory || !b.resourcesSpec.cores) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: resourcesSpec" });
        if (typeof b.resourcesSpec.memory !== "string" || typeof b.resourcesSpec.cores !== "string") {
          return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: размеры передаются строками" });
        }
        const spec = (b.bootDiskSpec && b.bootDiskSpec.diskSpec) || null;
        const diskId = (b.bootDiskSpec && b.bootDiskSpec.diskId) || "";
        if (!spec && !diskId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: bootDiskSpec без диска и без образа" });
        const image = spec && spec.imageId ? Object.values(state.images).find((i) => i.id === spec.imageId) || null : null;
        if (spec && !diskId && !image) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: image not found" });
        if (image && Number(spec.size) < image.minDiskSize) {
          return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: disk size is less than minimum " + image.minDiskSize });
        }
        const id = "vm-" + ++seq;
        const num = state.instances.length + 1;
        const nat = iface.primaryV4AddressSpec && iface.primaryV4AddressSpec.oneToOneNatSpec;
        state.instances.push({
          id,
          name: b.name,
          folderId: b.folderId,
          zoneId: b.zoneId,
          platformId: b.platformId,
          status: "RUNNING",
          createdAt: new Date().toISOString(),
          fqdn: b.hostname || b.name + "." + b.zoneId + ".internal",
          resources: { cores: Number(b.resourcesSpec.cores), memory: Number(b.resourcesSpec.memory), coreFraction: b.resourcesSpec.coreFraction || "100" },
          bootDisk: { diskId: diskId || "disk-" + id + "-boot", deviceName: "boot", mode: "READ_WRITE", autoDelete: b.bootDiskSpec.autoDelete !== false },
          secondaryDisks: (b.secondaryDiskSpecs || []).map((s, i) => ({ diskId: "disk-" + id + "-sec" + i, deviceName: (s.diskSpec && s.diskSpec.name) || "data", mode: "READ_WRITE", autoDelete: s.autoDelete !== false })),
          networkInterfaces: [
            {
              index: 0,
              macAddress: "aa:bb:cc:00:00:0" + num,
              subnetId: iface.subnetId,
              primaryV4Address: Object.assign(
                { address: "10.10.0." + (num + 4) },
                nat ? { oneToOneNat: { address: nat.address || "198.51.100." + (num + 7) } } : {}
              ),
              securityGroupIds: iface.securityGroupIds || [],
            },
          ],
          metadata: b.metadata || {},
          labels: b.labels || {},
        });
        if (spec) {
          state.disks.push({ id: "disk-" + id + "-boot", name: b.name + "-boot", typeId: spec.typeId, zoneId: b.zoneId, size: Number(spec.size), status: "READY", instanceIds: [id], sourceImageId: spec.imageId || "" });
        }
        state.disks.push.apply(
          state.disks,
          (b.secondaryDiskSpecs || []).map((s, i) => ({ id: "disk-" + id + "-sec" + i, name: (s.diskSpec && s.diskSpec.name) || b.name + "-data", typeId: s.diskSpec && s.diskSpec.typeId, zoneId: b.zoneId, size: Number((s.diskSpec && s.diskSpec.size) || 0), status: "READY", instanceIds: [id] }))
        );
        return json(res, 200, op(id));
      }

      if (pathOnly.indexOf("/compute/v1/instances/") === 0) {
        const rest = pathOnly.slice("/compute/v1/instances/".length);
        const colon = rest.indexOf(":");
        const id = colon >= 0 ? rest.slice(0, colon) : rest;
        const act = colon >= 0 ? rest.slice(colon + 1) : "";
        const inst = state.instances.find((i) => i.id === id) || null;

        if (act === "serialPortOutput" && method === "GET") {
          return json(res, 200, { contents: state.serial[id] || "" });
        }
        if ((act === "start" || act === "stop" || act === "restart") && method === "POST") {
          if (!inst) return json(res, 404, { code: 5, message: "Instance not found" });
          inst.status = act === "stop" ? "STOPPED" : "RUNNING";
          if (act === "stop") {
            // У остановленной машины публичный адрес освобождается.
            for (const n of inst.networkInterfaces || []) if (n.primaryV4Address) delete n.primaryV4Address.oneToOneNat;
          }
          return json(res, 200, op());
        }
        if (!act && method === "GET") {
          return inst ? json(res, 200, plain(inst)) : json(res, 404, { code: 5, message: "Instance not found" });
        }
        if (!act && method === "DELETE") {
          if (!inst) return json(res, 404, { code: 5, message: "Instance not found" });
          // quiet.deleteInstanceNoop — ответ «сделано», а машина на месте.
          if (quiet.deleteInstanceNoop) return json(res, 200, op());
          const mine = [inst.bootDisk.diskId].concat((inst.secondaryDisks || []).map((d) => d.diskId)).filter(Boolean);
          state.instances = state.instances.filter((i) => i.id !== id);
          const keep = [];
          for (const d of state.disks) {
            if (mine.indexOf(d.id) < 0) {
              keep.push(d);
              continue;
            }
            const ref = inst.bootDisk.diskId === d.id ? inst.bootDisk : (inst.secondaryDisks || []).find((s) => s.diskId === d.id);
            if (ref && ref.autoDelete) continue; // уходит вместе с машиной
            d.instanceIds = (d.instanceIds || []).filter((x) => x !== id);
            keep.push(d);
          }
          state.disks = keep;
          return json(res, 200, op());
        }
      }

      // ── диски ──
      if (pathOnly === "/compute/v1/disks") {
        if (method === "GET") return json(res, 200, { disks: plain(state.disks) });
        const b = JSON.parse(body || "{}");
        if (!b.snapshotId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: только восстановление из снимка" });
        const snap = state.snapshots.find((s) => s.id === b.snapshotId);
        if (!snap) return json(res, 404, { code: 5, message: "Snapshot not found" });
        const id = "disk-" + ++seq;
        state.disks.push({ id, name: b.name, typeId: b.typeId, zoneId: b.zoneId, size: Number(b.size || snap.diskSize), status: "READY", instanceIds: [], sourceSnapshotId: snap.id });
        return json(res, 200, op(id));
      }

      if (pathOnly.indexOf("/compute/v1/disks/") === 0) {
        const id = pathOnly.slice("/compute/v1/disks/".length);
        if (method === "DELETE") {
          const d = state.disks.find((x) => x.id === id);
          if (d && (d.instanceIds || []).length) return json(res, 400, { code: 9, message: "FAILED_PRECONDITION: диск занят машиной" });
          state.disks = state.disks.filter((x) => x.id !== id);
          return json(res, 200, op());
        }
        const d = state.disks.find((x) => x.id === id);
        return d ? json(res, 200, plain(d)) : json(res, 404, { code: 5, message: "Disk not found" });
      }

      // ── снимки ──
      if (pathOnly === "/compute/v1/snapshots") {
        if (method === "GET") return json(res, 200, { snapshots: plain(state.snapshots) });
        const b = JSON.parse(body || "{}");
        if (!b.diskId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: diskId обязателен" });
        const disk = state.disks.find((d) => d.id === b.diskId);
        if (!disk) return json(res, 404, { code: 5, message: "Disk not found" });
        const id = "snap-" + ++seq;
        state.snapshots.push({ id, name: b.name, sourceDiskId: disk.id, diskSize: disk.size, storageSize: Math.round(disk.size / 3), status: "READY", createdAt: new Date().toISOString() });
        return json(res, 200, op(id));
      }

      if (pathOnly.indexOf("/compute/v1/snapshots/") === 0) {
        const id = pathOnly.slice("/compute/v1/snapshots/".length);
        if (method === "DELETE") {
          state.snapshots = state.snapshots.filter((s) => s.id !== id);
          return json(res, 200, op());
        }
        const s = state.snapshots.find((x) => x.id === id);
        return s ? json(res, 200, plain(s)) : json(res, 404, { code: 5, message: "Snapshot not found" });
      }

      return json(res, 404, { code: 5, message: "not found: " + method + " " + url });
    });
  });

  const reset = () => {
    const fresh = initialState();
    for (const k of Object.keys(fresh)) state[k] = fresh[k];
    quiet.deleteInstanceNoop = false;
    calls.length = 0;
  };

  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, quiet, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function mkCompute() {
  return createYcCompute({
    fetchJson: yandex._fetchJson,
    endpoint: yandex.endpoint,
    getIamToken: yandex.getIamToken,
    waitOperation: yandex.waitOperation,
    serviceError: yandex.serviceError,
    isNetworkError: yandex.isNetworkError,
  });
}

function mkVpc() {
  return createYcVpc({
    fetchJson: yandex._fetchJson,
    endpoint: yandex.endpoint,
    getIamToken: yandex.getIamToken,
    waitOperation: yandex.waitOperation,
    serviceError: yandex.serviceError,
    isNetworkError: yandex.isNetworkError,
  });
}

function buildTools(settingsOver) {
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
    yandexCloud: yandex,
    ycVpc: mkVpc(),
    ycCompute: mkCompute(),
    ycCosts,
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
  return { tools, settings };
}

// Изменяющие запросы: POST/PUT/DELETE, кроме служебных (токен и операции).
const writeCalls = (calls) =>
  calls.filter(
    (c) => (c.method === "POST" || c.method === "PUT" || c.method === "DELETE") && c.url.indexOf("/operations/") < 0 && c.url.indexOf("/tokens") < 0
  );

const PUBLIC_KEY = generateSshKeyPair({ comment: "nestdev-web-2" }).publicKey;

(async () => {
  const stub = await startComputeStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Единицы, имена и статусы приводятся к тому, что ждёт сервис");

  await test("ycCompute: размеры переводятся в байты и обратно, гигабайты не путаются с байтами", () => {
    assert.strictEqual(bytesFromHuman("2 ГБ", "Память"), 2 * GB, "«2 ГБ» не переведены");
    assert.strictEqual(bytesFromHuman("2048 МБ", "Память"), 2 * GB, "мегабайты не переведены");
    assert.strictEqual(bytesFromHuman("2GB", "Память"), 2 * GB, "«2GB» не переведены");
    assert.strictEqual(bytesFromHuman(2, "Память"), 2 * GB, "число 2 прочитано не как гигабайты");
    assert.strictEqual(bytesFromHuman(2 * GB, "Память"), 2 * GB, "готовые байты пересчитаны");
    assert.throws(() => bytesFromHuman("", "Память"), /укажи размер/, "пустой размер прошёл");
    assert.throws(() => bytesFromHuman("много", "Память"), /не похоже/, "мусор в размере прошёл");
    assert.strictEqual(humanBytes(2 * GB), "2 ГБ", "человеческий размер изменился: " + humanBytes(2 * GB));
    assert.strictEqual(humanBytes(0), "—", "пустой размер не назван прочерком");
    assert.strictEqual(humanSpeed(0), "0", "нулевая скорость изменилась: " + humanSpeed(0));
    assert.strictEqual(humanSpeed(2048), "2 КБ/с", "скорость в КБ не переведена: " + humanSpeed(2048));
    assert.strictEqual(humanUptime(new Date().toISOString()), "меньше суток", "возраст машины изменился");
    assert.strictEqual(humanUptime(daysAgo(5)), "5 дн.", "возраст машины в днях изменился: " + humanUptime(daysAgo(5)));
  });

  await test("ycCompute: ядра и уровень производительности проверяются до запроса", () => {
    assert.strictEqual(parseCores(2), 2, "нормальное число ядер не принято");
    assert.throws(() => parseCores(3), /Ядер/, "несуществующее число ядер прошло");
    assert.throws(() => parseCores(0), /Ядер/, "ноль ядер прошёл");
    assert.strictEqual(parseFraction(""), 20, "по умолчанию не экономный уровень");
    assert.strictEqual(parseFraction(100), 100, "полное ядро не принято");
    assert.throws(() => parseFraction(37), /производительности/, "несуществующий уровень прошёл");
  });

  await test("ycCompute: имя, статусы и карточка машины читаются человеческими словами", () => {
    assert.strictEqual(checkName("web-1"), "web-1", "нормальное имя не принято");
    assert.throws(() => checkName("Web-1"), /строчные/, "заглавные буквы прошли");
    assert.throws(() => checkName("веб"), /не подойдёт/, "кириллица прошла");
    assert.throws(() => checkName(""), /Укажи имя/, "пустое имя прошло");
    assert.strictEqual(statusHuman("RUNNING"), "работает", "статус RUNNING не переведён");
    assert.strictEqual(statusHuman("PROVISIONING"), "создаётся", "статус PROVISIONING не переведён");
    assert.strictEqual(isBusy("STOPPING"), true, "STOPPING не считается занятостью");
    assert.strictEqual(isBusy("RUNNING"), false, "работающая машина считается занятой");
    assert.strictEqual(isRunning("RUNNING"), true, "RUNNING не считается работой");

    const i = instanceInfo(stub.state.instances[0]);
    assert.strictEqual(i.statusHuman, "работает", "статус машины не переведён");
    assert.strictEqual(i.externalIp, "203.0.113.10", "внешний адрес не прочитан");
    assert.strictEqual(i.internalIp, "10.10.0.5", "внутренний адрес не прочитан");
    assert.deepStrictEqual(plain(i.subnetIds), ["sub-1"], "подсеть машины не прочитана");
    assert.deepStrictEqual(plain(i.securityGroupIds), ["sg-1"], "группы безопасности не прочитаны");
    assert.strictEqual(i.memoryHuman, "2 ГБ", "память машины не переведена: " + i.memoryHuman);
    // 2 ядра по 20% — это 0,4 ядра на самом деле. Без этого «2 ядра» читается как выделенные.
    assert.strictEqual(i.guaranteedVcpu, 0.4, "гарантированные ядра посчитаны неверно: " + i.guaranteedVcpu);
    assert.strictEqual(i.bootDisk.autoDelete, true, "загрузочный диск не помечен автоудаляемым");
    assert.strictEqual(i.secondaryDisks[0].keepsAfterDelete, true, "диск с autoDelete=false не помечен переживающим машину");
  });

  await test("ycCompute: ключ SSH собирается и узнаётся, пользователь берётся из образа", () => {
    const pair = generateSshKeyPair({ comment: "nestdev" });
    assert.ok(/^ssh-ed25519 AAAA[A-Za-z0-9+/]+=* nestdev$/.test(pair.publicKey), "публичный ключ собран неверно: " + pair.publicKey.slice(0, 40));
    assert.ok(/BEGIN PRIVATE KEY/.test(pair.privateKey), "приватный ключ не в PEM (PKCS8)");
    assert.ok(/^SHA256:[A-Za-z0-9+/]+$/.test(pair.fingerprint), "отпечаток ключа собран неверно: " + pair.fingerprint);
    const parsed = looksLikePublicKey(pair.publicKey);
    assert.ok(parsed && parsed.type === "ssh-ed25519", "свой же ключ не узнан");
    assert.strictEqual(looksLikePublicKey("ssh-ed25519 не-ключ"), null, "мусор в ключе прошёл проверку");
    assert.strictEqual(looksLikePublicKey(""), null, "пустой ключ прошёл проверку");
    assert.strictEqual(sshUserForImage("ubuntu-2204-lts"), "ubuntu", "пользователь Ubuntu не угадан");
    assert.strictEqual(sshUserForImage("debian-12"), "debian", "пользователь Debian не угадан");
    assert.strictEqual(sshUserForImage("almalinux-9"), "almalinux", "пользователь AlmaLinux не угадан");
  });

  await test("ycCompute: платные хвосты считаются по состоянию каталога, а не на глаз", () => {
    const c = mkCompute();
    const instances = stub.state.instances.map(instanceInfo);
    const disks = stub.state.disks.map(compute.diskInfo);
    const snapshots = stub.state.snapshots.map(compute.snapshotInfo);
    const addresses = [
      { id: "ip-1", name: "web-ip", address: "203.0.113.10", used: true },
      { id: "ip-idle", name: "idle-ip", address: "203.0.113.99", used: false },
    ];
    const l = c.paidLeftovers({ instances, disks, snapshots, addresses });
    assert.deepStrictEqual(plain(l.disks.map((d) => d.name)), ["old-disk"], "диск без машины не найден: " + JSON.stringify(l.disks.map((d) => d.name)));
    assert.deepStrictEqual(plain(l.snapshots.map((s) => s.name)), ["dropped-snap"], "снимок удалённого диска не найден");
    assert.deepStrictEqual(plain(l.addresses.map((a) => a.name)), ["idle-ip"], "простаивающий адрес не найден");
    assert.strictEqual(l.total, 3, "число хвостов посчитано неверно: " + l.total);
    assert.ok(l.lines.join(" ").indexOf("диски без машины") >= 0, "хвосты не названы словами");
    const empty = c.paidLeftovers({});
    assert.strictEqual(empty.total, 0, "пустой каталог дал платные хвосты");
    assert.deepStrictEqual(plain(empty.lines), [], "пустой каталог что-то придумал");
    // Наборы конфигураций обязаны быть видны сборке: их читают инструмент и панель.
    assert.deepStrictEqual(plain(c.PRESET_KEYS), ["micro", "small", "medium", "full"], "сборка не отдаёт список наборов");
    assert.strictEqual(c.PRESETS.small.cores, 2, "сборка не отдаёт сами наборы");
  });

  console.log("\n[2] Настоящие запросы к подменённому облаку");

  await test("ycCompute: машины, диски, снимки и образ читаются стабильными полями", async () => {
    stub.reset();
    const c = mkCompute();
    const vm = await c.instances("oauth-1", "folder-1");
    const dk = await c.disks("oauth-1", "folder-1");
    const sn = await c.snapshots("oauth-1", "folder-1");
    const img = await c.imageByFamily("oauth-1", "ubuntu-2204-lts");
    assert.strictEqual(vm.length, 2, "машины не прочитаны: " + vm.length);
    assert.strictEqual(vm.find((i) => i.name === "db-1").running, false, "остановленная машина помечена работающей");
    assert.strictEqual(dk.find((d) => d.name === "old-disk").attached, false, "свободный диск помечен занятым");
    assert.strictEqual(dk.find((d) => d.name === "web-1-boot").sizeHuman, "20 ГБ", "размер диска не переведён");
    assert.strictEqual(sn.find((s) => s.name === "web-1-snap").ageDays, 3, "возраст снимка посчитан неверно");
    assert.strictEqual(img.id, "img-ubuntu", "образ по семейству не найден");
    assert.strictEqual(stub.calls.some((c2) => c2.url.indexOf("images:latestByFamily") >= 0), true, "образ запрошен не по семейству");
    const got = await c.findInstance("oauth-1", "folder-1", "db-1");
    assert.strictEqual(got.id, "vm-2", "машина по имени не найдена");
    assert.strictEqual(await c.findInstance("oauth-1", "folder-1", "нет-такой"), null, "несуществующая машина найдена");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "чтение что-то изменило в облаке");
  });

  await test("ycCompute: машина создаётся целиком — образ по семейству, подсеть и группа по имени, ключ и serial в метаданных", async () => {
    stub.reset();
    const c = mkCompute();
    const r = await c.createInstance("oauth-1", {
      folderId: "folder-1",
      name: "web-2",
      subnet: "app-subnet-a",
      securityGroupIds: ["web-sg"],
      sshPublicKey: PUBLIC_KEY,
      publicIp: true,
      memoryGb: 2,
      diskSizeGb: 20,
    });
    const post = stub.calls.find((x) => x.method === "POST" && x.url.indexOf("/compute/v1/instances") >= 0);
    assert.ok(post, "запрос создания не ушёл");
    const body = JSON.parse(post.body);
    assert.deepStrictEqual(
      plain(body),
      {
        folderId: "folder-1",
        name: "web-2",
        zoneId: "ru-central1-a",
        platformId: "standard-v3",
        resourcesSpec: { memory: String(2 * GB), cores: "2", coreFraction: "20" },
        bootDiskSpec: { autoDelete: true, diskSpec: { typeId: "network-ssd", size: String(20 * GB), imageId: "img-ubuntu" } },
        networkInterfaceSpecs: [
          { subnetId: "sub-1", primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: "IPV4" } }, securityGroupIds: ["sg-1"] },
        ],
        metadata: { "ssh-keys": "ubuntu:" + PUBLIC_KEY, "serial-port-enable": "1" },
      },
      "тело создания машины собрано неверно: " + post.body
    );
    assert.strictEqual(r.instance.name, "web-2", "созданная машина не перечитана");
    assert.strictEqual(r.instance.running, true, "созданная машина не работает");
    assert.strictEqual(r.subnet.name, "app-subnet-a", "подсеть не названа в ответе");
    assert.strictEqual(r.publicIp, true, "публичный адрес не отмечен");
    assert.strictEqual(stub.state.instances.filter((i) => i.name === "web-2").length, 1, "машины нет в каталоге после создания");
    assert.strictEqual(stub.state.disks.filter((d) => d.name === "web-2-boot").length, 1, "загрузочного диска нет в каталоге");
    assert.strictEqual(r.warnings.filter((w) => /платит за каждый час/.test(w)).length, 1, "про деньги не сказано");
  });

  await test("ycCompute: набор micro задаёт память и дешёвый диск, зона берётся из подсети", async () => {
    stub.reset();
    const c = mkCompute();
    const r = await c.createInstance("oauth-1", { folderId: "folder-1", name: "bot-1", preset: "micro" });
    const post = stub.calls.find((x) => x.method === "POST" && x.url.indexOf("/compute/v1/instances") >= 0);
    const body = JSON.parse(post.body);
    assert.deepStrictEqual(plain(body.resourcesSpec), { memory: String(1 * GB), cores: "2", coreFraction: "20" }, "набор micro не применился: " + JSON.stringify(body.resourcesSpec));
    assert.deepStrictEqual(plain(body.bootDiskSpec.diskSpec), { typeId: "network-hdd", size: String(15 * GB), imageId: "img-ubuntu" }, "диск набора micro не тот");
    assert.strictEqual(body.zoneId, "ru-central1-a", "зона не взята из подсети");
    assert.strictEqual(stub.state.instances.find((i) => i.name === "bot-1").zoneId, "ru-central1-a", "машина создана не в зоне подсети");
    assert.ok(r.warnings.some((w) => /SSH-ключ не задан/.test(w)), "не сказано, что без ключа в машину не войти");
    assert.ok(r.warnings.some((w) => /Публичного адреса/.test(w)), "не сказано, что снаружи машина недоступна");
    assert.ok(r.warnings.some((w) => /группе безопасности по умолчанию/.test(w)), "не сказано про группу по умолчанию");
    assert.deepStrictEqual(plain(body.networkInterfaceSpecs[0].securityGroupIds), ["sg-default"], "группа по умолчанию сети не применена");
    assert.strictEqual(await c.createInstance("oauth-1", { folderId: "folder-1", name: "x-1", preset: "гигант" }).then(() => "нет", (e) => e.message).then((m) => /Набора/.test(m)), true, "несуществующий набор прошёл");
  });

  await test("ycCompute: без подсети в зоне, при расхождении зон и при малом диске — понятный отказ и НИ одного создания", async () => {
    stub.reset();
    const c = mkCompute();
    await assert.rejects(() => c.createInstance("oauth-1", { folderId: "folder-1", name: "x-1", zone: "ru-central1-d" }), /нет подсети/, "отсутствие подсети не проверено");
    await assert.rejects(
      () => c.createInstance("oauth-1", { folderId: "folder-1", name: "x-1", subnet: "app-subnet-a", zone: "ru-central1-b" }),
      /разные/,
      "расхождение зон машины и подсети не поймано"
    );
    await assert.rejects(() => c.createInstance("oauth-1", { folderId: "folder-1", name: "x-1", subnet: "app-subnet-a", diskSizeGb: 5 }), /меньше, чем требует образ/, "маленький диск прошёл проверку");
    await assert.rejects(() => c.createInstance("oauth-1", { folderId: "folder-1", name: "x-1", subnet: "нет-такой" }), /Не нашёл подсеть/, "несуществующая подсеть прошла");
    await assert.rejects(() => c.createInstance("oauth-1", { folderId: "folder-1", name: "X-1", subnet: "app-subnet-a" }), /не подойдёт/, "плохое имя прошло");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "несмотря на отказ, что-то создавалось");
  });

  await test("ycCompute: питание меняет состояние, повтор не пишет лишнего, занятая машина не трогается", async () => {
    stub.reset();
    const c = mkCompute();
    const already = await c.start("oauth-1", "web-1", { folderId: "folder-1" });
    assert.strictEqual(already.changed, false, "запуск работающей машины засчитан изменением");
    assert.ok(/уже работает/.test(already.message), "про уже работающую машину не сказано: " + already.message);

    const stopped = await c.stop("oauth-1", "web-1", { folderId: "folder-1" });
    assert.strictEqual(stopped.changed, true, "остановка не засчитана");
    assert.strictEqual(stub.state.instances.find((i) => i.id === "vm-1").status, "STOPPED", "машина не остановилась в каталоге");
    assert.ok(stopped.warnings.some((w) => /203\.0\.113\.10/.test(w) && /освобождается/.test(w)), "не сказано, что публичный адрес освобождается: " + JSON.stringify(stopped.warnings));
    const stoppedAgain = await c.stop("oauth-1", "web-1", { folderId: "folder-1" });
    assert.strictEqual(stoppedAgain.changed, false, "повторная остановка засчитана изменением");

    const started = await c.start("oauth-1", "db-1", { folderId: "folder-1" });
    assert.strictEqual(stub.state.instances.find((i) => i.id === "vm-2").status, "RUNNING", "остановленная машина не запустилась");
    assert.ok(/запущена/.test(started.message), "ответ о запуске непонятен: " + started.message);
    const restarted = await c.restart("oauth-1", "db-1", { folderId: "folder-1" });
    assert.ok(/перезагружается/.test(restarted.message), "ответ о перезагрузке непонятен: " + restarted.message);

    await assert.rejects(() => c.power("oauth-1", "привет", "db-1", {}), /неизвестное действие/, "неизвестное действие питания прошло");
    await assert.rejects(() => c.start("oauth-1", "нет-такой", { folderId: "folder-1" }), /Не нашёл машину/, "несуществующая машина найдена");
    stub.state.instances.find((i) => i.id === "vm-2").status = "STARTING";
    await assert.rejects(() => c.stop("oauth-1", "db-1", { folderId: "folder-1" }), /занята/, "занятая машина всё-таки тронута");
  });

  await test("ycCompute: удаление машины подтверждается перечитыванием, а оставшиеся диски названы платными", async () => {
    stub.reset();
    const c = mkCompute();
    const r = await c.deleteInstance("oauth-1", { folderId: "folder-1", instance: "web-1", releaseAddress: true });
    assert.strictEqual(r.deleted, true, "удаление не подтверждено");
    assert.ok(!stub.state.instances.some((i) => i.id === "vm-1"), "машина осталась в каталоге");
    assert.ok(stub.calls.some((x) => x.method === "GET" && x.url.indexOf("/compute/v1/instances/vm-1") >= 0), "результат удаления не перепроверен");
    assert.ok(!stub.state.disks.some((d) => d.id === "disk-boot-1"), "загрузочный диск с autoDelete остался");
    assert.deepStrictEqual(plain(r.keptDisks.map((k) => k.disk.name)), ["web-1-data"], "диск с autoDelete=false не остался: " + JSON.stringify(r.keptDisks.map((k) => k.disk.name)));
    assert.ok(stub.state.disks.some((d) => d.id === "disk-data-1"), "диск с autoDelete=false пропал из каталога");
    assert.ok(r.warnings.some((w) => /Остались платные диски/.test(w) && /тарифицируются/.test(w)), "про платные диски не сказано: " + JSON.stringify(r.warnings));
    // Статический адрес занят — освобождать его нечего, и об этом сказано.
    assert.strictEqual(r.releasedAddress, null, "занятый адрес освобождён");
    assert.ok(stub.state.addresses.some((a) => a.id === "ip-1"), "занятый адрес пропал из каталога");
    assert.ok(r.warnings.some((w) => /мог быть статическим/.test(w)), "нет предупреждения про публичный адрес");
  });

  await test("ycCompute: удаление с deleteDisks:true забирает и диски, и предупреждает о необратимости", async () => {
    stub.reset();
    const c = mkCompute();
    const r = await c.deleteInstance("oauth-1", { folderId: "folder-1", name: "web-1", deleteDisks: true });
    assert.deepStrictEqual(plain(r.deletedDisks.map((d) => d.name)), ["web-1-data"], "оставшийся диск не удалён: " + JSON.stringify(r.deletedDisks.map((d) => d.name)));
    assert.strictEqual(r.keptDisks.length, 0, "после удаления дисков что-то осталось");
    assert.ok(!stub.state.disks.some((d) => d.id === "disk-data-1"), "диск остался в каталоге");
    assert.ok(r.warnings.some((w) => /восстановить нельзя/.test(w)), "не сказано, что данные не восстановить: " + JSON.stringify(r.warnings));
    assert.strictEqual(stub.state.instances.filter((i) => i.id === "vm-2").length, 1, "чужая машина пострадала");
  });

  // Облако может ответить «сделано» и ничего не сделать (права, чужая зона,
  // молча отброшенное поле). Проверяем именно это: обещание «машина удалена»
  // обязано подтверждаться ПЕРЕЧТЕНИЕМ, иначе агент отчитается об удалении,
  // которого не было, а машина продолжит платить за каждый час.
  await test("ycCompute: молча не удалённая машина ловится перечитыванием", async () => {
    stub.reset();
    stub.quiet.deleteInstanceNoop = true;
    const c = mkCompute();
    await assert.rejects(() => c.deleteInstance("oauth-1", { folderId: "folder-1", name: "web-1" }), /не удалилась/, "удаление без результата принято за успех");
    assert.strictEqual(stub.state.instances.filter((i) => i.id === "vm-1").length, 1, "машина всё-таки пропала из каталога");
    stub.quiet.deleteInstanceNoop = false;
  });

  await test("ycCompute: снимок создаётся с диска и с машины, а удаление подтверждается перечитыванием", async () => {
    stub.reset();
    const c = mkCompute();
    const made = await c.createSnapshot("oauth-1", { folderId: "folder-1", disk: "web-1-boot", name: "before-upgrade" });
    const post = stub.calls.find((x) => x.method === "POST" && x.url.indexOf("/compute/v1/snapshots") >= 0);
    assert.deepStrictEqual(plain(JSON.parse(post.body)), { folderId: "folder-1", diskId: "disk-boot-1", name: "before-upgrade" }, "тело снимка собрано неверно: " + post.body);
    assert.strictEqual(made.snapshot.name, "before-upgrade", "снимок не перечитан после создания");
    assert.strictEqual(made.snapshot.sourceDiskId, "disk-boot-1", "снимок сделан не с того диска");
    assert.ok(made.warnings.some((w) => /тарифицируется/.test(w)), "про платность снимка не сказано");
    assert.ok(made.warnings.some((w) => /остановить запись/.test(w)), "про снимок живой базы не предупреждено");

    const fromVm = await c.createSnapshot("oauth-1", { folderId: "folder-1", instance: "web-1" });
    assert.strictEqual(fromVm.disk.id, "disk-boot-1", "снимок с машины сделан не с загрузочного диска: " + fromVm.disk.id);
    assert.ok(/^web-1-boot-snap-\d{4}-\d{2}-\d{2}$/.test(fromVm.snapshot.name), "имя снимка по умолчанию изменилось: " + fromVm.snapshot.name);

    await assert.rejects(() => c.createSnapshot("oauth-1", { folderId: "folder-1" }), /Укажи, с чего делать снимок/, "снимок без диска прошёл");

    await c.deleteSnapshot("oauth-1", { folderId: "folder-1", snapshot: "dropped-snap" });
    assert.ok(!stub.state.snapshots.some((s) => s.id === "snap-gone"), "снимок не удалён");
    assert.ok(stub.calls.some((x) => x.method === "GET" && x.url.indexOf("/compute/v1/snapshots") >= 0), "результат удаления снимка не перепроверен");
  });

  await test("ycCompute: чистка снимков сначала только показывает, по-настоящему удаляет лишь по просьбе", async () => {
    stub.reset();
    const c = mkCompute();
    const dry = await c.cleanSnapshots("oauth-1", { folderId: "folder-1", keep: 1 });
    assert.strictEqual(dry.dryRun, true, "чистка сразу удаляет — так нельзя");
    assert.deepStrictEqual(plain(dry.doomed.map((s) => s.name)), ["web-1-snap-old"], "к удалению выбран не самый старый снимок: " + JSON.stringify(dry.doomed.map((s) => s.name)));
    assert.deepStrictEqual(plain(dry.kept.map((s) => s.name)).sort(), ["dropped-snap", "web-1-snap"], "последний снимок не сохранён");
    assert.ok(/Пока ничего не удалено/.test(dry.message), "ответ чистки непонятен: " + dry.message);
    assert.strictEqual(stub.calls.filter((x) => x.method === "DELETE").length, 0, "показ что-то удалил");

    const real = await c.cleanSnapshots("oauth-1", { folderId: "folder-1", keep: 1, dryRun: false });
    assert.deepStrictEqual(plain(real.removed.map((s) => s.name)), ["web-1-snap-old"], "по-настоящему удалён не тот снимок");
    assert.ok(!stub.state.snapshots.some((s) => s.id === "snap-2"), "старый снимок остался в каталоге");
    assert.ok(stub.state.snapshots.some((s) => s.id === "snap-1"), "свежий снимок удалён вместе со старым");

    const byAge = await c.cleanSnapshots("oauth-1", { folderId: "folder-1", keep: 5, olderThanDays: 20 });
    assert.deepStrictEqual(plain(byAge.doomed.map((s) => s.name)).sort(), ["dropped-snap"], "по возрасту выбран не тот снимок: " + JSON.stringify(byAge.doomed.map((s) => s.name)));
  });

  await test("ycCompute: диск из снимка восстанавливается, но меньше снимка быть не может", async () => {
    stub.reset();
    const c = mkCompute();
    await assert.rejects(() => c.restoreDisk("oauth-1", { folderId: "folder-1", snapshot: "web-1-snap" }), /зону/, "восстановление без зоны прошло");
    await assert.rejects(() => c.restoreDisk("oauth-1", { folderId: "folder-1", snapshot: "web-1-snap", zone: "ru-central1-a", sizeGb: 5 }), /не может быть меньше снимка/, "диск меньше снимка прошёл");

    const r = await c.restoreDisk("oauth-1", { folderId: "folder-1", snapshot: "web-1-snap", zone: "ru-central1-a" });
    const post = stub.calls.find((x) => x.method === "POST" && x.url.indexOf("/compute/v1/disks") >= 0);
    assert.deepStrictEqual(
      plain(JSON.parse(post.body)),
      { folderId: "folder-1", name: "web-1-snap-restored", zoneId: "ru-central1-a", typeId: "network-ssd", snapshotId: "snap-1" },
      "тело восстановления диска собрано неверно: " + post.body
    );
    assert.strictEqual(r.disk.name, "web-1-snap-restored", "диск не перечитан после восстановления");
    assert.strictEqual(r.disk.attached, false, "восстановленный диск помечен занятым");
    assert.ok(/Машины у него пока нет/.test(r.message), "не сказано, что машины у диска нет: " + r.message);
    assert.ok(stub.state.disks.some((d) => d.id === r.disk.id), "диска нет в каталоге после восстановления");
  });

  await test("ycCompute: serial-консоль отдаёт хвост, а пустая консоль объяснена", async () => {
    stub.reset();
    const c = mkCompute();
    const r = await c.serialOutput("oauth-1", { folderId: "folder-1", instance: "web-1", lines: 3 });
    assert.strictEqual(r.empty, false, "непустая консоль названа пустой");
    assert.strictEqual(r.lines.length, 3, "хвост консоли отдан не целиком: " + r.lines.length);
    assert.strictEqual(r.lines[r.lines.length - 1], "login:", "в хвосте не последние строки: " + JSON.stringify(r.lines));
    assert.strictEqual(r.port, 1, "порт консоли по умолчанию изменился");
    assert.ok(stub.calls.some((x) => x.url.indexOf(":serialPortOutput?port=1") >= 0), "консоль запрошена не тем адресом");

    const empty = await c.serialOutput("oauth-1", { folderId: "folder-1", instance: "db-1" });
    assert.strictEqual(empty.empty, true, "пустая консоль названа непустой");
    assert.ok(/serial-port-enable/.test(empty.message), "пустая консоль не объяснена: " + empty.message);
  });

  await test("ycCompute: метрики читаются из Monitoring и объясняются словами", async () => {
    stub.reset();
    const c = mkCompute();
    const r = await c.metrics("oauth-1", { folderId: "folder-1", instance: "web-1", minutes: 60 });
    const post = stub.calls.find((x) => x.method === "POST" && x.url.indexOf("/monitoring/v2/data/read") >= 0);
    assert.ok(post, "запрос метрик не ушёл в Monitoring");
    const body = JSON.parse(post.body);
    assert.ok(/resource_id="vm-1"/.test(body.query), "метрики запрошены не по машине: " + body.query);
    assert.ok(/service="compute"/.test(body.query), "метрики запрошены не по сервису compute");
    assert.strictEqual(r.metrics.length, 5, "прочитаны не все метрики: " + r.metrics.length);
    const cpu = r.metrics.find((m) => m.key === "cpu");
    assert.strictEqual(cpu.summary.avg, 50, "средняя нагрузка посчитана неверно: " + cpu.summary.avg);
    assert.strictEqual(cpu.summary.max, 60, "пиковая нагрузка посчитана неверно");
    assert.strictEqual(cpu.format(50.4), "50,4%", "проценты печатаются неверно: " + cpu.format(50.4));
    assert.strictEqual(r.idle, false, "работающая машина названа простаивающей");
    assert.ok(r.lines.some((l) => /нагружен/.test(l)), "нагрузка не объяснена словами: " + JSON.stringify(r.lines));
    assert.strictEqual(r.errors.length, 0, "часть метрик не прочиталась: " + JSON.stringify(r.errors));
  });

  // Негативный контроль: данных нет — значит и цифр быть не должно. Иначе агент
  // «увидит» нулевую нагрузку у машины, которая на самом деле просто остановлена.
  await test("ycCompute: при пустых данных метрик ничего не выдумывается", async () => {
    stub.reset();
    stub.state.metricValues = {};
    const c = mkCompute();
    const r = await c.metrics("oauth-1", { folderId: "folder-1", instance: "web-1" });
    assert.strictEqual(r.metrics.length, 5, "список метрик изменился");
    assert.strictEqual(r.metrics.every((m) => m.summary.count === 0), true, "появились точки, которых не было");
    assert.strictEqual(r.idle, false, "пустые данные превратились в «простаивает»");
    assert.ok(r.lines.every((l) => !/в среднем/.test(l)), "появилось среднее из ничего: " + JSON.stringify(r.lines));
    assert.ok(r.lines.every((l) => /данных за 60 мин нет/.test(l)), "отсутствие данных не объяснено: " + JSON.stringify(r.lines));
  });

  console.log("\n[3] Инструмент агента ycCompute: права и ответы");

  await test("ycCompute: без подключения, без каталога и с непонятным действием отвечает честно", async () => {
    const noAuth = buildTools({ yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await noAuth.tools.ycCompute({ action: "list" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({ ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycCompute({ action: "list" }, {})), "нет ответа про каталог");
    const { tools } = buildTools();
    const bad = await tools.ycCompute({ action: "подними сервер" }, {});
    assert.ok(/неизвестное действие/.test(bad), "неизвестное действие не объяснено: " + bad);
    assert.ok(/presets/.test(bad), "в отказе нет списка действий: " + bad);
  });

  await test("ycCompute: запреты (создание, питание, удаление) звучат ДО запроса и не трогают облако", async () => {
    stub.reset();
    const { tools } = buildTools();
    const create = await tools.ycCompute({ action: "create", name: "x-1", confirm: true }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(create) && /создавать ресурсы/.test(create), "нет запрета на создание: " + create);
    const power = await tools.ycCompute({ action: "stop", instance: "web-1" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(power) && /останавливать/.test(power), "нет запрета на питание: " + power);
    const del = await tools.ycCompute({ action: "delete", instance: "web-1" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(del) && /удалять ресурсы/.test(del), "нет запрета на удаление: " + del);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "запрет не помешал запросу в облако");
    // Чтение при выключенных правах доступно — иначе агент не увидит даже списка.
    const list = await tools.ycCompute({ action: "list" }, {});
    assert.ok(/Машины в каталоге/.test(list), "чтение запрещено вместе с изменениями: " + list);
  });

  await test("ycCompute: list показывает машины, остановленные, платные хвосты, а presets — наборы с ценой", async () => {
    stub.reset();
    const { tools } = buildTools();
    const out = await tools.ycCompute({ action: "list" }, {});
    assert.ok(/web-1 — работает/.test(out), "нет работающей машины: " + out);
    assert.ok(/db-1 — остановлена/.test(out), "нет остановленной машины");
    assert.ok(/db-1 — сама машина за это не платит/.test(out), "остановленные не выделены отдельно");
    assert.ok(/Платные хвосты/.test(out) && /old-disk/.test(out) && /dropped-snap/.test(out), "платные хвосты не названы");
    assert.ok(/presets/.test(out), "нет подсказки про наборы конфигураций");

    const presets = await tools.ycCompute({ action: "presets" }, {});
    assert.ok(!/Cannot read/.test(presets), "наборы конфигураций падают на чтении цен: " + presets);
    for (const key of ["micro", "small", "medium", "full"]) assert.ok(presets.indexOf(key) >= 0, "в наборах нет " + key);
    assert.ok(/в месяц/.test(presets), "в наборах нет цены: " + presets);
    assert.ok(/sshPublicKey/.test(presets), "в наборах не сказано про ключ SSH");
  });

  await test("ycCompute: card, serial и metrics отвечают словами, а create без подтверждения цену только показывает", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentCreate: true });
    const card = await tools.ycCompute({ action: "card", instance: "web-1" }, {});
    assert.ok(/web-1 — работает/.test(card), "карточка машины непонятна: " + card);
    assert.ok(/загрузочный диск: web-1-boot 20 ГБ/.test(card), "в карточке нет загрузочного диска");
    assert.ok(/диски: web-1-data 10 ГБ \(останется после удаления\)/.test(card), "в карточке нет диска, который переживёт машину");
    assert.ok(/Виртуальная машина \(Compute Cloud\)/.test(card), "в карточке нет цены");
    assert.ok(/stop/.test(card), "карточка не подсказывает, что делать дальше");

    const serial = await tools.ycCompute({ action: "serial", instance: "web-1", lines: 20 }, {});
    assert.ok(/Serial-консоль машины «web-1»/.test(serial), "serial отвечает непонятно: " + serial);
    assert.ok(/nginx/.test(serial), "serial не показывает, что происходит внутри");

    const met = await tools.ycCompute({ action: "metrics", instance: "web-1" }, {});
    assert.ok(/Нагрузка машины «web-1»/.test(met), "метрики отвечают непонятно: " + met);
    assert.ok(/Процессор: в среднем 50%/.test(met), "в метриках нет нагрузки процессора: " + met);

    const ask = await tools.ycCompute({ action: "create", name: "web-9", preset: "small", subnet: "app-subnet-a" }, {});
    assert.ok(/тарифицируется за каждый час/.test(ask), "без подтверждения нет предупреждения о плате: " + ask);
    assert.ok(/₽/.test(ask), "без подтверждения нет цены");
    assert.ok(/confirm: true/.test(ask), "не сказано, как подтвердить создание");
    assert.strictEqual(stub.state.instances.filter((i) => i.name === "web-9").length, 0, "машина создана без подтверждения");

    const made = await tools.ycCompute({ action: "create", name: "web-9", preset: "small", subnet: "app-subnet-a", confirm: true }, {});
    assert.ok(/✅ Машина создана: web-9/.test(made), "машина не создана: " + made);
    assert.ok(/подсеть: app-subnet-a/.test(made), "в ответе нет подсети");
    assert.ok(/serial/.test(made), "не сказано, как посмотреть, что происходит внутри");
    assert.strictEqual(stub.state.instances.filter((i) => i.name === "web-9").length, 1, "машины нет в каталоге");
  });

  await test("ycCompute: leftovers и disks объясняют платные хвосты и цену, а цена машины считается из тарифов", () => {
    const est = ycCosts.estimate("compute", { cores: 2, coreFraction: 20, memoryGb: 2, diskSizeGb: 20, diskTypeId: "network-ssd", publicIp: true });
    assert.ok(est && est.approxMonth > 0, "у машины нет оценки стоимости");
    assert.strictEqual(est.needsConfirm, true, "машина не требует согласия");
    assert.ok(/с НДС/.test(ycCosts.formatText(est)), "в оценке нет ссылки на тарифы");
    const scenarios = est.scenarios.map((s) => s.title).join(" | ");
    assert.ok(/круглосуточно/.test(scenarios) && /остановлена/.test(scenarios), "в оценке нет сценариев работы и простоя: " + scenarios);
    const snap = ycCosts.estimate("computeSnapshot", { gb: 20 });
    assert.ok(snap.approxMonth > 0 && /Снимок диска/.test(snap.title), "у снимка нет оценки стоимости");
  });

  console.log("\n[4] Проводка: канал, мост окна, оболочка");

  await test("ycCompute: канал yc:compute есть в мосте, окно его видит, оболочка собирает модуль и передаёт его дальше", () => {
    assert.ok(/ipcMain\.handle\("yc:compute"/.test(IPC_SRC), "нет канала yc:compute");
    assert.ok(/ycCompute: \(args\) => ipcRenderer\.invoke\("yc:compute"/.test(PRELOAD_SRC), "окно не видит канал yc:compute");
    assert.ok(/const \{ createYcCompute \} = require\("\.\/yc-compute\.js"\)/.test(MAIN_SRC), "оболочка не подключает модуль машин");
    assert.ok(/const ycCompute = createYcCompute\(\{/.test(MAIN_SRC), "модуль машин не собран в оболочке");
    // Имя в списке аргументов registerYcIpc, а не соседство строк: точная
    // последовательность ломается от появления любого соседнего модуля
    // (так и вышло, когда рядом встал IAM).
    const reg = /registerYcIpc\(\{([\s\S]{0,400}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /\bycCompute\b/.test(reg[1]), "канал IPC не получает модуль машин");
    assert.ok(reg && /\bloadSettings\b/.test(reg[1]), "канал IPC не получает настройки");
    assert.ok(/handle\("yc:compute"[\s\S]{0,4000}?folderId: cfg\.folderId/.test(IPC_SRC), "канал не передаёт каталог в модуль");
    // Помощники облака передаются настоящие — иначе модуль молча ничего не сделает.
    for (const dep of ["fetchJson: yandexCloud._fetchJson", "endpoint: yandexCloud.endpoint", "getIamToken: yandexCloud.getIamToken", "waitOperation: yandexCloud.waitOperation"]) {
      assert.ok(MAIN_SRC.indexOf(dep) >= 0, "в сборку модуля не передан " + dep);
    }
    // Панель читает наборы и хвосты из ОБЪЕКТА модуля, а не из его файла.
    assert.ok(/presets: ycCompute\.PRESETS/.test(IPC_SRC), "канал не отдаёт наборы конфигураций панели");
  });

  await test("ycCompute: схема, группа «облако», промпт, права и справочник знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycCompute"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 7000);
    for (const part of ["action", "instance", "name", "preset", "subnet", "cores", "memoryGb", "coreFraction", "diskSizeGb", "diskType", "publicIp", "staticAddress", "sshPublicKey", "preemptible", "dataDiskSizeGb", "snapshot", "keep", "dryRun", "minutes", "lines", "deleteDisks", "releaseAddress", "confirm", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/создавать ресурсы/.test(schema) && /удалять ресурсы/.test(schema), "схема не называет разрешения");
    assert.ok(/пароля у неё нет|нет пароля/.test(schema), "схема не объясняет, что пароля у машины нет");
    assert.ok(/экран/.test(schema), "схема не объясняет, что машина без экрана");
    assert.ok(/[Пп]рерываем/.test(schema), "схема не объясняет прерываемую машину");

    const group = CORE_SRC.slice(CORE_SRC.indexOf('id: "cloud"'), CORE_SRC.indexOf('id: "cloud"') + 900);
    assert.ok(/ycCompute/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycCompute/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycCompute \(виртуальные машины/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycCompute");

    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 340).includes('"ycCompute"'), "нет назначения cloud.read для ycCompute");

    assert.ok(/ycCompute/.test(GUIDE_SRC), "в yc.md нет ycCompute");
    assert.ok(/снимок/i.test(GUIDE_SRC), "справочник не говорит про снимки");
    assert.ok(/serial/.test(GUIDE_SRC), "справочник не говорит про serial-консоль");
  });

  await test("ycCompute: сторож smoke знает инструмент и канал, а набор стоит в цепочке npm test", () => {
    const smokeAt = SMOKE_SRC.indexOf('for (const n of ["ycStatus"');
    assert.ok(smokeAt > 0, "в smoke нет списка облачных инструментов");
    assert.ok(/"ycCompute"/.test(SMOKE_SRC.slice(smokeAt, smokeAt + 400)), "список инструментов в smoke не знает ycCompute");
    assert.ok(SMOKE_SRC.indexOf('"yc:compute"') >= 0, "канал yc:compute не посчитан в стороже");
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-compute.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

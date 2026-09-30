"use strict";

/* ── Instance Groups Yandex Cloud: одинаковые машины одной группой ───────────
   Зачем модуль. Машины у приложения есть (yc-compute.js), а ГРУПП машин нет:
   группа — это не «несколько машин», а другой ресурс со своей жизнью. Она сама
   создаёт и лечит машины по шаблону, держит их число (scalePolicy), катит
   обновления (deployPolicy) и умеет отдавать трафик балансировщику. Человеку
   из окна видно только список машин — то есть половину картины: он не знает,
   что машины управляемые, что их пересоздадут и что платит он за группу.

   Формы API сверены с официальным справочником (июнь 2026), а не взяты по
   памяти — Instance Groups живёт на ТОМ ЖЕ хосте, что Compute Cloud:
     GET    /compute/v1/instanceGroups?folderId=…          список
     GET    /compute/v1/instanceGroups/{id}                карточка
     GET    /compute/v1/instanceGroups/{id}/instances      машины группы
     GET    /compute/v1/instanceGroups/{id}/operations     операции группы
     POST   /compute/v1/instanceGroups                     создание
     POST   /compute/v1/instanceGroups/{id}:start|:stop    питание
     DELETE /compute/v1/instanceGroups/{id}                удаление

   Что важно знать и не потерять при правке:

     • ГРУППА — НЕ СПИСОК МАШИН. Машины в ней создаёт сама группа по шаблону
       (instanceTemplate): человек удалил машину руками — группа создаст новую.
       Поэтому модуль показывает и «машин в группе», и состояние группы, но не
       даёт удалять машины поштучно: это делается изменением размера группы.
     • В СПИСКЕ нет метаданных шаблона (view=BASIC по умолчанию) — и это
       правильно: метаданные (ssh-ключи) не нужны для списка, а весят много.
       Карточка тоже читает BASIC: ключей в ответах нет вовсе.
     • РАЗМЕР — это scalePolicy. fixedScale.size — «сколько машин держать», и
       именно он тарифицируется: каждая машина платит как обычная машина
       Compute Cloud (за час работы), а сама группа — нет. Остановленная
       группа (STOPPED) машины останавливает, диски продолжают платить.
     • ПОКА ГРУППА ЗАНЯТА (STARTING/STOPPING/DELETING), питание и удаление
       облако отклонит: лучше сказать это заранее словами, чем показать «500».
     • deletionProtection у группы отменяет удаление: причина называется прямо.
     • Группа может отдавать трафик балансировщику (loadBalancerState.
       targetGroupId для NLB и applicationLoadBalancerState.targetGroupId для
       ALB) — эта связь показывается в карточке: человек не должен искать,
       к чему привязан балансировщик.
     • Зоны: группа живёт в зонах, перечисленных в allocationPolicy.zones, а
       каждая зона требует ПОДСЕТЬ своей зоны. Модуль берёт подсеть (её и
       спрашивает), зона = зона подсети: одна группа — одна зона, и об этом
       сказано в ответе создания. Шаблон при этом один на всю группу.

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcCompute и createYcMdb), поэтому
   он проверяется в plain-node на подставных ответах сервиса. */

const IG_HOST = "https://compute.api.cloud.yandex.net";

const ZONE_DEFAULT = "ru-central1-a";
const PLATFORM_DEFAULT = "standard-v3";
const IMAGE_FAMILY_DEFAULT = "ubuntu-2204-lts";
const DISK_TYPE_DEFAULT = "network-ssd";
const DISK_GB_DEFAULT = 20;
const CORES_DEFAULT = 2;
const MEMORY_GB_DEFAULT = 2;
const CORE_FRACTION_DEFAULT = 100;
const STARTUP_DURATION = "60s";

// Состояния ГРУППЫ — из перечисления Status справочника API.
const STATUS_RU = {
  STATUS_UNKNOWN: "состояние неизвестно",
  STARTING: "запускается",
  ACTIVE: "работает",
  STOPPING: "останавливается",
  STOPPED: "остановлена",
  DELETING: "удаляется",
  PAUSED: "на паузе: процессы группы приостановлены",
};

// Состояния МАШИНЫ внутри группы (ManagedInstance.Status). Их много, и все они
// говорят разное: «работает» и «работает, но устарела» — не одно и то же.
const INSTANCE_STATUS_RU = {
  CREATING_INSTANCE: "создаётся",
  UPDATING_INSTANCE: "обновляется",
  DELETING_INSTANCE: "удаляется",
  STARTING_INSTANCE: "запускается",
  STOPPING_INSTANCE: "останавливается",
  AWAITING_STARTUP_DURATION: "ждёт готовности",
  CHECKING_HEALTH: "проверка здоровья",
  OPENING_TRAFFIC: "открывает трафик",
  AWAITING_WARMUP_DURATION: "прогрев",
  CLOSING_TRAFFIC: "закрывает трафик",
  RUNNING_ACTUAL: "работает",
  RUNNING_OUTDATED: "работает, конфигурация устарела — будет пересоздана",
  STOPPED: "остановлена",
  DELETED: "удалена",
  PREPARING_RESOURCES: "готовит ресурсы",
};

const NAME_RE = /^[a-z][-a-z0-9_]{0,61}[a-z0-9]$/;

function one(v) {
  return String(v == null ? "" : v).trim();
}

function checkName(name) {
  const n = one(name);
  if (!n) throw new Error("Не указано имя группы.");
  if (!NAME_RE.test(n)) {
    throw new Error(
      "Имя «" + n + "» облако не примет: строчные латинские буквы, цифры, дефис и подчёркивание, начинается с буквы, длина 1–63."
    );
  }
  return n;
}

function checkFolder(folderId) {
  const f = one(folderId);
  if (!f) throw new Error("Не выбран каталог (folderId) — группы машин живут в каталоге.");
  return f;
}

// Память и диск облако присылает БАЙТАМИ строками («2147483648»).
function humanBytes(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return "";
  const gb = n / 1073741824;
  if (gb >= 1) return Math.round(gb * 10) / 10 + " ГБ";
  return Math.round(n / 1048576) + " МБ";
}

function humanUptime(fromIso) {
  const t = Date.parse(String(fromIso || ""));
  if (!isFinite(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "меньше минуты";
  if (min < 60) return min + " мин";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " ч";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " дн";
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + " мес";
  return Math.floor(mo / 12) + " г";
}

function statusHuman(status) {
  return STATUS_RU[one(status).toUpperCase()] || one(status);
}

function instanceStatusHuman(status) {
  return INSTANCE_STATUS_RU[one(status).toUpperCase()] || one(status);
}

function isActive(status) {
  return one(status).toUpperCase() === "ACTIVE";
}

// «Занята» — идёт переход: питание и удаление в это время облако отклонит.
function isBusy(status) {
  const s = one(status).toUpperCase();
  return s === "STARTING" || s === "STOPPING" || s === "DELETING";
}

// Размер группы: у fixedScale это size, у autoScale — границы. Считаем одно
// место, чтобы список, карточка и предупреждения говорили одно и то же.
function scaleOf(scalePolicy) {
  const sp = scalePolicy || {};
  if (sp.fixedScale && sp.fixedScale.size != null) {
    return { kind: "fixed", size: Number(sp.fixedScale.size) || 0, label: String(Number(sp.fixedScale.size) || 0) + " машин(ы)" };
  }
  if (sp.autoScale) {
    const a = sp.autoScale;
    return {
      kind: "auto",
      min: Number(a.minZoneSize) || 0,
      max: Number(a.maxSize) || 0,
      label: "автомасштабирование: от " + (Number(a.minZoneSize) || 0) + " до " + (Number(a.maxSize) || 0) + " машин на зону",
    };
  }
  return { kind: "", size: 0, label: "размер не задан" };
}

function templateInfo(t) {
  const o = t || {};
  const res = o.resourcesSpec || {};
  const disk = (o.bootDiskSpec && o.bootDiskSpec.diskSpec) || {};
  const ifaces = Array.isArray(o.networkInterfaceSpecs) ? o.networkInterfaceSpecs : [];
  const first = ifaces[0] || {};
  const nat = first.primaryV4AddressSpec && first.primaryV4AddressSpec.oneToOneNatSpec;
  return {
    platformId: one(o.platformId) || PLATFORM_DEFAULT,
    cores: one(res.cores),
    coreFraction: one(res.coreFraction),
    memoryBytes: Number(res.memory) || 0,
    memoryHuman: humanBytes(res.memory),
    diskBytes: Number(disk.size) || 0,
    diskHuman: humanBytes(disk.size),
    diskTypeId: one(disk.typeId),
    imageId: one(disk.imageId),
    networkId: one(first.networkId),
    subnetIds: Array.isArray(first.subnetIds) ? first.subnetIds : [],
    securityGroupIds: Array.isArray(first.securityGroupIds) ? first.securityGroupIds : [],
    hasPublicIp: !!nat,
    preemptible: !!(o.schedulingPolicy && o.schedulingPolicy.preemptible),
    serviceAccountId: one(o.serviceAccountId),
  };
}

function groupInfo(g) {
  const o = g || {};
  const t = templateInfo(o.instanceTemplate);
  const zones = ((o.allocationPolicy && o.allocationPolicy.zones) || []).map((z) => one(z && z.zoneId)).filter(Boolean);
  const scale = scaleOf(o.scalePolicy);
  const st = o.managedInstancesState || {};
  const lb = o.loadBalancerState || {};
  const alb = o.applicationLoadBalancerState || {};
  return {
    id: one(o.id),
    name: one(o.name),
    folderId: one(o.folderId),
    description: one(o.description),
    createdAt: one(o.createdAt),
    age: humanUptime(o.createdAt),
    status: one(o.status),
    statusHuman: statusHuman(o.status),
    active: isActive(o.status),
    busy: isBusy(o.status),
    paused: one(o.status).toUpperCase() === "PAUSED",
    deletionProtection: o.deletionProtection === true,
    serviceAccountId: one(o.serviceAccountId),
    scale: scale,
    zones: zones,
    targetGroupId: one(lb.targetGroupId),
    appTargetGroupId: one(alb.targetGroupId),
    targetSize: Number(st.targetSize) || 0,
    runningActual: Number(st.runningActualCount) || 0,
    runningOutdated: Number(st.runningOutdatedCount) || 0,
    processing: Number(st.processingCount) || 0,
    template: t,
    healthChecks: ((o.healthChecksSpec && o.healthChecksSpec.healthCheckSpecs) || []).length,
  };
}

// Строка группы для списка и ответов инструментов: одна на всех.
function groupLine(g) {
  const bits = [];
  bits.push((g.active ? "● " : "○ ") + g.name);
  bits.push(g.statusHuman || "—");
  bits.push(g.scale.label);
  if (g.runningActual || g.targetSize) {
    bits.push("машин " + g.runningActual + "/" + g.targetSize + (g.runningOutdated ? " (устаревших " + g.runningOutdated + ")" : ""));
  }
  if (g.template.cores) bits.push(g.template.cores + " vCPU" + (g.template.coreFraction && g.template.coreFraction !== "100" ? " (" + g.template.coreFraction + "%)" : "") + (g.template.memoryHuman ? ", " + g.template.memoryHuman : ""));
  if (g.zones.length) bits.push("зоны: " + g.zones.join(", "));
  if (g.template.preemptible) bits.push("прерываемые");
  if (g.deletionProtection) bits.push("защита от удаления");
  if (g.age) bits.push("возраст " + g.age);
  return bits.join(" · ") + (g.id ? "\n    id " + g.id : "");
}

// Строка машины. Читает ОБА вида ответа: сырой (networkInterfaces) и уже
// разобранный модулем (internalIp/externalIp) — instances() отдаёт плоские поля,
// и без этого публичный адрес пропадал бы в списке машин группы.
function instanceLine(i) {
  const o = i || {};
  const iface = (o.networkInterfaces || [])[0] || {};
  const addr = (iface.primaryV4Address || {});
  const pub = one(o.externalIp) || (addr.oneToOneNat && addr.oneToOneNat.address);
  const inner = one(o.internalIp) || addr.address;
  return (
    "• " + (o.name || o.fqdn || o.id) + " — " + instanceStatusHuman(o.status) +
    (o.zoneId ? ", " + o.zoneId : "") +
    (inner ? ", внутренний " + inner : "") +
    (pub ? ", публичный " + pub : "") +
    (o.statusMessage ? " · " + o.statusMessage : "")
  );
}

function createYcIg(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError =
    typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("Instance Groups: модулю не переданы помощники облака (fetchJson, getIamToken).");
    }
  }

  async function baseOf(serviceId, fallback) {
    const b = typeof api.endpoint === "function" ? await api.endpoint(serviceId) : "";
    return b || fallback;
  }

  async function call(oauthToken, serviceId, fallback, method, path, body, timeoutMs) {
    requireApi();
    const base = await baseOf(serviceId, fallback);
    const token = await api.getIamToken(oauthToken);
    const headers = { Authorization: "Bearer " + token };
    const opts = { method: method, headers: headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    try {
      return await api.fetchJson(base + path, opts, timeoutMs || 30000);
    } catch (e) {
      const err = new Error(serviceError(e, base, path));
      err.status = e && e.status;
      throw err;
    }
  }

  function compute(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "compute", IG_HOST, method, path, body, timeoutMs);
  }

  // Ожидание операции: у создания группы id приходит только в ответе операции,
  // поэтому тело операции возвращается целиком (та же тонкость, что у машин).
  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 240000);
    return op || {};
  }

  // ── Чтение ────────────────────────────────────────────────────────────────
  async function groups(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await compute(
      oauthToken,
      "GET",
      "/compute/v1/instanceGroups?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.instanceGroups) ? j.instanceGroups : []).map(groupInfo);
  }

  async function group(oauthToken, id) {
    const gid = one(id);
    if (!gid) throw new Error("Не указан id группы.");
    return groupInfo(await compute(oauthToken, "GET", "/compute/v1/instanceGroups/" + encodeURIComponent(gid), undefined, 25000));
  }

  async function findGroup(oauthToken, folderId, ref) {
    const list = await groups(oauthToken, folderId);
    const q = one(ref);
    const got = list.find((g) => g.id === q) || list.find((g) => g.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  async function instances(oauthToken, id) {
    const gid = one(id);
    if (!gid) throw new Error("Не указан id группы.");
    const j = await compute(
      oauthToken,
      "GET",
      "/compute/v1/instanceGroups/" + encodeURIComponent(gid) + "/instances?pageSize=1000",
      undefined,
      25000
    );
    const raw = Array.isArray(j && j.instances) ? j.instances : [];
    return raw.map((i) => {
      const iface = (i && i.networkInterfaces && i.networkInterfaces[0]) || {};
      const addr = iface.primaryV4Address || {};
      return {
        id: one(i && i.id),
        instanceId: one(i && i.instanceId),
        name: one(i && i.name),
        fqdn: one(i && i.fqdn),
        status: one(i && i.status),
        statusHuman: instanceStatusHuman(i && i.status),
        statusMessage: one(i && i.statusMessage),
        zoneId: one(i && i.zoneId),
        internalIp: one(addr.address),
        externalIp: one(addr.oneToOneNat && addr.oneToOneNat.address),
        subnetId: one(iface.subnetId),
        statusChangedAt: one(i && i.statusChangedAt),
      };
    });
  }

  async function operations(oauthToken, id) {
    const gid = one(id);
    if (!gid) throw new Error("Не указан id группы.");
    const j = await compute(
      oauthToken,
      "GET",
      "/compute/v1/instanceGroups/" + encodeURIComponent(gid) + "/operations?pageSize=100",
      undefined,
      25000
    );
    return (Array.isArray(j && j.operations) ? j.operations : []).map((o) => ({
      id: one(o && o.id),
      description: one(o && o.description),
      createdBy: one(o && o.createdBy),
      createdAt: one(o && o.createdAt),
      done: !!(o && o.done),
      hasError: !!(o && o.error),
    }));
  }

  // Карточка одним вызовом: сама группа + её машины + последние операции. Так
  // окну не приходится делать три запроса, чтобы показать одну карточку.
  async function card(oauthToken, folderId, ref) {
    const g = await findGroup(oauthToken, folderId, ref);
    if (!g) return null;
    const [machines, ops] = await Promise.all([
      instances(oauthToken, g.id).catch(() => []),
      operations(oauthToken, g.id).catch(() => []),
    ]);
    return { group: g, instances: machines, operations: ops };
  }

  // ── Создание группы ───────────────────────────────────────────────────────
  async function create(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const name = checkName(o.name);

    // Подсеть: имя или id. Группа стоит в зоне подсети, а сеть берётся из неё же.
    const subnets = await call(oauthToken, "vpc", "https://vpc.api.cloud.yandex.net", "GET",
      "/vpc/v1/subnets?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
    const list = Array.isArray(subnets && subnets.subnets) ? subnets.subnets : [];
    const want = one(o.subnet || o.subnetId);
    let subnet = null;
    if (want) {
      subnet = list.find((s) => s.id === want) || list.find((s) => s.name === want) || null;
      if (!subnet) {
        throw new Error(
          "Не нашёл подсеть «" + want + "»." +
            (list.length ? " В каталоге: " + list.map((s) => s.name + " (" + s.zoneId + ")").join(", ") : " Подсетей нет — создай: ycVpc { action: \"addsubnet\", ... }.")
        );
      }
    } else if (list.length === 1) {
      subnet = list[0];
    } else {
      throw new Error(
        "Группа без подсети не встанет: укажи subnet (имя или id)." +
          (list.length ? " В каталоге: " + list.map((s) => s.name + " (" + s.zoneId + ")").join(", ") + "." : " Подсетей нет — создай: ycVpc { action: \"addsubnet\", ... }.")
      );
    }
    const zoneId = one(o.zone || o.zoneId) || one(subnet.zoneId) || ZONE_DEFAULT;
    if (subnet.zoneId && zoneId !== subnet.zoneId) {
      throw new Error(
        "Зона группы (" + zoneId + ") и зона подсети «" + subnet.name + "» (" + subnet.zoneId + ") разные. Группа подключается к подсети СВОЕЙ зоны — укажи подсеть в зоне " + zoneId + "."
      );
    }

    // Размер: сколько машин держать. Это и есть цена группы (машины платят за час).
    const size = Number(o.size != null ? o.size : 2);
    if (!isFinite(size) || size < 1 || size > 100) {
      throw new Error("size — это число машин в группе, целое от 1 до 100 (дано: " + o.size + ").");
    }

    const cores = one(o.cores) || String(CORES_DEFAULT);
    const memoryGb = Number(o.memoryGb != null ? o.memoryGb : MEMORY_GB_DEFAULT);
    if (!isFinite(memoryGb) || memoryGb < 1) {
      throw new Error("memoryGb — память одной машины в ГБ, больше нуля (дано: " + o.memoryGb + ").");
    }
    const coreFraction = one(o.coreFraction) || String(CORE_FRACTION_DEFAULT);
    const platformId = one(o.platformId || o.platform) || PLATFORM_DEFAULT;
    const diskGb = Number(o.diskSizeGb != null ? o.diskSizeGb : o.diskGb != null ? o.diskGb : DISK_GB_DEFAULT);
    if (!isFinite(diskGb) || diskGb < 4) {
      throw new Error("diskSizeGb — размер диска одной машины в ГБ, минимум 4 (дано: " + o.diskSizeGb + ").");
    }
    const diskTypeId = one(o.diskTypeId || o.diskType) || DISK_TYPE_DEFAULT;

    // Образ: id или семейство (ubuntu-2204-lts и т. п.). Публичные образы лежат
    // в служебном каталоге standard-images — как у машин (yc-compute.js).
    const imageFamily = one(o.imageFamily || o.image);
    let imageId = one(o.imageId);
    if (!imageId) {
      const fam = imageFamily || IMAGE_FAMILY_DEFAULT;
      const im = await compute(
        oauthToken,
        "GET",
        "/compute/v1/images:latestByFamily?folderId=standard-images&family=" + encodeURIComponent(fam),
        undefined,
        25000
      );
      imageId = one(im && im.id);
      if (!imageId) throw new Error("Не нашёл образ семейства «" + fam + "». Проверь имя (например ubuntu-2204-lts) или укажи imageId.");
    }

    // Группы безопасности: если их не задать, останется группа по умолчанию
    // сети, а она закрывает вход снаружи — SSH не откроется. Поэтому об этом
    // честно говорится в предупреждениях.
    const wanted = [].concat(o.securityGroupIds || o.securityGroups || o.sg || []).map(one).filter(Boolean);
    let securityGroupIds = [];
    if (wanted.length) {
      const groupsRes = await call(oauthToken, "vpc", "https://vpc.api.cloud.yandex.net", "GET",
        "/vpc/v1/securityGroups?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
      const sgs = Array.isArray(groupsRes && groupsRes.securityGroups) ? groupsRes.securityGroups : [];
      for (const w of wanted) {
        const g = sgs.find((x) => x.id === w) || sgs.find((x) => x.name === w);
        if (!g) {
          throw new Error("Не нашёл группу безопасности «" + w + "»." + (sgs.length ? " В каталоге: " + sgs.map((x) => x.name).join(", ") : " Групп нет — создай: ycVpc { action: \"addgroup\", ... }."));
        }
        securityGroupIds.push(g.id);
      }
    }

    const metadata = {};
    for (const k of Object.keys(o.metadata || {})) metadata[k] = String(o.metadata[k]);
    const sshKey = one(o.sshPublicKey || o.publicKey);
    if (sshKey) metadata["ssh-keys"] = one(o.sshUser) ? one(o.sshUser) + ":" + sshKey : sshKey;
    metadata["serial-port-enable"] = "1";

    const iface = {
      networkId: one(subnet.networkId),
      subnetIds: [subnet.id],
      primaryV4AddressSpec: {},
    };
    if (o.publicIp === true) iface.primaryV4AddressSpec.oneToOneNatSpec = { ipVersion: "IPV4" };
    if (securityGroupIds.length) iface.securityGroupIds = securityGroupIds;

    const body = {
      folderId: folderId,
      name: name,
      description: one(o.description),
      instanceTemplate: {
        platformId: platformId,
        resourcesSpec: {
          cores: cores,
          memory: String(Math.round(memoryGb * 1073741824)),
          coreFraction: coreFraction,
        },
        bootDiskSpec: { diskSpec: { typeId: diskTypeId, size: String(Math.round(diskGb * 1073741824)), imageId: imageId } },
        networkInterfaceSpecs: [iface],
        metadata: metadata,
      },
      scalePolicy: { fixedScale: { size: String(Math.round(size)) } },
      deployPolicy: { maxUnavailable: "1", maxDeleting: "1", maxCreating: "1", maxExpansion: "1", startupDuration: STARTUP_DURATION },
      allocationPolicy: { zones: [{ zoneId: zoneId }] },
    };
    if (o.preemptible === true) body.instanceTemplate.schedulingPolicy = { preemptible: true };
    if (one(o.serviceAccountId)) body.serviceAccountId = one(o.serviceAccountId);
    if (o.deletionProtection === true) body.deletionProtection = true;

    const j = await compute(oauthToken, "POST", "/compute/v1/instanceGroups", body, 40000);
    const op = await run(oauthToken, j, 240000);
    const gid =
      one(op && op.response && (op.response.instanceGroupId || op.response.id)) ||
      one(op && op.metadata && op.metadata.instanceGroupId) ||
      "";
    const created = gid
      ? await group(oauthToken, gid).catch(() => null)
      : await findGroup(oauthToken, folderId, name).catch(() => null);

    const warnings = [
      "Группа НЕ бесплатна: каждая её машина платит как обычная машина Compute Cloud — за каждый час работы (ориентир: ycCosts { service: \"compute\" }). Группа создаёт и пересоздаёт машины САМА: удалённая руками машина вернётся.",
      "Группа стоит в одной зоне (" + zoneId + "). Машины получат публичный адрес" + (o.publicIp === true ? "" : " только если он запрошен") + "; если адрес не запрошен, войти можно через машину-бастион или изнутри сети.",
    ];
    if (!securityGroupIds.length) {
      warnings.push("Группы безопасности не заданы — останется группа по умолчанию сети, а она закрывает вход снаружи: SSH откроется только с разрешённых адресов (ycVpc: addrule).");
    }
    return {
      group: created,
      groupId: (created && created.id) || gid,
      operationId: one(j && j.id),
      message:
        "Группа «" + name + "» создаётся: машин " + Math.round(size) + ", " + cores + " vCPU и " + memoryGb + " ГБ на машину, зона " + zoneId + "." +
        (created ? " Состояние: " + created.statusHuman + "." : ""),
      warnings: warnings,
    };
  }

  // ── Питание группы ────────────────────────────────────────────────────────
  async function power(oauthToken, action, ref, o) {
    const opt = o || {};
    const act = one(action).toLowerCase();
    if (["start", "stop"].indexOf(act) < 0) {
      throw new Error("Питание группы: неизвестное действие «" + action + "». Доступно: start, stop.");
    }
    const g = ref && ref.id ? ref : await findGroup(oauthToken, opt.folderId, ref);
    if (!g) throw new Error("Не нашёл группу «" + one(ref) + "»." + (opt.folderId ? " Список — действие list." : ""));
    if (act === "start" && g.active) return { changed: false, group: g, message: "Группа «" + g.name + "» уже работает." };
    if (act === "stop" && one(g.status).toUpperCase() === "STOPPED") return { changed: false, group: g, message: "Группа «" + g.name + "» уже остановлена." };
    if (g.busy) throw new Error("Группа «" + g.name + "» сейчас занята: " + g.statusHuman + ". Дождись окончания и повтори.");
    const j = await compute(oauthToken, "POST", "/compute/v1/instanceGroups/" + encodeURIComponent(g.id) + ":" + act, undefined, 40000);
    await run(oauthToken, j, 240000);
    const after = await group(oauthToken, g.id).catch(() => null);
    const now = after || g;
    const warnings = [];
    if (act === "start") {
      warnings.push("Заработавшие машины платят за каждый час работы — останови группу, когда она не нужна (действие stop).");
    } else {
      warnings.push("Остановка экономит деньги за вычисления, но диски машин тарифицируются и у остановленной группы.");
    }
    return {
      changed: true,
      action: act,
      group: now,
      message:
        (act === "start" ? "Группа «" + now.name + "» запускается" : "Группа «" + now.name + "» останавливается") +
        (after ? ", состояние: " + after.statusHuman : "") + ".",
      warnings: warnings,
    };
  }

  // ── Удаление группы ───────────────────────────────────────────────────────
  // Удаление группы забирает все её машины и их диски — это необратимо, и
  // модуль об этом говорит ДО того, как облако что-то сделает.
  async function remove(oauthToken, opts) {
    const o = opts || {};
    const g = o.group && o.group.id ? o.group : await findGroup(oauthToken, o.folderId, o.group || o.id || o.name);
    if (!g) throw new Error("Не нашёл группу «" + one(o.group || o.id || o.name) + "».");
    if (g.deletionProtection) {
      throw new Error(
        "У группы «" + g.name + "» стоит защита от удаления (deletionProtection). Снять её можно в консоли Yandex Cloud или обновлением группы — удаление отсюда облако отклонит."
      );
    }
    const j = await compute(oauthToken, "DELETE", "/compute/v1/instanceGroups/" + encodeURIComponent(g.id), undefined, 40000);
    await run(oauthToken, j, 240000);
    return {
      changed: true,
      groupId: g.id,
      machines: g.targetSize || g.runningActual || 0,
      message:
        "Группа «" + g.name + "» удаляется вместе с машинами" + (g.targetSize ? " (" + g.targetSize + " шт.)" : "") +
        " и их дисками — отменить нельзя.",
      warnings: ["Диски машин удаляются вместе с группой: если данные нужны — сними снимки заранее (ycCompute: snapshot) — или останови группу вместо удаления."],
    };
  }

  return {
    groups: groups,
    group: group,
    findGroup: findGroup,
    card: card,
    instances: instances,
    operations: operations,
    create: create,
    power: power,
    remove: remove,
  groupLine: groupLine,
  instanceLine: instanceLine,
  scaleOf: scaleOf,
  statusHuman: statusHuman,
    instanceStatusHuman: instanceStatusHuman,
  };
}

module.exports = {
  createYcIg: createYcIg,
  IG_HOST: IG_HOST,
  PLATFORM_DEFAULT: PLATFORM_DEFAULT,
  IMAGE_FAMILY_DEFAULT: IMAGE_FAMILY_DEFAULT,
  DISK_TYPE_DEFAULT: DISK_TYPE_DEFAULT,
  ZONE_DEFAULT: ZONE_DEFAULT,
  groupInfo: groupInfo,
  instanceLine: instanceLine,
  groupLine: groupLine,
  scaleOf: scaleOf,
};

"use strict";

/* ─── Служебный слой Yandex Cloud: настройки, контейнеры, логи, yc CLI ────────
   Зачем модуль. Знание про Yandex Cloud жило в main.js вперемешку с агентскими
   инструментами, IPC-обработчиками и деплоем: файл дорос до 470 КБ, и новую
   логику приходилось вставлять вслепую. Здесь собрана РОВНО та часть, что
   говорит с Yandex Cloud, и ничего больше: ни окна, ни IPC, ни агента.

   Конвенция та же, что у createDeployEngine: модуль чистый, зависимости приходят
   аргументами. Это даёт две вещи — файл тестируется в plain-node без Electron и
   падение в облачном коде больше не требует чтения 8 тысяч строк.

   Что внутри:
   - ycConfig()          — рабочая конфигурация из настроек (токен, каталог, права);
   - ycRequireAuth()     — одна проверка «авторизация есть» с понятной ошибкой;
   - ycFindContainerByRef / ycActiveRevision / ycRevisionLine / ycRevisionDetails
                         — контейнер и его ревизии так, как их видно в консоли;
   - ycJsonArg()         — аргументы модели строкой «{"A":"1"}» или объектом;
   - readYcLogsText()    — Cloud Logging внутренним API (внешний yc CLI не нужен);
   - ycCliStatus/ycCliInstall — встроенный yc CLI внутри папки приложения.

   Ничего не создаёт и не меняет по своей инициативе: модуль только читает и
   готовит данные. Решения о создании ресурсов принимает вызывающий. */

function createYcService(deps) {
  const { app, path, net, secrets, yandexCloud, ycCli, ycLogs, ycEnsurePath, loadSettings } = deps;

// ─────────────────────────── Yandex Cloud (REST API) ───────────────────────────
// Ссылка для получения OAuth-токена (клиентское приложение Yandex Cloud — как у yc CLI):
const YANDEX_OAUTH_URL =
  "https://oauth.yandex.ru/authorize?response_type=token&client_id=1a6990aa636648e9b2ef855fa7bec2fb";

function ycConfig(s) {
  s = s || loadSettings();
  return {
    oauth: String(s.yandexOauthToken || "").trim(),
    cloudId: String(s.ycCloudId || "").trim(),
    folderId: String(s.ycFolderId || "").trim(),
    folderName: String(s.ycFolderName || "").trim(),
    allowCreate: !!s.ycAllowAgentCreate,
    allowDelete: !!s.ycAllowAgentDelete,
    allowUpdate: !!s.ycAllowAgentUpdate,
    allowPublic: !!s.ycAllowAgentPublic,
  };
}

// Строка про Yandex Cloud для САММАРИ ПРОЕКТА: агент всегда видит АКТУАЛЬНЫЙ каталог
// и разрешения, а не полагается на устаревшие результаты инструментов в истории
// переписки («каталог не выбран», хотя он уже выбран). Вынесено из оболочки
// (этап B, заход 3): рядом с ycConfig, поэтому передача настроек значением отпала.
// Витрина проекта (src/project-brief.js) берёт её через отложенную стрелку: сервис
// собирается ПОЗЖЕ неё, и к моменту вызова имя уже есть.
function ycBriefLine(s) {
  try {
    const cfg = ycConfig(s);
    if (!cfg.oauth) return "";
    if (!cfg.folderId) return "Yandex Cloud: подключён, каталог НЕ выбран — попроси пользователя выбрать каталог в Настройках → «☁️ Yandex Cloud».";
    return (
      "Yandex Cloud: каталог «" + (cfg.folderName || cfg.folderId) + "» (" + cfg.folderId + ")" +
      (cfg.cloudId ? ", облако " + cfg.cloudId : "") +
      "; создание ресурсов агентом " + (cfg.allowCreate ? "разрешено" : "ЗАПРЕЩЕНО") +
      ", удаление " + (cfg.allowDelete ? "разрешено" : "ЗАПРЕЩЕНО") + ". "
    );
  } catch {
    return "";
  }
}

// Ключ сервиса → тип ресурса Cloud Logging (нужен только как фильтр; по id точнее).
const YC_RESOURCE_TYPES = {
  apiGateway: "serverless.apigateway",
  certificateManager: "certificate-manager.certificate",
  cdn: "cdn.resource",
  dns: "dns.zone",
  iam: "iam.serviceAccount",
  lockbox: "lockbox.secret",
  logging: "logging.logGroup",
  containerRegistry: "container-registry.registry",
  storage: "storage.bucket",
  serverlessContainers: "serverless.container",
  vpc: "vpc.network",
  ydb: "ydb.database",
};

// Чтение логов Cloud Logging ВНУТРЕННИМ API приложения — внешний yc CLI не нужен.
// Лог-группы перечисляются по REST, записи читаются по gRPC: у LogReadingService
// нет HTTP-привязки, поэтому «POST /logging/v1/logs/read» не существует.
// ── Serverless Containers: обзор, редактор и ревизии для агента ──────────────
// Контейнер ищется по имени (точное совпадение) или по id — как в консоли.
async function ycFindContainerByRef(cfg, ref) {
  const q = String(ref || "").trim();
  if (!q) throw new Error("укажи имя или id контейнера (список: ycList(service: \"serverlessContainers\")).");
  if (cfg.folderId) {
    try {
      const byName = await yandexCloud.findContainer(cfg.oauth, cfg.folderId, q);
      if (byName) return byName;
    } catch {}
  }
  return await yandexCloud.getContainer(cfg.oauth, q);
}

// Активная ревизия = та, что сейчас обслуживает трафик. Именно из неё консоль
// (и мы) берём префилл для «Создать ревизию».
async function ycActiveRevision(cfg, containerId) {
  const revs = await yandexCloud.listRevisions(cfg.oauth, { containerId, pageSize: 100 });
  const active = revs.find((r) => r.status === "ACTIVE") || revs[0] || null;
  return { revs, active };
}

// Аргументы вида "{\"A\":\"1\"}" приходят от модели строкой так же часто, как
// объектом — принимаем оба вида, но не падаем на мусоре.
function ycJsonArg(v) {
  if (v == null) return undefined;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return undefined;
    try {
      const j = JSON.parse(t);
      return j && typeof j === "object" ? j : undefined;
    } catch (e) {
      return undefined;
    }
  }
  return undefined;
}

// Одна строка списка ревизий: id, статус, дата, образ, ресурсы.
function ycRevisionLine(s, isCurrent) {
  const bits = [];
  bits.push(isCurrent ? "★ активна" : s.status || "—");
  bits.push(s.createdAt ? String(s.createdAt).replace("T", " ").slice(0, 19) : "—");
  bits.push(s.image || "—");
  const res = [];
  if (s.memoryMb) res.push(s.memoryMb + " МБ");
  if (s.cores) res.push(s.cores + (s.cores > 1 ? " ядра" : " ядро"));
  if (res.length) bits.push(res.join(" / "));
  bits.push("таймаут " + (s.timeoutSec || 30) + " с");
  if (s.concurrency) bits.push("конкурентность " + s.concurrency);
  return "• " + s.id + " — " + bits.join(" · ");
}

// Полные настройки ревизии — то, что в консоли видно во вкладке «Редактор».
function ycRevisionDetails(s) {
  const lines = [];
  lines.push("Ревизия " + s.id + " — " + (s.status || "—") + (s.createdAt ? " · создана " + s.createdAt : ""));
  if (s.description) lines.push("Описание: " + s.description);
  lines.push("Образ: " + (s.image || "—"));
  if (s.imageDigest) lines.push("Дайджест образа: " + s.imageDigest);
  if (s.command.length) lines.push("ENTRYPOINT: " + s.command.join(" "));
  if (s.args.length) lines.push("CMD: " + s.args.join(" "));
  if (s.workingDir) lines.push("Рабочая папка: " + s.workingDir);
  const res = [];
  if (s.memoryMb) res.push(s.memoryMb + " МБ памяти");
  if (s.cores) res.push(s.cores + " ядро(а)");
  if (s.coreFraction) res.push("доля ядра " + s.coreFraction + "%");
  lines.push("Ресурсы: " + (res.length ? res.join(", ") : "—"));
  lines.push("Таймаут: " + (s.timeoutSec || 30) + " с" + (s.concurrency ? " · конкурентность " + s.concurrency : ""));
  lines.push("Сервисный аккаунт: " + (s.serviceAccountId || "— (нет)"));
  lines.push("Сеть: " + (s.networkId || "— (нет доступа в VPC)"));
  lines.push("Мин. инстансов: " + (s.minInstances || 0) + (s.maxInstancesPerZone ? " · лимит инстансов на зону: " + s.maxInstancesPerZone : ""));
  lines.push("Режим: " + (s.runtime === "task" ? "task (процесс на каждый запрос)" : "http (сервер внутри контейнера)"));
  const envKeys = Object.keys(s.env || {});
  lines.push("Переменные окружения (" + envKeys.length + "): " + (envKeys.length ? envKeys.join(", ") : "нет"));
  if (s.secrets.length) {
    lines.push("Секреты Lockbox (" + s.secrets.length + "): " + s.secrets.map((x) => (x.environmentVariable || "?") + " ← " + x.id + "/" + x.key).join(", "));
  }
  if (s.storageMounts.length) {
    lines.push("Монтирования Object Storage: " + s.storageMounts.map((m) => m.bucketId + (m.prefix ? "/" + m.prefix : "") + " → " + m.path + (m.readOnly ? " (только чтение)" : "")).join(", "));
  }
  if (s.mounts.length) {
    lines.push("Дополнительные диски: " + s.mounts.map((m) => (m.bucketId || "диск") + " → " + m.path + (m.mode ? " (" + m.mode + ")" : "")).join(", "));
  }
  lines.push("Логи: " + (s.logDisabled ? "выключены" : s.logGroupId ? "лог-группа " + s.logGroupId : "в группу каталога") + (s.logMinLevel ? ", уровень " + s.logMinLevel : ""));
  return lines.join("\n");
}

async function readYcLogsText(cfg, serviceKey, resourceId, args) {
  const a = args || {};
  if (!cfg.folderId) throw new Error("не выбран каталог (Настройки → Yandex Cloud).");
  const iam = await yandexCloud.getIamToken(cfg.oauth);
  // REST-список групп и gRPC-чтение живут на РАЗНЫХ хостах: logGroups — на
  // logging.api.cloud.yandex.net, а LogReadingService.Read — только на
  // reader.logging.yandexcloud.net (см. yc-logs.js и KNOWN_ENDPOINTS).
  const base = (await yandexCloud.endpoint("logging")) || "https://logging.api.cloud.yandex.net";
  const grpcBase = (await yandexCloud.endpoint("log-reading")) || "https://reader.logging.yandexcloud.net";
  const limit = Math.max(1, Math.min(parseInt(a.limit, 10) || 100, 500));
  const sinceHours = Math.max(1, Math.min(parseInt(a.sinceHours, 10) || 3, 168));
  const type = YC_RESOURCE_TYPES[serviceKey] || (a.type ? String(a.type) : "");
  const res = await ycLogs.readLogs({
    iamToken: iam,
    baseUrl: base,
    grpcBaseUrl: grpcBase,
    folderId: cfg.folderId,
    resourceIds: resourceId ? [resourceId] : [],
    resourceTypes: type ? [type] : [],
    sinceHours,
    limit,
    logGroupId: a.logGroupId ? String(a.logGroupId) : "",
    filter: a.filter ? String(a.filter) : "",
  });
  const entries = res.entries || [];
  const group = res.logGroupName || res.logGroupId || "—";
  if (!entries.length) {
    return "Логов за последние " + sinceHours + " ч нет (лог-группа «" + group + "»" + (resourceId ? ", ресурс " + resourceId : "") + ").";
  }
  return "Логи за последние " + sinceHours + " ч — " + entries.length + " записей, группа «" + group + "»:\n" + ycLogs.formatEntries(entries, { max: 50 }).join("\n");
}

// Встроенный yc CLI: он лежит в папке приложения, системных прав не требует.
function ycCliStatus() {
  const userData = app.getPath("userData");
  const p = ycCli.installed(userData);
  return { installed: !!p, path: p || "", dir: ycCli.binDir(userData) };
}

async function ycCliInstall() {
  const r = await ycCli.install({ userData: app.getPath("userData") });
  if (r && r.ok) ycEnsurePath();
  return r;
}

function ycRequireAuth(cfg) {
  if (!cfg || !cfg.oauth) {
    const e = new Error("Не выполнена авторизация Yandex Cloud. Открой Настройки → «☁️ Yandex Cloud», получи OAuth-токен и вставь его.");
    e.status = 401;
    throw e;
  }
}

  return {
    YANDEX_OAUTH_URL,
    YC_RESOURCE_TYPES,
    ycConfig,
    ycBriefLine,
    ycRequireAuth,
    ycFindContainerByRef,
    ycActiveRevision,
    ycJsonArg,
    ycRevisionLine,
    ycRevisionDetails,
    readYcLogsText,
    ycCliStatus,
    ycCliInstall,
  };
}

module.exports = { createYcService };

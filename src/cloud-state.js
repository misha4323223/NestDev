"use strict";
// Состояние облака проекта: папка .cloud/ рядом с кодом.
//
//   .cloud/project.json        — какой это проект, провайдер, каталог, имена ресурсов
//   .cloud/infrastructure.json — созданные ресурсы (реестр, контейнер, SA, домен)
//   .cloud/deployments.json    — история деплоев с стадиями, проверкой и ревизией
//
// Зачем: без этого агент после перезапуска приложения не знает, что уже создано,
// какую ревизию запустили и на что откатываться. Записи атомарные (tmp + rename),
// битый JSON не роняет деплой, а откладывается в .bak и состояние начинается заново.
//
// Секреты здесь не хранятся: только ключи переменных, без значений.

const fs = require("fs");
const path = require("path");

const STATE_DIR = ".cloud";
const HISTORY_LIMIT = 50;

function stateDir(projectDir) {
  return path.join(String(projectDir || ""), STATE_DIR);
}

function fileOf(projectDir, name) {
  return path.join(stateDir(projectDir), name);
}

// Атомарная запись: сначала временный файл, потом подмена. Так не бывает
// половинчатого JSON, если приложение закрыли посреди записи.
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { data: fallback, issue: "" };
  }
  try {
    const data = JSON.parse(text);
    return { data, issue: "" };
  } catch {
    // Битый файл не удаляем: сохраняем рядом и сообщаем наверх.
    const bak = file + ".bak-" + Date.now();
    try {
      fs.renameSync(file, bak);
    } catch {}
    return { data: fallback, issue: "Повреждён " + path.basename(file) + " — отложен в " + path.basename(bak) + ", состояние начато заново." };
  }
}

function emptyProject(projectDir) {
  return {
    version: 1,
    provider: "yandex-cloud",
    name: path.basename(path.resolve(String(projectDir || "."))),
    dir: path.resolve(String(projectDir || ".")),
    cloudId: "",
    folderId: "",
    folderName: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function readProject(projectDir) {
  const r = readJsonSafe(fileOf(projectDir, "project.json"), null);
  const base = r.data && typeof r.data === "object" ? r.data : emptyProject(projectDir);
  return { project: Object.assign(emptyProject(projectDir), base), issue: r.issue };
}

function writeProject(projectDir, patch) {
  const cur = readProject(projectDir).project;
  const next = Object.assign({}, cur, patch || {}, { version: 1, updatedAt: Date.now() });
  writeJsonAtomic(fileOf(projectDir, "project.json"), next);
  return next;
}

function readInfrastructure(projectDir) {
  const r = readJsonSafe(fileOf(projectDir, "infrastructure.json"), null);
  const data = r.data && typeof r.data === "object" ? r.data : {};
  return {
    infrastructure: Object.assign({ registry: null, container: null, serviceAccount: null, domain: "", envKeys: [], updatedAt: 0 }, data),
    issue: r.issue,
  };
}

function writeInfrastructure(projectDir, patch) {
  const cur = readInfrastructure(projectDir).infrastructure;
  const next = Object.assign({}, cur, patch || {}, { updatedAt: Date.now() });
  writeJsonAtomic(fileOf(projectDir, "infrastructure.json"), next);
  return next;
}

function readDeployments(projectDir) {
  const r = readJsonSafe(fileOf(projectDir, "deployments.json"), null);
  const data = r.data && typeof r.data === "object" ? r.data : {};
  const items = Array.isArray(data.items) ? data.items : [];
  return { items, issue: r.issue };
}

function writeDeployments(projectDir, items) {
  const trimmed = items.slice(0, HISTORY_LIMIT);
  writeJsonAtomic(fileOf(projectDir, "deployments.json"), { version: 1, items: trimmed, updatedAt: Date.now() });
  return trimmed;
}

// Полное чтение: проект + инфраструктура + история одним вызовом.
function readState(projectDir) {
  const p = readProject(projectDir);
  const i = readInfrastructure(projectDir);
  const d = readDeployments(projectDir);
  const issues = [p.issue, i.issue, d.issue].filter(Boolean);
  const items = d.items;
  const current = items.find((x) => x && x.status === "running") || items[0] || null;
  const last = items.find((x) => x && x.status === "ok") || null;
  return {
    project: p.project,
    infrastructure: i.infrastructure,
    deployments: items,
    current,
    lastHealthy: last,
    issues,
    stateDir: stateDir(projectDir),
  };
}

// Следующий номер деплоя: нумерация как в консоли («Deployment #17»).
function nextNumber(items) {
  let max = 0;
  for (const it of items || []) {
    const n = parseInt((it && it.number) || 0, 10) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

// Запись нового деплоя. Возвращает созданную запись с id и number.
function recordDeployment(projectDir, entry) {
  const { items } = readDeployments(projectDir);
  const e = entry || {};
  const rec = Object.assign(
    {
      id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      number: nextNumber(items),
      status: "running",
      startedAt: Date.now(),
      finishedAt: 0,
      stages: [],
      envKeys: [],
      health: null,
      error: "",
    },
    e,
    { number: e.number || nextNumber(items) }
  );
  writeDeployments(projectDir, [rec].concat(items));
  return rec;
}

// Точечное обновление записи (статус, стадия, проверка, ошибка).
function updateDeployment(projectDir, id, patch) {
  const { items } = readDeployments(projectDir);
  let found = null;
  const next = items.map((it) => {
    if (!it || it.id !== id) return it;
    found = Object.assign({}, it, patch || {});
    return found;
  });
  if (!found) return null;
  writeDeployments(projectDir, next);
  return found;
}

function deploymentHistory(projectDir, limit) {
  const { items } = readDeployments(projectDir);
  return typeof limit === "number" && limit > 0 ? items.slice(0, limit) : items;
}

function deploymentById(projectDir, id) {
  return readDeployments(projectDir).items.find((it) => it && it.id === id) || null;
}

function lastDeployment(projectDir) {
  return readDeployments(projectDir).items[0] || null;
}

// На что откатываться: прошлый успешный деплой, отличный от текущего.
function rollbackTarget(projectDir, currentId) {
  const { items } = readDeployments(projectDir);
  return (
    items.find((it) => it && it.status === "ok" && it.revisionId && it.id !== currentId) ||
    items.find((it) => it && it.status === "ok" && it.revisionId) ||
    null
  );
}

// Конфигурация облака проекта — то, что агент читает вместо догадок.
function toCloudConfig(projectDir) {
  const st = readState(projectDir);
  const inf = st.infrastructure;
  return {
    provider: st.project.provider,
    project: st.project.name,
    dir: st.project.dir,
    folderId: st.project.folderId,
    resources: {
      registry: inf.registry ? inf.registry.id : "",
      container: inf.container ? inf.container.id : "",
      serviceAccount: inf.serviceAccount ? inf.serviceAccount.id : "",
      domain: inf.domain || "",
    },
    envKeys: inf.envKeys || [],
    deployment: st.current
      ? {
          number: st.current.number,
          status: st.current.status,
          url: st.current.url || "",
          image: st.current.image || "",
          revisionId: st.current.revisionId || "",
          environment: st.current.environment || "production",
        }
      : null,
    history: st.deployments.slice(0, 10).map((it) => ({
      number: it.number,
      status: it.status,
      url: it.url || "",
      at: it.startedAt,
      failedStage: (it.stages || []).filter((s) => s.status === "fail").map((s) => s.id)[0] || "",
    })),
  };
}

// Короткая сводка деплоя в одну строку — для чата и тостов.
function summarize(rec) {
  if (!rec) return "";
  const marks = (rec.stages || [])
    .map((s) => (s.status === "ok" ? "✓" : s.status === "fail" ? "✗" : "…") + " " + (s.label || s.id))
    .join(" · ");
  const st = rec.status === "ok" ? "✓ " : rec.status === "failed" ? "✗ " : "… ";
  return st + "#" + rec.number + (rec.url ? " " + rec.url : "") + (marks ? "\n" + marks : "") + (rec.error ? "\n" + rec.error : "");
}

module.exports = {
  STATE_DIR,
  HISTORY_LIMIT,
  stateDir,
  readState,
  readProject,
  writeProject,
  readInfrastructure,
  writeInfrastructure,
  readDeployments,
  recordDeployment,
  updateDeployment,
  deploymentHistory,
  deploymentById,
  lastDeployment,
  rollbackTarget,
  toCloudConfig,
  summarize,
  nextNumber,
  _writeJsonAtomic: writeJsonAtomic,
};

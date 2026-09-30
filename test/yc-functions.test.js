"use strict";

/* ── Cloud Functions: функции, версии, теги и вызов ──────────────────────────
   Запуск: node test/yc-functions.test.js   (входит в общий `npm test`)

   Зачем набор. Функции в приложении было не видно вовсе, а они — самый дешёвый
   способ получить «что-то, что отвечает в интернете»: пока функцию не зовут, она
   не стоит ничего. Теперь это делают модуль src/yc-functions.js и инструмент
   ycFunctions.

   Что проверяется и почему именно это:

     • у функции НЕТ кода — код живёт в ВЕРСИИ: «изменить функцию» значит создать
       версию, и вызов всегда попадает в какую-то версию;
     • по умолчанию отвечает САМАЯ НОВАЯ версия (виртуальный тег `$latest`),
       поэтому адрес без тега меняет поведение от каждой выкатки, а постоянный тег
       даёт стабильную ссылку: это главное, что надо говорить человеку, и это
       проверяется отдельно;
     • тело создания версии сверяется целиком: память уходит БАЙТАМИ строкой
       (кратно 128 МБ), время — строкой-секундами, тег — списком; ошибка здесь
       означала бы «функция создана не с тем кодом»;
     • язык проверяется по ЖИВОМУ списку облака: придуманный «node20» должен
       отбиваться понятным отказом с похожими вариантами, а не сырой ошибкой;
     • источник кода — ровно один из трёх (архив, копия версии, архив в бакете);
       «не указал код» — это отказ, а не выдуманный пустой архив;
     • результат, а не факт отправки: после тега версия перечитывается, после
       публичности привязки перечитываются, удаление и правка проверяются
       перечитыванием — все три случая держатся НЕГАТИВНЫМИ контролями («облако
       ответило „сделано“, а на деле ничего не изменилось»);
     • вызов идёт на ПУБЛИЧНЫЙ адрес функции, а не в API сервиса, и его ответ —
       это ответ чужого кода: он может быть JSON, текстом или пустым. 403 при
       закрытой функции объясняется словами («нужна роль serverless.functions.
       invoker»), а 504 — тем, что функция не успела;
     • удаление функции забирает все версии и теги, а удалить ПОСЛЕДНЮЮ версию
       нельзя вовсе: функция без версий не отвечает;
     • инструмент агента ycFunctions: права (создание / теги и публичность /
       удаление) проверяются ДО запроса, список языков отвечает даже без
       подключённого облака, а удаление требует согласия;
     • проводка: канал yc:functions, мост окна, схема, группа «облако», промпт,
       политика прав, справочник, сервис в дашборде и консоли, тип ресурса в
       логах и тариф Cloud Functions в оценке стоимости.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а инструмент агента получает НАСТОЯЩИЙ модуль функций. */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
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
const ycCosts = require(path.join(ROOT, "src", "yc-costs.js"));
const ycConsole = require(path.join(ROOT, "src", "yc-console.js"));
const fnsLib = require(path.join(ROOT, "src", "yc-functions.js"));
const {
  createYcFunctions,
  checkName,
  checkTag,
  checkRuntime,
  parseMemoryMb,
  memoryHuman,
  parseTimeoutSec,
  timeoutHuman,
  versionInfo,
  functionInfo,
  activeVersion,
  versionWithTag,
  stableTags,
  versionTrouble,
  invokeHint,
  MEMORY_STEP_MB,
  TIMEOUT_MAX_SEC,
  MAX_CONTENT_MB,
  RUNTIMES_HINT,
} = fnsLib;
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const POLICY_SRC = read("src", "tool-policy.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const MAIN_SRC = read("src", "main.js");
const SERVICE_SRC = read("src", "yc-service.js");
const PKG = JSON.parse(read("package.json"));

// ── Подменённый Cloud Functions ─────────────────────────────────────────────
// Настоящая машина состояний: создание версии, тег, публичность и удаление
// меняют то, что отдаёт чтение. Проверяется не форма запроса, а то, что после
// вызова в каталоге действительно стало иначе.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const RUN_TIMES = ["nodejs22", "nodejs20", "nodejs18", "python312", "python311", "golang122", "java21", "bash"];

function initialState() {
  return {
    functions: [
      { id: "fn-1", folderId: "folder-1", name: "hello-func", description: "привет из облака", createdAt: daysAgo(30), status: "ACTIVE" },
      // Функция без версий: кода у неё нет вовсе, вызвать её нельзя.
      { id: "fn-2", folderId: "folder-1", name: "empty-func", description: "", createdAt: daysAgo(3), status: "ACTIVE" },
      { id: "fn-3", folderId: "folder-1", name: "old-func", description: "старая", createdAt: daysAgo(400), status: "ACTIVE" },
    ],
    versions: [
      // Постоянный тег есть только у этой версии — на неё и должна указывать
      // «стабильная» ссылка.
      { id: "ver-1", functionId: "fn-1", runtime: "nodejs22", entrypoint: "index.handler", resources: { memory: "268435456" }, executionTimeout: "PT5S", status: "ACTIVE", tags: ["prod"], createdAt: daysAgo(20), imageSize: "1048576" },
      // Самая новая: именно она отвечает по умолчанию.
      { id: "ver-2", functionId: "fn-1", runtime: "python312", entrypoint: "index.handler", resources: { memory: "134217728" }, executionTimeout: "PT10S", status: "ACTIVE", tags: [], createdAt: daysAgo(1) },
      { id: "ver-3", functionId: "fn-3", runtime: "nodejs18", entrypoint: "index.handler", resources: { memory: "134217728" }, executionTimeout: "PT5S", status: "OBSOLETE", tags: ["v1"], createdAt: daysAgo(300) },
    ],
    bindings: {
      // Закрытая функция: вызывать может только владелец и роли.
      "fn-1": [{ roleId: "functions.viewer", subject: { id: "user-1", type: "userAccount" } }],
      "fn-2": [],
      // Публичная функция: выдана роль вызывающего всем.
      "fn-3": [{ roleId: "serverless.functions.invoker", subject: { id: "allUsers", type: "system" } }],
    },
  };
}

function startFunctionsStub() {
  const calls = [];
  const state = initialState();
  // «Облако молча ничего не сделало» — так проверяются негативные контроли.
  const quiet = { patchNoop: false, tagNoop: false, bindingNoop: false, deleteNoop: false, invoke: "json" };
  let seq = 100;
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
      calls.push({ method, url, body });
      const q = url.split("?")[0];
      const query = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "";

      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json(res, 200, { iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (url.indexOf("/operations/") >= 0) {
        const id = url.slice(url.indexOf("/operations/") + "/operations/".length);
        return json(res, 200, { id, done: true, response: ops.get(id) || {} });
      }

      const op = (createdId) => {
        const id = "op-" + ++seq;
        if (createdId) ops.set(id, { id: createdId });
        return { id, done: false };
      };

      // ── вызов функции ────────────────────────────────────────────────────
      // Идёт на публичный адрес: путь — это просто id функции, а `?tag=` выбирает
      // версию. Так же отвечает настоящее облако: код возвращает свой ответ.
      const direct = q.replace(/^\//, "");
      if (["fn-1", "fn-2", "fn-3"].indexOf(direct) >= 0 && method === "POST") {
        const fn = state.functions.find((f) => f.id === direct);
        const tag = decodeURIComponent((query.split("tag=")[1] || "").split("&")[0] || "");
        const binds = state.bindings[direct] || [];
        const isPublic = binds.some((b) => b.roleId === "serverless.functions.invoker" && b.subject.id === "allUsers");
        if (!isPublic && !fn) return json(res, 404, { message: "function not found" });
        if (!isPublic) {
          return json(res, 403, { message: "Permission denied: no serverless.functions.invoker role" });
        }
        if (quiet.invoke === "timeout") return json(res, 504, { message: "execution timeout" });
        if (quiet.invoke === "text") {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          return res.end("Привет, мир!");
        }
        if (quiet.invoke === "empty") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end("");
        }
        return json(res, 200, { statusCode: 200, body: "Привет!", tag: tag, fn: direct });
      }

      // ── функции ──────────────────────────────────────────────────────────
      if (q === "/functions/v1/functions" && method === "GET") {
        return json(res, 200, { functions: plain(state.functions) });
      }
      if (q === "/functions/v1/functions" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!b.folderId || !b.name) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нет каталога или имени" });
        if (!/^[a-z][-a-z0-9]{1,61}[a-z0-9]$/.test(b.name)) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: name must match ^[a-z][-a-z0-9]{1,61}[a-z0-9]$" });
        if (state.functions.some((f) => f.name === b.name)) return json(res, 409, { code: 6, message: "ALREADY_EXISTS: функция с таким именем уже есть" });
        const id = "fn-" + ++seq;
        state.functions.push({ id, folderId: b.folderId, name: b.name, description: b.description || "", labels: b.labels || {}, createdAt: new Date().toISOString(), status: "ACTIVE" });
        state.bindings[id] = [];
        return json(res, 200, op(id));
      }
      if (q.indexOf("/functions/v1/functions/") === 0 && q.indexOf(":") < 0) {
        const id = q.slice("/functions/v1/functions/".length);
        const fn = state.functions.find((f) => f.id === id);
        if (!fn) return json(res, 404, { code: 5, message: "NOT_FOUND: функция не найдена" });
        if (method === "GET") return json(res, 200, plain(fn));
        if (method === "PATCH") {
          const b = JSON.parse(body || "{}");
          if (!b.updateMask) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: update_mask обязателен" });
          if (quiet.patchNoop) return json(res, 200, op());
          const fields = String(b.updateMask).split(",").map((x) => x.trim());
          if (fields.indexOf("name") >= 0 && b.name) fn.name = b.name;
          if (fields.indexOf("description") >= 0) fn.description = b.description == null ? "" : b.description;
          if (fields.indexOf("labels") >= 0) fn.labels = b.labels || {};
          return json(res, 200, op());
        }
        if (method === "DELETE") {
          if (quiet.deleteNoop) return json(res, 200, op());
          // Удаление функции забирает её версии, теги и привязки — как в облаке.
          state.functions = state.functions.filter((f) => f.id !== id);
          state.versions = state.versions.filter((v) => v.functionId !== id);
          delete state.bindings[id];
          return json(res, 200, op());
        }
      }
      if (/:listAccessBindings$/.test(q) && method === "GET") {
        const id = q.slice("/functions/v1/functions/".length, q.length - ":listAccessBindings".length);
        return json(res, 200, { accessBindings: plain(state.bindings[id] || []) });
      }
      if (/:updateAccessBindings$/.test(q) && method === "POST") {
        const id = q.slice("/functions/v1/functions/".length, q.length - ":updateAccessBindings".length);
        const b = JSON.parse(body || "{}");
        if (!Array.isArray(b.accessBindingDeltas) || !b.accessBindingDeltas.length) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нужны дельты привязок" });
        if (quiet.bindingNoop) return json(res, 200, op());
        const list = state.bindings[id] || (state.bindings[id] = []);
        for (const d of b.accessBindingDeltas) {
          const bd = d.accessBinding || {};
          const same = (x) => x.roleId === bd.roleId && x.subject.id === (bd.subject || {}).id;
          if (d.action === "ADD") {
            if (!list.some(same)) list.push(plain(bd));
          } else if (d.action === "REMOVE") {
            state.bindings[id] = list.filter((x) => !same(x));
          }
        }
        return json(res, 200, op());
      }

      // ── версии ───────────────────────────────────────────────────────────
      if (q === "/functions/v1/versions" && method === "GET") {
        const fid = decodeURIComponent((query.split("functionId=")[1] || "").split("&")[0] || "");
        return json(res, 200, { versions: plain(state.versions.filter((v) => !fid || v.functionId === fid)) });
      }
      if (q === "/functions/v1/versions" && method === "POST") {
        const b = JSON.parse(body || "{}");
        const fn = state.functions.find((f) => f.id === b.functionId);
        if (!fn) return json(res, 404, { code: 5, message: "NOT_FOUND: функция не найдена" });
        if (!b.runtime || !b.entrypoint || !(b.resources && b.resources.memory)) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нужны runtime, entrypoint и resources.memory" });
        if (RUN_TIMES.indexOf(b.runtime) < 0) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: runtime " + b.runtime + " is not supported" });
        const mem = Number(b.resources.memory);
        // Память кратна 128 МБ и лежит в допустимых границах — как у настоящего сервиса.
        if (!isFinite(mem) || mem % (128 * 1048576) !== 0 || mem < 134217728 || mem > 8589934592) {
          return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: memory must be a multiple of 128MB" });
        }
        const sources = ["content", "versionId", "package"].filter((k) => b[k]);
        if (sources.length !== 1) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: ровно один источник кода" });
        if (b.versionId && !state.versions.some((v) => v.id === b.versionId)) return json(res, 404, { code: 5, message: "NOT_FOUND: исходная версия не найдена" });
        if (mem < 1024 * 1048576 && b.runtime === "unknown") return json(res, 400, { code: 3, message: "INVALID_ARGUMENT" });
        const id = "ver-" + ++seq;
        state.versions.push({
          id,
          functionId: b.functionId,
          runtime: b.runtime,
          entrypoint: b.entrypoint,
          description: b.description || "",
          resources: { memory: String(mem) },
          executionTimeout: b.executionTimeout || "PT5S",
          serviceAccountId: b.serviceAccountId || "",
          status: "ACTIVE",
          tags: Array.isArray(b.tag) ? b.tag.slice() : [],
          environment: b.environment || {},
          secrets: b.secrets || [],
          connectivity: b.connectivity || {},
          createdAt: new Date().toISOString(),
        });
        return json(res, 200, op(id));
      }
      if (q.indexOf("/functions/v1/versions/") === 0) {
        const rest = q.slice("/functions/v1/versions/".length);
        const id = rest.split(":")[0];
        const ver = state.versions.find((v) => v.id === id);
        if (!ver) return json(res, 404, { code: 5, message: "NOT_FOUND: версия не найдена" });
        if (method === "GET") return json(res, 200, plain(ver));
        if (method === "DELETE") {
          state.versions = state.versions.filter((v) => v.id !== id);
          return json(res, 200, op());
        }
        if (rest.indexOf(":setTag") >= 0 || rest.indexOf(":removeTag") >= 0) {
          const b = JSON.parse(body || "{}");
          if (!b.tag) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нет тега" });
          if (b.tag === "$latest" || !/^[a-z][-_0-9a-z]*$/.test(b.tag)) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: неверный тег" });
          if (quiet.tagNoop) return json(res, 200, op());
          const add = rest.indexOf(":setTag") >= 0;
          for (const v of state.versions) {
            if (v.id === id) {
              if (add && v.tags.indexOf(b.tag) < 0) v.tags.push(b.tag);
              if (!add) v.tags = v.tags.filter((t) => t !== b.tag);
            } else if (add) {
              // Тег уникален: на другой версии он снимается сам.
              v.tags = v.tags.filter((t) => t !== b.tag);
            }
          }
          return json(res, 200, op());
        }
      }

      // ── языки выполнения ─────────────────────────────────────────────────
      if (q === "/functions/v1/runtimes" && method === "GET") return json(res, 200, { runtimes: RUN_TIMES });

      return json(res, 404, { code: 5, message: "NOT_FOUND: " + method + " " + q });
    });
  });

  const reset = () => {
    const fresh = initialState();
    for (const k of Object.keys(fresh)) state[k] = fresh[k];
    quiet.patchNoop = false;
    quiet.tagNoop = false;
    quiet.bindingNoop = false;
    quiet.deleteNoop = false;
    quiet.invoke = "json";
    calls.length = 0;
  };

  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, quiet, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function mkFns() {
  return createYcFunctions({
    fetchJson: yandex._fetchJson,
    fetchText: yandex._fetchText,
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
    ycFunctions: mkFns(),
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

// Изменяющие запросы: POST/PUT/PATCH/DELETE, кроме служебных (токен, операции)
// и самого вызова функции (он идёт на публичный адрес, а не в API сервиса).
const writeCalls = (calls) =>
  calls.filter(
    (c) =>
      (c.method === "POST" || c.method === "PUT" || c.method === "PATCH" || c.method === "DELETE") &&
      c.url.indexOf("/operations/") < 0 &&
      c.url.indexOf("/tokens") < 0 &&
      c.url.indexOf("/functions/v1/") >= 0
  );

const urlOf = (c) => String(c.url).split("?")[0];

(async () => {
  const stub = await startFunctionsStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Имена, память, время, теги и языки — до всякой сети");

  await test("ycFunctions: имя функции проверяется по правилам облака, с подсказкой", () => {
    assert.strictEqual(checkName("hello-func"), "hello-func", "годное имя не принято");
    assert.throws(() => checkName("ab"), /не подойдёт|3–63/, "слишком короткое имя прошло");
    assert.throws(() => checkName("Hello-Func"), /буквы/, "заглавные буквы прошли проверку");
    assert.throws(() => checkName(""), /Укажи имя/, "пустое имя прошло проверку");
    let hint = "";
    try {
      checkName("Hello-Func");
    } catch (e) {
      hint = e.message;
    }
    assert.ok(/hello-func/.test(hint), "в отказе нет готового имени: " + hint);
  });

  await test("ycFunctions: память приводится к мегабайтам, кратным 128, и уходит в байтах", () => {
    assert.strictEqual(parseMemoryMb("512"), 512, "512 МБ не принято");
    assert.strictEqual(parseMemoryMb("1 ГБ"), 1024, "«1 ГБ» не переведено в мегабайты");
    assert.strictEqual(parseMemoryMb(134217728), 128, "байты не переведены в мегабайты");
    // Облако принимает только кратное 128 МБ: округляем вверх сами.
    assert.strictEqual(parseMemoryMb(300) % MEMORY_STEP_MB, 0, "память не приведена к шагу 128 МБ: " + parseMemoryMb(300));
    assert.ok(parseMemoryMb(300) >= 300, "память округлена вниз — функция упала бы по нехватке памяти");
    assert.strictEqual(parseMemoryMb(""), 128, "память по умолчанию не 128 МБ");
    assert.throws(() => parseMemoryMb(9000), /максимум/, "память выше предела прошла проверку");
    assert.strictEqual(memoryHuman(1024), "1 ГБ", "человеческая запись памяти изменилась: " + memoryHuman(1024));
  });

  await test("ycFunctions: время выполнения понимается в секундах и в PT-форме и не превышает 600 с", () => {
    assert.strictEqual(parseTimeoutSec(30), 30, "секунды не приняты");
    assert.strictEqual(parseTimeoutSec("PT30S"), 30, "PT30S не разобран");
    assert.strictEqual(parseTimeoutSec("30 с"), 30, "«30 с» не разобрано");
    assert.strictEqual(parseTimeoutSec(""), 5, "время по умолчанию не 5 с");
    assert.throws(() => parseTimeoutSec(900), /максимум 600/, "время выше предела прошло: " + TIMEOUT_MAX_SEC);
    assert.ok(/5 с/.test(timeoutHuman(5)), "человеческая запись времени изменилась: " + timeoutHuman(5));
  });

  await test("ycFunctions: тег версии проверяется, а виртуальный $latest руками не ставится", () => {
    assert.strictEqual(checkTag("v1"), "v1", "обычный тег не принят");
    assert.strictEqual(checkTag("prod_2"), "prod_2", "тег с подчёркиванием не принят");
    assert.throws(() => checkTag("$latest"), /виртуальный/, "виртуальный тег разрешён");
    assert.throws(() => checkTag("latest"), /виртуальный/, "тег latest разрешён — он сбивает с толку");
    assert.throws(() => checkTag("V1"), /не подойдёт/, "заглавные буквы в теге прошли");
    assert.throws(() => checkTag(""), /Не указан тег/, "пустой тег прошёл");
  });

  await test("ycFunctions: язык проверяется по живому списку облака, с похожими вариантами", () => {
    assert.strictEqual(checkRuntime("nodejs22", RUN_TIMES), "nodejs22", "годный язык отбит");
    assert.throws(() => checkRuntime("", RUN_TIMES), /Не указан язык/, "пустой язык прошёл");
    let msg = "";
    try {
      checkRuntime("node20", RUN_TIMES);
    } catch (e) {
      msg = e.message;
    }
    assert.ok(/node20/.test(msg), "в отказе нет названного языка: " + msg);
    assert.ok(/nodejs20|nodejs22/.test(msg), "в отказе нет похожих вариантов: " + msg);
    // Без живого списка проверку формы делаем, но выдуманных запретов нет.
    assert.strictEqual(checkRuntime("python312", []), "python312", "без списка облака язык отбит");
    assert.ok(RUNTIMES_HINT.length >= 6, "подсказка по языкам обеднела");
  });

  await test("ycFunctions: боевой версией считается самая новая, а тег даёт стабильный адрес", () => {
    const list = stub.state.versions.filter((v) => v.functionId === "fn-1").map(versionInfo);
    const live = activeVersion(list);
    assert.strictEqual(live.id, "ver-2", "боевой названа не самая новая версия: " + (live && live.id));
    assert.strictEqual(versionWithTag(list, "prod").id, "ver-1", "версия с тегом не найдена");
    assert.deepStrictEqual(plain(stableTags(list).map((x) => x.tag)), ["prod"], "постоянные теги собраны неверно");
    const prod = versionWithTag(list, "prod");
    assert.ok(prod.tagged, "версия с тегом не помечена");
    // Предупреждение о «поедет от следующей выкатки» — про версию БЕЗ тега.
    const warns = versionTrouble(live, list);
    assert.ok(warns.some((w) => /самую новую|\$latest/.test(w)), "не сказано, что адрес без тега ведёт на самую новую версию: " + warns.join(" | "));
    const obsolete = versionInfo(stub.state.versions.find((v) => v.id === "ver-3"));
    assert.ok(versionTrouble(obsolete, list).some((w) => /устаревшая/.test(w)), "устаревшая версия не названа");
  });

  await test("ycFunctions: коды ответа вызова объясняются словами", () => {
    const fn = functionInfo({ id: "fn-1", name: "hello-func" });
    assert.strictEqual(invokeHint(200, "ok", fn), "", "успешный вызов получил предупреждение");
    assert.ok(/serverless\.functions\.invoker/.test(invokeHint(403, "", fn)), "403 не объяснён правами");
    assert.ok(/тег|версию/.test(invokeHint(404, "", fn)), "404 не объяснён");
    assert.ok(/время выполнения|600/.test(invokeHint(504, "timeout", fn)), "504 не объяснён временем выполнения");
    assert.ok(/логи|ycLogs/.test(invokeHint(504, "timeout", fn)), "504 не отправляет к логам");
    assert.ok(/квоту|429/.test(invokeHint(429, "", fn)), "429 не объяснён");
  });

  console.log("\n[2] Модуль против подменённого облака: версии, теги, вызов и публичность");

  await test("ycFunctions: обзор показывает функции, версии, теги и называет недоделки", async () => {
    stub.reset();
    const fns = mkFns();
    const ov = await fns.overview("oauth-1", "folder-1");
    assert.strictEqual(ov.functions.length, 3, "прочитались не все функции: " + ov.functions.length);
    const hello = ov.rows.find((r) => r.function.name === "hello-func");
    assert.strictEqual(hello.versionCount, 2, "версии функции не собраны: " + hello.versionCount);
    assert.strictEqual(hello.active.id, "ver-2", "боевая версия не определена");
    assert.deepStrictEqual(plain(hello.tags), ["prod"], "постоянные теги не собраны");
    assert.strictEqual(hello.public, false, "закрытая функция названа публичной");
    assert.deepStrictEqual(plain(ov.broken.map((r) => r.function.name)), ["empty-func"], "функция без версий не названа");
    assert.ok(ov.untagged.map((r) => r.function.name).includes("hello-func"), "функция без постоянного тега не названа");
    assert.deepStrictEqual(plain(ov.public.map((r) => r.function.name)), ["old-func"], "публичная функция не названа");
    assert.ok(/БЕЗ ВЕРСИЙ/.test(ov.lines.join(" ")), "в строках обзора нет функции без версий");
    // Чтение обзора ничего не меняет: в облако уходят только GET.
    assert.strictEqual(writeCalls(stub.calls).length, 0, "чтение обзора что-то изменило в облаке");
  });

  await test("ycFunctions: версия создаётся телом, которое ждёт API, и подтверждается созданием", async () => {
    stub.reset();
    const fns = mkFns();
    const r = await fns.createVersion("oauth-1", {
      folderId: "folder-1",
      function: "hello-func",
      runtime: "nodejs22",
      entrypoint: "index.handler",
      memoryMb: 512,
      timeoutSec: 30,
      environment: { MODE: "prod" },
      tag: "v2",
      description: "новая версия",
      sourceVersionId: "ver-1",
    });
    const call = writeCalls(stub.calls).find((c) => urlOf(c) === "/functions/v1/versions");
    assert.ok(call, "запроса на создание версии нет");
    const body = plain(JSON.parse(call.body));
    assert.strictEqual(body.functionId, "fn-1", "версия создана не той функции");
    assert.strictEqual(body.runtime, "nodejs22", "язык не ушёл в тело");
    assert.strictEqual(body.entrypoint, "index.handler", "точка входа не ушла в тело");
    // Память — БАЙТАМИ строкой (как у машин), время — строкой-секундами.
    assert.strictEqual(body.resources.memory, "536870912", "память ушла не в байтах: " + body.resources.memory);
    assert.strictEqual(body.executionTimeout, "30s", "время выполнения ушло не строкой секунд: " + body.executionTimeout);
    assert.deepStrictEqual(body.environment, { MODE: "prod" }, "переменные окружения не ушли");
    assert.deepStrictEqual(body.tag, ["v2"], "тег не ушёл списком");
    assert.strictEqual(body.versionId, "ver-1", "копия прежней версии не запрошена");
    assert.ok(!body.content && !body.package, "ушло два источника кода сразу");
    assert.strictEqual(r.version.runtime, "nodejs22", "созданная версия не перечиталась");
    assert.ok(/СРАЗУ стала боевой/.test(r.warnings.join(" ")), "не сказано, что версия сразу стала боевой");
    assert.ok(r.warnings.some((w) => /постоянн|тег/.test(w)), "не сказано про постоянный адрес");
    assert.ok(stub.state.versions.some((v) => v.functionId === "fn-1" && v.resources.memory === "536870912"), "версия не появилась в каталоге");
  });

  await test("ycFunctions: архив принимается файлом, а лишний вес отправляют в бакет", async () => {
    stub.reset();
    const fns = mkFns();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-fn-"));
    const zip = path.join(dir, "index.zip");
    fs.writeFileSync(zip, Buffer.from("PK\u0003\u0004тестовый архив"));
    const notZip = path.join(dir, "код.txt");
    fs.writeFileSync(notZip, "это не архив, а просто текстовый файл");
    const r = await fns.createVersion("oauth-1", { folderId: "folder-1", function: "hello-func", runtime: "python312", entrypoint: "index.handler", zipFile: zip, memoryMb: 128 });
    const call = writeCalls(stub.calls).find((c) => urlOf(c) === "/functions/v1/versions");
    const body = plain(JSON.parse(call.body));
    assert.ok(body.content && Buffer.from(body.content, "base64").length > 0, "архив не превратился в content: " + String(body.content).slice(0, 20));
    assert.ok(Buffer.from(body.content, "base64").toString("utf8").indexOf("тестовый архив") >= 0, "содержимое архива изменилось");
    assert.ok(/архив/.test(r.source), "источник кода не назван: " + r.source);
    await assert.rejects(() => fns.createVersion("oauth-1", { folderId: "folder-1", function: "hello-func", runtime: "python312", entrypoint: "index.handler", zipFile: path.join(dir, "нет-такого.zip") }), /не найден/, "отсутствующий архив прошёл");
    await assert.rejects(() => fns.createVersion("oauth-1", { folderId: "folder-1", function: "hello-func", runtime: "python312", entrypoint: "index.handler", zipFile: notZip }), /ZIP-архив/, "не-архив прошёл проверку");
    await assert.rejects(() => fns.createVersion("oauth-1", { folderId: "folder-1", function: "hello-func", runtime: "python312", entrypoint: "index.handler" }), /Не указан код/, "версия без кода прошла");
    assert.ok(MAX_CONTENT_MB > 0, "предел размера архива потерян");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("ycFunctions: точка входа и язык проверяются ДО запроса к облаку", async () => {
    stub.reset();
    const fns = mkFns();
    await assert.rejects(() => fns.createVersion("oauth-1", { folderId: "folder-1", function: "hello-func", runtime: "nodejs22", entrypoint: "", sourceVersionId: "ver-1" }), /точка входа/i, "пустая точка входа прошла");
    await assert.rejects(() => fns.createVersion("oauth-1", { folderId: "folder-1", function: "hello-func", runtime: "node20", entrypoint: "index.handler", sourceVersionId: "ver-1" }), /нет/, "несуществующий язык ушёл в облако");
    await assert.rejects(() => fns.createVersion("oauth-1", { folderId: "folder-1", function: "hello-func", runtime: "nodejs22", entrypoint: "index.handler", tag: "$latest", sourceVersionId: "ver-1" }), /виртуальный/, "виртуальный тег ушёл в облако");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "проверки не помешали запросу на создание версии");
  });

  await test("ycFunctions: тег версии ставится дельтой и подтверждается перечитыванием", async () => {
    stub.reset();
    const fns = mkFns();
    const r = await fns.setTag("oauth-1", { folderId: "folder-1", function: "hello-func", version: "ver-2", tag: "v2" });
    const call = writeCalls(stub.calls).find((c) => /:setTag$/.test(urlOf(c)));
    assert.ok(call, "запроса на тег нет");
    assert.deepStrictEqual(plain(JSON.parse(call.body)), { tag: "v2" }, "тело тега изменилось");
    assert.ok(stub.state.versions.find((v) => v.id === "ver-2").tags.indexOf("v2") >= 0, "тег не появился на версии");
    assert.ok(/v2/.test(r.url) && r.url.indexOf("tag=v2") >= 0, "адрес с тегом не собран: " + r.url);
    const again = await fns.setTag("oauth-1", { folderId: "folder-1", function: "hello-func", version: "ver-2", tag: "v2" });
    assert.strictEqual(again.changed, false, "повторный тег отмечен изменением");
    const off = await fns.setTag("oauth-1", { folderId: "folder-1", function: "hello-func", version: "ver-2", tag: "v2", remove: true });
    assert.ok(off.removed, "снятие тега не отмечено");
    assert.ok(stub.state.versions.find((v) => v.id === "ver-2").tags.indexOf("v2") < 0, "тег не снялся");
    // Снятие тега, которого нет ни на одной версии, — отказ ДО запроса.
    const beforeRemove = writeCalls(stub.calls).filter((c) => /:removeTag$/.test(urlOf(c))).length;
    await assert.rejects(() => fns.setTag("oauth-1", { folderId: "folder-1", function: "hello-func", version: "ver-2", tag: "v9", remove: true }), /снимать нечего/, "снятие отсутствующего тега ушло в облако");
    assert.strictEqual(writeCalls(stub.calls).filter((c) => /:removeTag$/.test(urlOf(c))).length, beforeRemove, "запрос на снятие отсутствующего тега всё-таки ушёл");
  });

  await test("ycFunctions: молча не поставленный тег ловится перечитыванием", async () => {
    stub.reset();
    stub.quiet.tagNoop = true;
    const fns = mkFns();
    await assert.rejects(
      () => fns.setTag("oauth-1", { folderId: "folder-1", function: "hello-func", version: "ver-2", tag: "v2" }),
      /не появился/,
      "«тег поставлен», которого нет, принят за успех"
    );
    stub.quiet.tagNoop = false;
  });

  await test("ycFunctions: вызов отвечает телом функции, а закрытая — объяснимым отказом", async () => {
    stub.reset();
    const fns = mkFns();
    // Публичная функция (old-func): вызов доходит до кода и возвращает JSON.
    const ok = await fns.invoke("oauth-1", { folderId: "folder-1", function: "old-func" });
    assert.strictEqual(ok.status, 200, "вызов публичной функции не прошёл: " + ok.status + " " + ok.text);
    assert.ok(ok.json && ok.json.body === "Привет!", "ответ функции не разобран: " + ok.text);
    assert.ok(ok.ok && ok.ms >= 0, "результат вызова не отмечен успешным");
    assert.ok(/ответила кодом 200/.test(ok.message), "человеческая строка вызова изменилась: " + ok.message);
    // Закрытая функция (hello-func): 403 и подсказка про роль.
    const denied = await fns.invoke("oauth-1", { folderId: "folder-1", function: "hello-func" });
    assert.strictEqual(denied.status, 403, "закрытая функция ответила не 403: " + denied.status);
    assert.ok(/invoker/.test(denied.hint), "403 не объяснён словами: " + denied.hint);
    assert.strictEqual(denied.ok, false, "403 отмечен успехом");
    // Тег уезжает в адрес вызова.
    const tagged = await fns.invoke("oauth-1", { folderId: "folder-1", function: "old-func", tag: "v1", payload: { name: "Мир" } });
    assert.ok(tagged.url.indexOf("tag=v1") >= 0, "тег не уехал в адрес: " + tagged.url);
    const sent = stub.calls.filter((c) => c.method === "POST" && /tag=v1/.test(c.url));
    assert.ok(sent.length && JSON.parse(sent[sent.length - 1].body).name === "Мир", "полезная нагрузка не ушла");
  });

  await test("ycFunctions: ответ текстом, пустой ответ и таймаут — разные вещи", async () => {
    stub.reset();
    const fns = mkFns();
    stub.quiet.invoke = "text";
    const text = await fns.invoke("oauth-1", { folderId: "folder-1", function: "old-func" });
    assert.strictEqual(text.status, 200, "текстовый ответ не прошёл");
    assert.strictEqual(text.json, null, "текст разобран как JSON");
    assert.ok(/Привет, мир!/.test(text.text), "текст ответа потерялся: " + text.text);

    stub.quiet.invoke = "empty";
    const empty = await fns.invoke("oauth-1", { folderId: "folder-1", function: "old-func" });
    assert.strictEqual(empty.status, 200, "пустой ответ не прошёл");
    assert.strictEqual(empty.text, "", "пустой ответ не пустой: " + empty.text);

    stub.quiet.invoke = "timeout";
    const slow = await fns.invoke("oauth-1", { folderId: "folder-1", function: "old-func" });
    assert.strictEqual(slow.status, 504, "таймаут не отдан как 504: " + slow.status);
    assert.ok(/время выполнения|логи/.test(slow.hint), "504 не объяснён: " + slow.hint);

    // Тег, которого нет у функции: отказ ДО вызова, а не 404 из ниоткуда.
    await assert.rejects(() => fns.invoke("oauth-1", { folderId: "folder-1", function: "old-func", tag: "prod" }), /нет версии с тегом/, "вызов с несуществующим тегом ушёл в облако");
  });

  await test("ycFunctions: публичность выдаётся дельтой и подтверждается перечитыванием", async () => {
    stub.reset();
    const fns = mkFns();
    const on = await fns.setPublic("oauth-1", { folderId: "folder-1", function: "hello-func", on: true });
    const call = writeCalls(stub.calls).find((c) => /:updateAccessBindings$/.test(urlOf(c)));
    assert.ok(call, "запроса на публичность нет");
    assert.deepStrictEqual(
      plain(JSON.parse(call.body)),
      { accessBindingDeltas: [{ action: "ADD", accessBinding: { roleId: "serverless.functions.invoker", subject: { id: "allUsers", type: "system" } } }] },
      "тело публичности изменилось — функция открывается ролью, а не флагом"
    );
    assert.ok(stub.state.bindings["fn-1"].some((b) => b.subject.id === "allUsers"), "публичность не появилась в привязках");
    assert.ok(on.warnings.some((w) => /КТО УГОДНО/.test(w)), "не предупреждено, что функцию позовёт кто угодно: " + on.warnings.join(" | "));
    const again = await fns.setPublic("oauth-1", { folderId: "folder-1", function: "hello-func", on: true });
    assert.strictEqual(again.changed, false, "повторная публичность отмечена изменением");
    const off = await fns.setPublic("oauth-1", { folderId: "folder-1", function: "hello-func", on: false });
    assert.ok(off.changed && !stub.state.bindings["fn-1"].some((b) => b.subject.id === "allUsers"), "публичность не снялась");
    // Закрытая функция — это не «пусто»: роль viewer у человека остаётся.
    assert.ok(stub.state.bindings["fn-1"].length, "привязки человека снялись вместе с публичностью");
  });

  await test("ycFunctions: молча не выданная публичность ловится перечитыванием", async () => {
    stub.reset();
    stub.quiet.bindingNoop = true;
    const fns = mkFns();
    await assert.rejects(
      () => fns.setPublic("oauth-1", { folderId: "folder-1", function: "hello-func", on: true }),
      /не стала публичной/,
      "«функция открыта», которой открыть не удалось, принята за успех"
    );
    stub.quiet.bindingNoop = false;
  });

  await test("ycFunctions: правка функции ставит маску и проверяется перечитыванием", async () => {
    stub.reset();
    const fns = mkFns();
    const r = await fns.updateFunction("oauth-1", { folderId: "folder-1", function: "empty-func", newName: "renamed-func", description: "теперь с делом" });
    const call = writeCalls(stub.calls).find((c) => urlOf(c) === "/functions/v1/functions/fn-2" && c.method === "PATCH");
    assert.ok(call, "запроса на правку функции нет");
    const body = plain(JSON.parse(call.body));
    assert.strictEqual(body.updateMask, "name,description", "нет маски обновления — сервис сбросит то, чего нет в теле");
    assert.ok(r.changed && r.function.name === "renamed-func", "правка не подтвердилась перечитыванием");
    const noop = await fns.updateFunction("oauth-1", { folderId: "folder-1", function: "renamed-func", newName: "renamed-func", description: "теперь с делом" });
    assert.strictEqual(noop.changed, false, "правка «в никуда» отмечена применённой");

    stub.quiet.patchNoop = true;
    await assert.rejects(() => fns.updateFunction("oauth-1", { folderId: "folder-1", function: "renamed-func", description: "не пройдёт" }), /не применилась/, "молча не применённая правка принята за успех");
    stub.quiet.patchNoop = false;
  });

  await test("ycFunctions: удаление функции называет уходящие версии и проверяется перечитыванием", async () => {
    stub.reset();
    const fns = mkFns();
    const r = await fns.deleteFunction("oauth-1", { folderId: "folder-1", function: "old-func" });
    assert.ok(r.deleted, "функция не отмечена удалённой");
    assert.strictEqual(r.versions.length, 1, "уходящие версии не названы");
    assert.ok(r.warnings.some((w) => /версии/.test(w)), "не сказано про уходящие версии: " + r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /ПУБЛИЧНОЙ/.test(w)), "не сказано, что функция была публичной");
    assert.ok(r.warnings.some((w) => /Триггеры|API Gateway/.test(w)), "не сказано про триггеры, которые её звали");
    assert.ok(!stub.state.functions.some((f) => f.id === "fn-3"), "функция осталась в каталоге");
    assert.strictEqual(stub.state.versions.filter((v) => v.functionId === "fn-3").length, 0, "версии удалённой функции остались");

    stub.quiet.deleteNoop = true;
    await assert.rejects(() => fns.deleteFunction("oauth-1", { folderId: "folder-1", function: "empty-func" }), /не удалилась/, "удаление без результата принято за успех");
    stub.quiet.deleteNoop = false;
  });

  await test("ycFunctions: последнюю версию удалить нельзя, а лишнюю — можно, с проверкой", async () => {
    stub.reset();
    const fns = mkFns();
    // У hello-func две версии: удаляем ту, что постарше.
    const r = await fns.deleteVersion("oauth-1", { folderId: "folder-1", function: "hello-func", version: "ver-1" });
    assert.ok(r.deleted, "версия не удалена");
    assert.ok(!stub.state.versions.some((v) => v.id === "ver-1"), "версия осталась в каталоге");
    assert.ok(r.warnings.some((w) => /теги/.test(w)), "не сказано, что вместе с версией уходят её теги");
    // Теперь у функции одна версия — удалить её нельзя.
    await assert.rejects(() => fns.deleteVersion("oauth-1", { folderId: "folder-1", function: "hello-func", version: "ver-2" }), /ЕДИНСТВЕННАЯ/, "последняя версия удалена — функция перестала бы отвечать");
    assert.ok(stub.state.versions.some((v) => v.id === "ver-2"), "последняя версия всё-таки исчезла");
  });

  await test("ycFunctions: карточка читается словами — что отвечает, чем звать и что будет при удалении", async () => {
    stub.reset();
    const fns = mkFns();
    const fn = await fns.findFunction("oauth-1", "folder-1", "hello-func");
    const vers = await fns.versions("oauth-1", fn.id);
    const binds = await fns.accessBindings("oauth-1", fn.id);
    const lines = fns.cardLines(fn, { versions: vers, public: fns.isPublic(binds), url: await fns.invokeUrlOf("oauth-1", fn) }).join("\n");
    assert.ok(/hello-func/.test(lines), "в карточке нет имени функции");
    assert.ok(/отвечает по умолчанию ver-2/.test(lines), "карточка не говорит, какая версия отвечает: " + lines);
    assert.ok(/теги: prod/.test(lines), "в карточке нет тега версии");
    assert.ok(/закрытая/.test(lines), "карточка не говорит, что функция закрытая");
    assert.ok(/постоянные адреса: prod/.test(lines), "карточка не называет постоянный адрес");
    assert.ok(/если удалить: уйдут 2 /.test(lines), "карточка не считает уходящие версии: " + lines);

    const empty = await fns.findFunction("oauth-1", "folder-1", "empty-func");
    const emptyLines = fns.cardLines(empty, { versions: [] }).join("\n");
    assert.ok(/НЕТ — функция не отвечает/.test(emptyLines), "карточка не говорит, что функция без версий не отвечает: " + emptyLines);
    assert.ok(/deploy/.test(emptyLines), "карточка не подсказывает, как выкатить код");
  });

  await test("ycFunctions: функция без версий и имя вместо id понимаются одинаково", async () => {
    stub.reset();
    const fns = mkFns();
    const byName = await fns.findFunction("oauth-1", "folder-1", "hello-func");
    const byId = await fns.findFunction("oauth-1", "folder-1", "fn-1");
    assert.strictEqual(byName.id, byId.id, "функция по имени и по id нашлась по-разному");
    // Человек и модель копируют адрес вызова — по нему функция тоже должна найтись.
    const byUrl = await fns.findFunction("oauth-1", "folder-1", "https://functions.yandexcloud.net/fn-1?tag=prod");
    assert.ok(byUrl && byUrl.id === "fn-1", "функция не найдена по адресу вызова (вернулось: " + JSON.stringify(byUrl && byUrl.name) + ")");
    assert.strictEqual(await fns.findFunction("oauth-1", "folder-1", "нет-такой"), null, "несуществующая ссылка что-то нашла");
    await assert.rejects(() => fns.createVersion("oauth-1", { folderId: "folder-1", function: "нет-такой", runtime: "nodejs22", entrypoint: "index.handler", sourceVersionId: "ver-1" }), /Не нашёл функцию/, "создание версии у несуществующей функции прошло");
  });

  await test("ycFunctions: привязки ролей показывают, кто может вызвать функцию", async () => {
    stub.reset();
    const fns = mkFns();
    const binds = await fns.accessBindings("oauth-1", "fn-3");
    assert.ok(fns.isPublic(binds), "публичная привязка не распознана");
    const closing = binds.find((b) => b.canInvoke);
    assert.ok(closing && closing.subjectId === "allUsers", "привязка вызывающего не разобрана: " + JSON.stringify(closing));
    const closed = await fns.accessBindings("oauth-1", "fn-1");
    assert.strictEqual(fns.isPublic(closed), false, "закрытая функция названа публичной");
    assert.strictEqual(closed[0].canInvoke, false, "роль просмотра названа правом вызова");
  });

  console.log("\n[3] Инструмент агента ycFunctions: права и ответы");

  await test("ycFunctions: список языков отвечает даже без подключённого облака", async () => {
    const noAuth = buildTools({ yandexOauthToken: "" });
    const out = await noAuth.tools.ycFunctions({ action: "runtimes" }, {});
    assert.ok(/nodejs22/.test(out) && /python312/.test(out), "частые языки не названы: " + out);
    assert.ok(/не подключён|Настройки/.test(await noAuth.tools.ycFunctions({ action: "list" }, {})), "без подключения нет честного отказа");
  });

  await test("ycFunctions: без каталога и с непонятным действием отвечает честно", async () => {
    const noFolder = buildTools({ ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycFunctions({ action: "list" }, {})), "нет ответа про каталог");
    const { tools } = buildTools();
    const bad = await tools.ycFunctions({ action: "выкати всё" }, {});
    assert.ok(/неизвестное действие/.test(bad) && /deploy/.test(bad), "неизвестное действие не объяснено: " + bad);
  });

  await test("ycFunctions: запреты (создание / теги и публичность / удаление) звучат ДО запроса", async () => {
    stub.reset();
    const { tools } = buildTools();
    const create = await tools.ycFunctions({ action: "create", name: "hello-func" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(create) && /создавать ресурсы/.test(create), "нет запрета на создание: " + create);
    const deploy = await tools.ycFunctions({ action: "deploy", function: "hello-func", runtime: "nodejs22", entrypoint: "index.handler", sourceVersionId: "ver-1" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(deploy) && /создавать ресурсы/.test(deploy), "нет запрета на выкатку: " + deploy);
    const tag = await tools.ycFunctions({ action: "tag", function: "hello-func", tag: "v1" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(tag) && /менять контейнеры/.test(tag), "нет запрета на теги: " + tag);
    const pub = await tools.ycFunctions({ action: "public", function: "hello-func" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(pub), "нет запрета на публичность: " + pub);
    const del = await tools.ycFunctions({ action: "delete", function: "hello-func", confirm: true }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(del) && /удалять ресурсы/.test(del), "нет запрета на удаление: " + del);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "запрет не помешал запросу в облако");
    // Чтение при выключенных правах доступно — иначе агент не увидит даже списка.
    const list = await tools.ycFunctions({ action: "list" }, {});
    assert.ok(/Функции Cloud Functions/.test(list), "чтение запрещено вместе с изменениями: " + list);
  });

  await test("ycFunctions: list и card говорят словами, что не так с функциями", async () => {
    stub.reset();
    const { tools } = buildTools();
    const out = await tools.ycFunctions({ action: "list" }, {});
    assert.ok(/hello-func/.test(out) && /версий: 2/.test(out), "нет функции с версиями: " + out);
    assert.ok(/БЕЗ ВЕРСИЙ/.test(out), "функция без версий не названа: " + out);
    assert.ok(/Без постоянного тега/.test(out), "не сказано про функции без тега: " + out);
    assert.ok(/Публичные/.test(out), "не названы публичные функции: " + out);
    assert.ok(/1 млн вызовов/.test(out), "не сказано, что функция бесплатна до первого миллиона вызовов");

    const card = await tools.ycFunctions({ action: "card", function: "hello-func" }, {});
    assert.ok(/отвечает по умолчанию/.test(card), "карточка не говорит, какая версия отвечает: " + card);
    assert.ok(/serverless\.functions\.invoker|закрытая/.test(card), "карточка не говорит про закрытость");
    const versions = await tools.ycFunctions({ action: "versions", function: "hello-func" }, {});
    assert.ok(/постоянные адреса|Постоянные адреса|НЕТ/.test(versions), "список версий не говорит про постоянные адреса: " + versions);
  });

  await test("ycFunctions: выкатка отвечает словами и предупреждает про адрес без тега", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentCreate: true });
    const out = await tools.ycFunctions({ action: "deploy", function: "hello-func", runtime: "nodejs22", entrypoint: "index.handler", memoryMb: 256, sourceVersionId: "ver-1" }, {});
    assert.ok(/✅/.test(out), "версия не создана: " + out);
    assert.ok(/СРАЗУ стала боевой|\$latest/.test(out), "не сказано, что версия сразу боевая: " + out);
    assert.ok(/tag: "v1"|постоянн/i.test(out), "не предложено поставить тег: " + out);
    assert.ok(/invoke/.test(out) && /ycLogs/.test(out), "не сказано, как проверить функцию: " + out);
  });

  await test("ycFunctions: вызов показывается вместе с ответом, а закрытая — с причиной", async () => {
    stub.reset();
    const { tools } = buildTools();
    const denied = await tools.ycFunctions({ action: "invoke", function: "hello-func" }, {});
    assert.ok(/invoker/.test(denied), "403 не объяснён в ответе инструмента: " + denied);
    assert.ok(/⚠/.test(denied), "отказ показан как успех: " + denied);
    const ok = await tools.ycFunctions({ action: "invoke", function: "old-func" }, {});
    assert.ok(/✅/.test(ok) && /Привет!/.test(ok), "ответ функции не показан: " + ok);
    assert.ok(/Адрес:/.test(ok), "адрес вызова не назван: " + ok);
  });

  await test("ycFunctions: удаление требует согласия, а публичность — предупреждает", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentDelete: true, ycAllowAgentUpdate: true });
    const ask = await tools.ycFunctions({ action: "delete", function: "old-func" }, {});
    assert.ok(/необратимо/.test(ask) && /confirm: true/.test(ask), "удаление без согласия не объяснено: " + ask);
    assert.ok(/ВСЕ её версии/.test(ask), "не сказано, что уйдут все версии: " + ask);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "без согласия функция всё-таки удалена");
    const done = await tools.ycFunctions({ action: "delete", function: "old-func", confirm: true }, {});
    assert.ok(/🗑/.test(done) && /перестанет работать|ПУБЛИЧНОЙ/.test(done), "удаление не назвало последствий: " + done);

    stub.reset();
    const pub = await tools.ycFunctions({ action: "public", function: "hello-func" }, {});
    assert.ok(/✅/.test(pub), "функция не стала публичной: " + pub);
    assert.ok(/КТО УГОДНО/.test(pub) && /закрыть|private/i.test(pub), "публичность без предупреждения и пути назад: " + pub);
    const access = await tools.ycFunctions({ action: "access", function: "hello-func" }, {});
    assert.ok(/ПУБЛИЧНАЯ/.test(access), "список прав не говорит о публичности: " + access);
  });

  console.log("\n[4] Проводка: канал, мост, схема, сервис и тариф");

  await test("ycFunctions: канал yc:functions есть в мосте, окно его видит, оболочка собирает модуль", () => {
    assert.ok(/ipcMain\.handle\("yc:functions"/.test(IPC_SRC), "нет канала yc:functions");
    assert.ok(/ycFunctions: \(args\) => ipcRenderer\.invoke\("yc:functions"/.test(PRELOAD_SRC), "окно не видит канал yc:functions");
    assert.ok(/const \{ createYcFunctions \} = require\("\.\/yc-functions\.js"\)/.test(MAIN_SRC), "оболочка не подключает модуль функций");
    assert.ok(/const ycFunctions = createYcFunctions\(\{/.test(MAIN_SRC), "модуль функций не собран в оболочке");
    const reg = /registerYcIpc\(\{([\s\S]{0,400}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /\bycFunctions\b/.test(reg[1]), "канал IPC не получает модуль функций");
    assert.ok(/handle\("yc:functions"[\s\S]{0,4000}?folderId: cfg\.folderId/.test(IPC_SRC), "канал не передаёт каталог в модуль");
    // Помощники облака передаются настоящие — иначе модуль молча ничего не сделает.
    for (const dep of ["fetchJson: yandexCloud._fetchJson", "fetchText: yandexCloud._fetchText", "endpoint: yandexCloud.endpoint", "getIamToken: yandexCloud.getIamToken", "waitOperation: yandexCloud.waitOperation"]) {
      assert.ok(MAIN_SRC.indexOf(dep) >= 0, "в сборку модуля не передан " + dep);
    }
    assert.ok(/^  ycFunctions,$/m.test(MAIN_SRC), "модуль функций не передан инструментам агента");
    // Ответ функции — не JSON: без чтения текстом его не прочитать.
    assert.ok(/async function fetchText\(/.test(read("src", "yandex-cloud.js")), "нет помощника чтения ответа текстом");
  });

  await test("ycFunctions: схема, группа «облако», промпт, права и справочник знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycFunctions"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 7000);
    for (const part of ["action", "function", "runtime", "entrypoint", "zipFile", "memoryMb", "timeoutSec", "tag", "payload", "confirm", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/код живёт в ВЕРСИИ/.test(schema), "схема не объясняет, что код живёт в версии");
    assert.ok(/\$latest/.test(schema), "схема не объясняет виртуальный тег $latest");
    assert.ok(/serverless\.functions\.invoker/.test(schema), "схема не называет роль для вызова");
    assert.ok(/создавать ресурсы/.test(schema) && /менять контейнеры/.test(schema) && /удалять ресурсы/.test(schema), "схема не называет разрешения");

    // Границы записи, а не число знаков: окно в 900 знаков ломалось от каждого
    // нового ключевого слова группы (заход 2 части 91 добавил «балансировщик»),
    // хотя проверяемое свойство — «инструмент есть в группе облака» — не менялось.
    const gAt = CORE_SRC.indexOf('id: "cloud"');
    const gEnd = CORE_SRC.indexOf('id: "', gAt + 10);
    const group = CORE_SRC.slice(gAt, gEnd > gAt ? gEnd : gAt + 900);
    assert.ok(/ycFunctions/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycFunctions/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycFunctions \(Cloud Functions/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycFunctions");

    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 420).includes('"ycFunctions"'), "нет назначения cloud.read для ycFunctions");

    assert.ok(/ycFunctions/.test(GUIDE_SRC), "в yc.md нет ycFunctions");
    assert.ok(/код живёт в ВЕРСИИ/.test(GUIDE_SRC), "справочник не объясняет, что код живёт в версии");
    assert.ok(/serverless\.functions\.invoker/.test(GUIDE_SRC), "справочник не называет роль для вызова");
    assert.ok(/1 000 000 вызовов|1 млн вызовов/.test(GUIDE_SRC), "справочник не говорит про бесплатный лимит");
  });

  await test("ycFunctions: сервис виден в дашборде и консоли, а логи знают тип ресурса", () => {
    const svc = yandex.SERVICES.find((s) => s.key === "cloudFunctions");
    assert.ok(svc, "сервиса нет в списке дашборда");
    assert.strictEqual(svc.svc, "serverless-functions", "у сервиса не тот адрес API: " + svc.svc);
    assert.strictEqual(svc.listPath, "/functions/v1/functions", "у сервиса не тот путь списка: " + svc.listPath);
    assert.strictEqual(svc.listKey, "functions", "у сервиса не то поле списка: " + svc.listKey);
    const cap = ycConsole.capabilities().find((x) => x.serviceKey === "cloudFunctions");
    assert.ok(cap, "консоль облака не знает сервис функций");
    assert.ok(cap.relations.some((r) => r.key === "versions"), "в карточке функции нет версий — а это и есть код");
    assert.ok(/cloudFunctions: "serverless\.function"/.test(SERVICE_SRC), "логи функций не знают типа ресурса serverless.function");
    assert.ok(yandex.creatableKeys().indexOf("cloudFunctions") >= 0, "функцию нельзя создать через ycCreate");
  });

  await test("ycFunctions: тариф считается по опубликованной формуле, а не выдуман", () => {
    const est = ycCosts.estimate("cloudFunctions", { memoryMb: 512 });
    assert.ok(est, "нет оценки стоимости функций");
    assert.ok(est.scenarios.length >= 3, "нет сценариев нагрузки: " + est.scenarios.length);
    const hot = ycCosts.functionsCost({ memoryMb: 512, calls: 10000000, msPerCall: 100 });
    // Цифра обязана собираться из ПОДТВЕРЖДЁННОГО тарифа, а не браться из воздуха.
    assert.strictEqual(
      hot.ram,
      ycCosts.rub(Math.max(0, hot.gbHours - ycCosts.FUNCTIONS_FREE_GB_HOUR) * ycCosts.FUNCTIONS_GB_HOUR),
      "цена памяти разошлась с тарифом: " + hot.ram
    );
    assert.strictEqual(
      hot.request,
      ycCosts.rub(((10000000 - ycCosts.FUNCTIONS_FREE_CALLS) / 1000000) * ycCosts.FUNCTIONS_PER_MILLION_CALLS),
      "цена вызовов разошлась с тарифом: " + hot.request
    );
    // Бесплатный пакет: до миллиона вызовов и 10 ГБ×час платить не за что.
    const small = ycCosts.functionsCost({ memoryMb: 128, calls: 100000, msPerCall: 100 });
    assert.strictEqual(small.total, 0, "в пределах бесплатного пакета появилась плата: " + small.total);
    assert.ok(est.free.some((f) => /1 млн вызовов/.test(f)), "в оценке нет бесплатного лимита вызовов");
    assert.ok(est.free.some((f) => /10 ГБ×час/.test(f)), "в оценке нет бесплатного лимита времени");
    assert.ok(/functions\/pricing/.test(est.source), "нет ссылки на тарифы функций: " + est.source);
    const text = ycCosts.formatLines(est).join(" ");
    assert.ok(/тарифы на/.test(text) && /калькулятор/.test(text), "в оценке нет ссылок на тарифы и калькулятор");
  });

  await test("ycFunctions: набор стоит в цепочке npm test", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-functions.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

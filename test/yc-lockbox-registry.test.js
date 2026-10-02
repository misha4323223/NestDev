"use strict";

/* ── Секреты Lockbox и реестр образов в окне ─────────────────────────────────
   Запуск: node test/yc-lockbox-registry.test.js   (входит в общий `npm test`)

   Зачем набор. У двух сервисов каталога были только ПЛИТКА-СПИСОК и карточка, а
   форм действий — не было вовсе: посмотреть секрет и его версии, выдать доступ
   сервисному аккаунту, удалить секрет; посмотреть образы реестра, убрать их
   пачкой, создать и удалить реестр. Заход 14 части 91 закрыл это в четырёх слоях.

   Главные тонкости, которые и стерегутся:
     • ЗНАЧЕНИЯ секретов НИКОГДА не читаются обратно: наружу уходят только имена
       ключей (payloadEntryKeys), а не сами значения;
     • новая версия — это СОЗДАНИЕ, выдача доступа — ПРАВО, удаление секрета и
       образов — необратимо: у каждого своё разрешение у агента;
     • облако НЕ удаляет НЕПУСТОЙ реестр: удаление честно говорит «сначала убери
       образы», а не падает с 400;
     • «уборка» берёт все образы или только старше N дней;
     • удаления спрашивают согласие ДВАЖДЫ (окно и канал).

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
const ycLockbox = require(path.join(ROOT, "src", "yc-lockbox.js"));
const ycRegistry = require(path.join(ROOT, "src", "yc-registry.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const { createYcService } = require(path.join(ROOT, "src", "yc-service.js"));
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const MAIN_SRC = read("src", "main.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = require(path.join(__dirname, "smoke", "source.js"));
const PKG = JSON.parse(read("package.json"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "yc-lockbox-work-"));

// ── Подменённое облако: Lockbox + Container Registry + operations ───────────
function startStub() {
  const calls = [];
  let seq = 0;
  let opStore = {};
  let secretList = [];
  let versionMap = {};
  let regList = [];
  let imageMap = {};
  const reset = () => {
    seq = 0;
    opStore = {};
    secretList = [
      { id: "sec1", folderId: "f1", name: "app-env", status: "ACTIVE", createdAt: "2026-09-01T10:00:00Z", currentVersion: { id: "ver1" }, deletionProtection: false, description: "Ключи приложения" },
    ];
    versionMap = { sec1: [{ id: "ver1", createdAt: "2026-09-01T10:00:00Z", status: "ACTIVE", payloadEntryKeys: ["API_KEY"] }] };
    regList = [{ id: "reg1", folderId: "f1", name: "app", status: "ACTIVE", createdAt: "2026-09-01T00:00:00Z" }];
    imageMap = {
      reg1: [
        { id: "img1", name: "app", tags: ["v1", "latest"], size: 52428800, createdAt: "2026-09-20T10:00:00Z", digest: "sha256:aaa" },
        { id: "img2", name: "app", tags: ["old"], size: 1048576, createdAt: "2026-01-01T10:00:00Z", digest: "sha256:bbb" },
      ],
    };
  };
  reset();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const raw = req.url || "";
      const p = raw.split("?")[0];
      const q = raw.split("?")[1] || "";
      calls.push({ method: req.method, url: raw, body: body });
      const json = (o, s) => {
        res.writeHead(s || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const op = (resp) => {
        const id = "op-" + ++seq;
        opStore[id] = resp === undefined ? null : resp;
        return json({ id: id, done: true, response: opStore[id] });
      };
      if (p === "/iam/v1/tokens") return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (p.indexOf("/operations/") === 0) {
        const id = p.split("/").pop();
        return json({ id: id, done: true, response: opStore[id] || null });
      }
      let m;
      // ── Lockbox ──
      if ((m = /^\/lockbox\/v1\/secrets\/([^/:]+):addVersion$/.exec(p))) {
        const id = decodeURIComponent(m[1]);
        let keys = [];
        try {
          keys = (JSON.parse(body || "{}").payloadEntries || []).map((e) => e.key);
        } catch {}
        const v = { id: "ver-" + ++seq, createdAt: "2026-10-01T11:00:00Z", status: "ACTIVE", payloadEntryKeys: keys };
        versionMap[id] = (versionMap[id] || []).concat([v]);
        const s = secretList.find((x) => x.id === id);
        if (s) s.currentVersion = { id: v.id };
        return op(v);
      }
      if ((m = /^\/lockbox\/v1\/secrets\/([^/:]+):updateAccessBindings$/.exec(p))) {
        return op({});
      }
      if ((m = /^\/lockbox\/v1\/secrets\/([^/]+)\/versions$/.exec(p))) {
        return json({ versions: versionMap[decodeURIComponent(m[1])] || [] });
      }
      if ((m = /^\/lockbox\/v1\/secrets\/([^/]+)$/.exec(p))) {
        const id = decodeURIComponent(m[1]);
        if (req.method === "DELETE") {
          const before = secretList.length;
          secretList = secretList.filter((x) => x.id !== id);
          return op(before === secretList.length ? null : { id: id });
        }
        const s = secretList.find((x) => x.id === id);
        return s ? json(s) : json({ message: "not found" }, 404);
      }
      if (p === "/lockbox/v1/secrets") {
        if (req.method === "POST") {
          let b = {};
          try { b = JSON.parse(body || "{}"); } catch {}
          const s = { id: "sec-" + ++seq, folderId: b.folderId, name: b.name, status: "ACTIVE", createdAt: "2026-10-01T10:00:00Z", currentVersion: null, deletionProtection: false };
          secretList.push(s);
          return op(s);
        }
        return json({ secrets: secretList });
      }
      // ── Container Registry ──
      if ((m = /^\/container-registry\/v1\/images\/([^/]+)$/.exec(p))) {
        const id = decodeURIComponent(m[1]);
        for (const k of Object.keys(imageMap)) imageMap[k] = imageMap[k].filter((i) => i.id !== id);
        return op(null);
      }
      if (p === "/container-registry/v1/images") {
        const rid = decodeURIComponent((/registryId=([^&]+)/.exec(q) || ["", ""])[1]);
        return json({ images: imageMap[rid] || [] });
      }
      if ((m = /^\/container-registry\/v1\/registries\/([^/]+)$/.exec(p))) {
        if (req.method === "DELETE") {
          const id = decodeURIComponent(m[1]);
          regList = regList.filter((x) => x.id !== id);
          return op(null);
        }
        return json({});
      }
      if (p === "/container-registry/v1/registries") {
        if (req.method === "POST") {
          let b = {};
          try { b = JSON.parse(body || "{}"); } catch {}
          const r = { id: "reg-" + ++seq, folderId: b.folderId, name: b.name, status: "ACTIVE", createdAt: "2026-10-01T10:00:00Z" };
          regList.push(r);
          return op(r);
        }
        return json({ registries: regList });
      }
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () =>
      r({ server: server, calls: calls, reset: reset, secrets: () => secretList, registries: () => regList, images: (id) => imageMap[id] || [], base: "http://127.0.0.1:" + server.address().port })
    );
  });
}

// ── Инструменты агента на подменённом облаке ────────────────────────────────
function buildTool(settingsOver) {
  const settings = Object.assign(
    { yandexOauthToken: "oauth-1", ycFolderId: "f1", ycFolderName: "prod", ycAllowAgentCreate: false, ycAllowAgentDelete: false, ycAllowAgentUpdate: false },
    settingsOver || {}
  );
  const tools = createCloudTools({
    ycDb: {},
    path: path,
    fs: fs,
    yandexCloud: yandex,
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
  return { tools: tools, settings: settings };
}

let stub = null;

(async function main() {
  stub = await startStub();

  console.log("\n[1] Модули yc-lockbox.js и yc-registry.js: проверки и слова");

  await test("yc-lockbox: имя, статусы, строка секрета и поиск", () => {
    assert.strictEqual(ycLockbox.checkName("app-env"), "app-env", "хорошее имя отвергнуто");
    assert.throws(() => ycLockbox.checkName("Плохое Имя"), /не подойдёт|имя секрета/, "плохое имя принято");
    assert.throws(() => ycLockbox.checkName(""), /Укажи имя/, "пустое имя принято");
    assert.strictEqual(ycLockbox.statusHuman("ACTIVE"), "готов", "ACTIVE не переведён");
    assert.ok(/app-env/.test(ycLockbox.secretLine({ id: "s1", name: "app-env", status: "ACTIVE" })), "строка секрета потеряла имя");
    const list = [{ id: "s1", name: "app-env" }, { id: "s2", name: "db" }];
    assert.strictEqual(ycLockbox.matchSecret(list, "db").id, "s2", "поиск по имени не сработал");
    assert.strictEqual(ycLockbox.matchSecret(list, "s1").name, "app-env", "поиск по id не сработал");
    assert.strictEqual(ycLockbox.matchSecret(list, "нет"), null, "чужой секрет нашёлся");
    assert.strictEqual(ycLockbox.matchSecret([list[0]], "").id, "s1", "единственный секрет не выбран без имени");
  });

  await test("yc-lockbox: пары «ключ → значение» — оба вида и проверка ключа", () => {
    assert.deepStrictEqual(ycLockbox.checkEntries({ API_KEY: "x", DB: "y" }), [{ key: "API_KEY", textValue: "x" }, { key: "DB", textValue: "y" }], "объект не разобран");
    assert.deepStrictEqual(ycLockbox.checkEntries([{ key: "A", value: "1" }]), [{ key: "A", textValue: "1" }], "список не разобран");
    assert.throws(() => ycLockbox.checkEntries({}), /Нет ни одной пары/, "пустой набор принят");
    assert.throws(() => ycLockbox.checkEntries({ "плохой ключ": "x" }), /не годится/, "плохой ключ принят");
    const line = ycLockbox.versionLine({ id: "ver1", createdAt: "2026-09-01T10:00:00Z", payloadEntryKeys: ["API_KEY"] });
    assert.ok(/ver1/.test(line) && /API_KEY/.test(line), "строка версии потеряла id или ключи");
  });

  await test("yc-registry: имя, строка реестра, размер и поиск образа", () => {
    assert.strictEqual(ycRegistry.checkName("app"), "app", "хорошее имя отвергнуто");
    assert.throws(() => ycRegistry.checkName("Плохое"), /не подойдёт|имя реестра/, "плохое имя принято");
    assert.ok(/app/.test(ycRegistry.registryLine({ id: "r1", name: "app", status: "ACTIVE" })), "строка реестра потеряла имя");
    assert.strictEqual(ycRegistry.humanSize(52428800), "50 МБ", "размер в МБ неверен: " + ycRegistry.humanSize(52428800));
    assert.strictEqual(ycRegistry.humanSize(2048), "2 КБ", "размер в КБ неверен");
    const list = [{ id: "i1", tags: ["v1", "latest"], digest: "sha256:aaa" }, { id: "i2", tags: ["old"], digest: "sha256:bbb" }];
    assert.strictEqual(ycRegistry.matchImage(list, "i2").id, "i2", "поиск по id не сработал");
    assert.strictEqual(ycRegistry.matchImage(list, "v1").id, "i1", "поиск по тегу не сработал");
    assert.strictEqual(ycRegistry.matchImage(list, "sha256:bbb").id, "i2", "поиск по digest не сработал");
    assert.strictEqual(ycRegistry.matchImage(list, "нет"), null, "чужой образ нашёлся");
    assert.ok(/теги: old/.test(ycRegistry.imageLine(list[1])), "строка образа потеряла теги");
  });

  console.log("\n[2] Инструменты агента ycSecret и ycRegistry под разрешениями");

  process.env.AI_AGENT_YC_BASE = stub.base;

  await test("ycSecret: карточка читается, чужие действия названы списком", async () => {
    stub.reset();
    yandex.resetIamCache();
    const { tools } = buildTool({});
    const card = await tools.ycSecret({ action: "card", secret: "app-env" }, {});
    assert.ok(/Текущая версия/.test(card) && /Версий всего: 1/.test(card), "карточка секрета не показана: " + card.slice(0, 200));
    const bad = await tools.ycSecret({ action: "стереть" }, {});
    assert.ok(/неизвестное действие ycSecret/.test(bad) && /card/.test(bad) && /grant/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 160));
  });

  await test("ycSecret: putversion, grant и delete заперты разрешениями ДО сети", async () => {
    stub.reset();
    const { tools } = buildTool({});
    const put = await tools.ycSecret({ action: "putversion", secret: "app-env", entries: { A: "1" } }, {});
    assert.ok(/⛔/.test(put) && /создавать/.test(put), "putversion не заперт: " + put.slice(0, 120));
    const gr = await tools.ycSecret({ action: "grant", secret: "app-env", serviceAccountId: "sa1" }, {});
    assert.ok(/⛔/.test(gr) && /Править|менять/.test(gr), "grant не заперт: " + gr.slice(0, 120));
    const del = await tools.ycSecret({ action: "delete", secret: "app-env" }, {});
    assert.ok(/⛔/.test(del) && /удалять/.test(del), "delete не заперт: " + del.slice(0, 120));
  });

  await test("ycSecret: с разрешениями новая версия, доступ и удаление — по-настоящему", async () => {
    stub.reset();
    yandex.resetIamCache();
    const { tools } = buildTool({ ycAllowAgentCreate: true, ycAllowAgentUpdate: true, ycAllowAgentDelete: true });
    const put = await tools.ycSecret({ action: "putversion", secret: "app-env", entries: { DB_URL: "x" } }, {});
    assert.ok(/✅ Новая версия/.test(put) && /DB_URL/.test(put), "версия не добавлена: " + put.slice(0, 200));
    const gr = await tools.ycSecret({ action: "grant", secret: "app-env", serviceAccountId: "sa1" }, {});
    assert.ok(/✅ Доступ/.test(gr) && /lockbox.payloadViewer/.test(gr), "доступ не выдан: " + gr.slice(0, 200));
    const del = await tools.ycSecret({ action: "delete", secret: "app-env" }, {});
    assert.ok(/🗑 Секрет удалён/.test(del), "секрет не удалён: " + del.slice(0, 200));
    assert.ok(!stub.secrets().some((s) => s.id === "sec1"), "секрет остался после удаления");
  });

  await test("ycRegistry: list и create, чужие действия названы списком", async () => {
    stub.reset();
    const { tools } = buildTool({ ycAllowAgentCreate: true });
    const list = await tools.ycRegistry({ action: "list" }, {});
    assert.ok(/Реестры Container Registry/.test(list) && /app/.test(list), "список реестров не показан: " + list.slice(0, 200));
    const made = await tools.ycRegistry({ action: "create", name: "win" }, {});
    assert.ok(/✅ Реестр создан/.test(made) && /win/.test(made), "реестр не создан: " + made.slice(0, 200));
    const bad = await tools.ycRegistry({ action: "стереть" }, {});
    assert.ok(/неизвестное действие ycRegistry/.test(bad) && /clean/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 160));
  });

  await test("ycRegistry: create и clean заперты разрешениями ДО сети, clean убирает образы", async () => {
    stub.reset();
    const off = buildTool({});
    const cr = await off.tools.ycRegistry({ action: "create", name: "x" }, {});
    assert.ok(/⛔/.test(cr) && /создавать/.test(cr), "create не заперт: " + cr.slice(0, 120));
    const cl = await off.tools.ycRegistry({ action: "clean", registry: "app" }, {});
    assert.ok(/⛔/.test(cl) && /удалять/.test(cl), "clean не заперт: " + cl.slice(0, 120));

    yandex.resetIamCache();
    const on = buildTool({ ycAllowAgentDelete: true });
    const cleaned = await on.tools.ycRegistry({ action: "clean", registry: "app" }, {});
    assert.ok(/🧹 Убрано образов: 2/.test(cleaned), "образы не убраны: " + cleaned.slice(0, 200));
    assert.strictEqual(stub.images("reg1").length, 0, "образы остались после уборки");
  });

  console.log("\n[3] Каналы окна: yc:lockbox и yc:registry зовут то же облако, что и агент");

  function makeChannel() {
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
    const settings = { workingDir: work, yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "f1", ycFolderName: "prod" };
    const svc = createYcService({
      app: { getPath: () => work },
      path: path,
      net: {},
      secrets: {},
      yandexCloud: yandex,
      ycCli: {},
      ycLogs: {},
      ycEnsurePath: () => {},
      loadSettings: () => settings,
    });
    registerYcIpc({ ipcMain: ipcMain, yandexCloud: yandex, ycLockbox: ycLockbox, ycRegistry: ycRegistry, loadSettings: () => settings, saveSettings: () => {}, svc: svc });
    assert.ok(handlers.has("yc:lockbox"), "канал yc:lockbox не зарегистрирован");
    assert.ok(handlers.has("yc:registry"), "канал yc:registry не зарегистрирован");
    return handlers;
  }

  await test("yc:lockbox: список, карточка, версии, создание, версия и доступ", async () => {
    stub.reset();
    yandex.resetIamCache();
    const h = makeChannel();
    const call = (args) => h.get("yc:lockbox")(null, args);

    const list = await call({ op: "list" });
    assert.ok(list.ok && list.secrets.length === 1 && /app-env/.test(list.lines.join(" ")), "список не показан: " + JSON.stringify(list).slice(0, 200));

    const card = await call({ op: "secret", secret: "app-env" });
    assert.ok(card.ok && /Текущая версия: ver1/.test(card.lines.join(" ")), "карточка без версии: " + JSON.stringify(card).slice(0, 200));

    const vers = await call({ op: "versions", secret: "app-env" });
    assert.ok(vers.ok && vers.versions.length === 1 && /API_KEY/.test(vers.lines.join(" ")), "версии не показаны: " + JSON.stringify(vers).slice(0, 200));

    const made = await call({ op: "create", name: "win-secret" });
    assert.ok(made.ok && made.changed && /Секрет создан/.test(made.lines.join(" ")), "секрет не создан: " + JSON.stringify(made).slice(0, 200));

    const put = await call({ op: "putversion", secret: "app-env", entries: { DB_URL: "x" } });
    assert.ok(put.ok && /Новая версия/.test(put.lines.join(" ")) && /DB_URL/.test(put.lines.join(" ")), "версия не добавлена: " + JSON.stringify(put).slice(0, 200));

    const gr = await call({ op: "grant", secret: "app-env", serviceAccountId: "sa1" });
    assert.ok(gr.ok && gr.changed && /Доступ к секрету/.test(gr.lines.join(" ")), "доступ не выдан: " + JSON.stringify(gr).slice(0, 200));
  });

  await test("yc:lockbox: удаление ДВУХШАГОВОЕ и честные отказы", async () => {
    stub.reset();
    yandex.resetIamCache();
    const h = makeChannel();
    const call = (args) => h.get("yc:lockbox")(null, args);

    const bad = await call({ op: "стереть" });
    assert.ok(bad.ok === false && /Доступно: list, secret, versions, create, putversion, grant, delete\./.test(bad.error), "чужое действие не назвало список: " + bad.error);

    const putBad = await call({ op: "putversion", secret: "app-env", entries: {} });
    assert.ok(putBad.ok === false && /Нет ни одной пары/.test(putBad.error), "пустой набор не отвергнут: " + putBad.error);
    const noName = await call({ op: "create", name: "Плохое" });
    assert.ok(noName.ok === false && /не подойдёт|имя секрета/.test(noName.error), "плохое имя не отвергнуто: " + noName.error);

    const delNo = await call({ op: "delete", secret: "app-env" });
    assert.ok(delNo.ok === false && delNo.needsConfirm === true, "секрет удалён без согласия");
    assert.ok(stub.secrets().some((s) => s.id === "sec1"), "секрет исчез без согласия");
    const del = await call({ op: "delete", secret: "app-env", confirmed: true });
    assert.ok(del.ok && del.deleted && /Секрет удалён/.test(del.lines.join(" ")), "секрет не удалён: " + JSON.stringify(del).slice(0, 200));
    assert.ok(!stub.secrets().some((s) => s.id === "sec1"), "секрет остался после удаления");
  });

  await test("yc:registry: список, образы, создание, удаление образа и уборка", async () => {
    stub.reset();
    yandex.resetIamCache();
    const h = makeChannel();
    const call = (args) => h.get("yc:registry")(null, args);

    const list = await call({ op: "list" });
    assert.ok(list.ok && list.registries.length === 1 && /app/.test(list.lines.join(" ")), "список реестров не показан: " + JSON.stringify(list).slice(0, 200));

    const images = await call({ op: "images", registry: "app" });
    assert.ok(images.ok && images.images.length === 2 && /v1/.test(images.lines.join(" ")), "образы не показаны: " + JSON.stringify(images).slice(0, 200));

    const made = await call({ op: "create", name: "win" });
    assert.ok(made.ok && made.changed && /Реестр создан/.test(made.lines.join(" ")), "реестр не создан: " + JSON.stringify(made).slice(0, 200));

    // Уборка только старше 30 дней: старый образ уходит, свежий остаётся.
    const cleanNo = await call({ op: "clean", registry: "app", olderThanDays: 30 });
    assert.ok(cleanNo.ok === false && cleanNo.needsConfirm === true, "уборка прошла без согласия");
    const clean = await call({ op: "clean", registry: "app", olderThanDays: 30, confirmed: true });
    assert.ok(clean.ok && clean.cleared === 1, "старый образ не убран: " + JSON.stringify(clean).slice(0, 200));
    assert.deepStrictEqual(stub.images("reg1").map((i) => i.id), ["img1"], "после уборки остался не тот набор");

    const delNo = await call({ op: "delimage", registry: "app", image: "v1" });
    assert.ok(delNo.ok === false && delNo.needsConfirm === true, "образ удалён без согласия");
    assert.ok(stub.images("reg1").some((i) => i.id === "img1"), "образ исчез без согласия");
    const del = await call({ op: "delimage", registry: "app", image: "v1", confirmed: true });
    assert.ok(del.ok && del.deleted, "образ не удалён: " + JSON.stringify(del).slice(0, 200));
    assert.strictEqual(stub.images("reg1").length, 0, "образ остался после удаления");
  });

  await test("yc:registry: непустой реестр не удаляется, пустой — удаляется; честные отказы", async () => {
    stub.reset();
    yandex.resetIamCache();
    const h = makeChannel();
    const call = (args) => h.get("yc:registry")(null, args);

    const full = await call({ op: "delete", registry: "app", confirmed: true });
    assert.ok(full.ok === false && /не пуст/.test(full.error), "непустой реестр удалён: " + JSON.stringify(full).slice(0, 200));

    await call({ op: "clean", registry: "app", confirmed: true });
    const delNo = await call({ op: "delete", registry: "app" });
    assert.ok(delNo.ok === false && delNo.needsConfirm === true, "реестр удалён без согласия");
    const del = await call({ op: "delete", registry: "app", confirmed: true });
    assert.ok(del.ok && del.deleted, "пустой реестр не удалён: " + JSON.stringify(del).slice(0, 200));
    assert.strictEqual(stub.registries().length, 0, "реестр остался после удаления");

    const bad = await call({ op: "стереть" });
    assert.ok(bad.ok === false && /Доступно: list, images, create, delimage, clean, delete\./.test(bad.error), "чужое действие не назвало список: " + bad.error);
  });

  function channelOf(settings) {
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
    const svc = createYcService({ app: { getPath: () => work }, path: path, net: {}, secrets: {}, yandexCloud: yandex, ycCli: {}, ycLogs: {}, ycEnsurePath: () => {}, loadSettings: () => settings });
    registerYcIpc({ ipcMain: ipcMain, yandexCloud: yandex, ycLockbox: ycLockbox, ycRegistry: ycRegistry, loadSettings: () => settings, saveSettings: () => {}, svc: svc });
    return handlers;
  }

  await test("оба канала честно отвечают без подключения и без каталога", async () => {
    const off = channelOf({ workingDir: work, yandexOauthToken: "", ycFolderId: "f1" });
    const noAuth = await off.get("yc:lockbox")(null, { op: "list" });
    assert.ok(noAuth.ok === false && /не подключён/.test(noAuth.error), "нет ответа про подключение: " + noAuth.error);
    const noFolder = channelOf({ workingDir: work, yandexOauthToken: "oauth-1", ycFolderId: "" });
    for (const ch of ["yc:lockbox", "yc:registry"]) {
      const r = await noFolder.get(ch)(null, { op: "list" });
      assert.ok(r.ok === false && /каталог/.test(r.error), ch + ": нет ответа про каталог: " + r.error);
    }
  });

  delete process.env.AI_AGENT_YC_BASE;

  console.log("\n[4] Согласованность: канал, мост, окно, схема, справочник и цепочка");

  await test("каналы yc:lockbox и yc:registry, мост окна и оболочка на месте", () => {
    assert.ok(/ipcMain\.handle\("yc:lockbox"/.test(IPC_SRC), "канала yc:lockbox нет в yc-ipc.js");
    assert.ok(/ipcMain\.handle\("yc:registry"/.test(IPC_SRC), "канала yc:registry нет в yc-ipc.js");
    const found = [...IPC_SRC.matchAll(/ipcMain\.handle\("(yc:[^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(found.length, 40, "каналов в мосте должно быть 40: " + found.length);
    assert.ok(/ycLockbox: \(args\) => ipcRenderer\.invoke\("yc:lockbox"/.test(PRELOAD_SRC), "нет моста ycLockbox");
    assert.ok(/ycRegistry: \(args\) => ipcRenderer\.invoke\("yc:registry"/.test(PRELOAD_SRC), "нет моста ycRegistry");
    assert.ok(/require\("\.\/yc-lockbox\.js"\)/.test(MAIN_SRC) && /\bycLockbox\b/.test(MAIN_SRC), "оболочка не подключает модуль секретов");
    assert.ok(/require\("\.\/yc-registry\.js"\)/.test(MAIN_SRC) && /\bycRegistry\b/.test(MAIN_SRC), "оболочка не подключает модуль реестра");
    assert.ok(/lockbox: "ycLockbox"/.test(ACTIONS_SRC), "семейство lockbox не знает свой канал");
    assert.ok(/containerRegistry: "ycRegistry"/.test(ACTIONS_SRC), "семейство containerRegistry не знает свой канал");
    assert.ok(/lockbox: \["list", "secret", "versions", "create", "putversion", "grant", "delete"\]/.test(ACTIONS_SRC), "OPS семейства lockbox не совпадают");
    assert.ok(/containerRegistry: \["list", "images", "create", "delimage", "clean", "delete"\]/.test(ACTIONS_SRC), "OPS семейства containerRegistry не совпадают");
    assert.ok(/lockbox: lockboxActions\(\)/.test(ACTIONS_SRC) && /containerRegistry: registryActions\(\)/.test(ACTIONS_SRC), "семейства не собраны");
  });

  await test("инструмент, схема, справочник, права и цепочка npm test знают оба сервиса", () => {
    const TOOLS_SRC = read("src", "agent-tools-cloud.js");
    assert.ok(/Доступно: list, card, versions, putversion, grant, delete\./.test(TOOLS_SRC), "ycSecret не назвал новые действия");
    assert.ok(/Доступно: list, images, create, delete, clean\./.test(TOOLS_SRC), "ycRegistry не назвал новые действия");
    assert.ok(/name: "ycSecret"/.test(SCHEMAS_SRC) && /list \| card \| versions \| putversion \| grant \| delete/.test(SCHEMAS_SRC), "схема ycSecret не обновлена");
    assert.ok(/name: "ycRegistry"/.test(SCHEMAS_SRC) && /list \| create \| images \| delete \| clean/.test(SCHEMAS_SRC), "схема ycRegistry не обновлена");
    assert.ok(/action: "grant"/.test(GUIDE_SRC) && /`clean`/.test(GUIDE_SRC), "справочник yc.md не знает про grant и clean");
    assert.ok(/каналов в мосте должно быть 40/.test(SMOKE_SRC), "сторож каналов не пересчитан");
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-lockbox-registry.test.js") >= 0, "набора нет в цепочке npm test");
    assert.ok(/src\/yc-lockbox\.js/.test(read("docs", "ARCHITECTURE.md")) && /src\/yc-registry\.js/.test(read("docs", "ARCHITECTURE.md")), "модулей нет в карте ARCHITECTURE.md");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  stub.server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("Стенд упал: " + ((e && e.stack) || e));
  process.exit(1);
});

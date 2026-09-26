"use strict";

/* ── Образы Container Registry: посмотреть и почистить ────────────────────────
   Запуск: node test/yc-registry.test.js   (входит в общий `npm test`)

   Зачем набор. Образы копились молча: каждая выкатка добавляет новый, а убрать
   прежние было нечем — список читался карточкой панели, а удаление образа жило
   только в скрипте E2E (scripts/live-yc-real.js). Хранилище Container Registry
   платное, и реестр за месяц вырастает в десятки ненужных образов.

   Главная тонкость, ради которой набор и написан: человек и модель называют
   образ ТЕГОМ («удали app:v1.2»), а ImageService.Delete принимает ровно id
   образа. Значит перед удалением образ нужно найти — по id, тегу или digest, —
   и только потом удалять; иначе «образ с таким тегом есть» превращается в
   «образа нет» на ровном месте.

   Что проверяется:
     • поиск образа по id, тегу и digest (и честный null, когда не нашлось);
     • настоящие запросы: список образов и DELETE /container-registry/v1/images/{id}
       с ожиданием операции;
     • обёртки панели, канал IPC, проброс в окно и подтверждение перед удалением;
     • инструмент агента ycRegistry: разрешения, поиск реестра по имени и по id,
       images / delete и тексты ответов;
     • согласованность: схема, группа промпта, политика прав, справочник yc.md,
       список инструментов в smoke-наборе;
     • набор стоит в цепочке npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а инструмент агента получает подменённый модуль облака. */

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

const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
const ycConsoleMain = require(path.join(ROOT, "src", "yc-console.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const CONSOLE_UI_SRC = read("src", "renderer", "yc-console.js");
const SIDE_PANEL_SRC = read("src", "renderer", "side-panel.js");
const APP_SRC = read("src", "renderer", "app.js");
const CONSOLE_CSS = read("src", "renderer", "yc-console.css");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke.test.js");
const PKG = JSON.parse(read("package.json"));

// ── Подменённый Container Registry ─────────────────────────────────────────
// Список отдаётся из «реестра», поэтому проверяется не только форма запроса, но
// и то, что после удаления образ действительно исчез.
const SEED_IMAGES = [
  { id: "img-1", name: "cr.yandex/cr1/app", tags: ["v1", "latest"], size: 5242880, digest: "sha256:aaa" },
  { id: "img-2", name: "cr.yandex/cr1/app", tags: [], size: 1048576, digest: "sha256:bbb" },
];

function startRegistryStub() {
  const calls = [];
  // Удаление меняет «реестр», поэтому наборы, которые удаляют, кладут образы
  // обратно: иначе второй набор зависел бы от порядка запуска.
  const registry = { images: plain(SEED_IMAGES) };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url || "";
      calls.push({ method: req.method, url: url, body: body });
      const json = (o) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (url.indexOf("/container-registry/v1/images?") >= 0) return json({ images: plain(registry.images) });
      const del = url.match(/^\/container-registry\/v1\/images\/([^?]+)$/);
      if (del && req.method === "DELETE") {
        const id = decodeURIComponent(del[1]);
        const i = registry.images.findIndex((x) => x.id === id);
        if (i < 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ code: 5, message: "Image not found.", details: [] }));
        }
        registry.images.splice(i, 1);
        return json({ id: "op-7", done: false });
      }
      if (url.indexOf("/operations/") >= 0) return json({ id: "op-7", done: true, response: {} });
      return json({});
    });
  });
  return new Promise((r) => {
    const reset = () => {
      registry.images = plain(SEED_IMAGES);
    };
    server.listen(0, "127.0.0.1", () => r({ server, calls, registry, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function fakeCloud(over) {
  const calls = { list: 0, images: [], del: [], find: [], listService: 0 };
  const cloud = Object.assign(
    {
      serviceByKey: (k) => ({ key: "containerRegistry", title: "Container Registry", svc: "container-registry", listPath: "/container-registry/v1/registries", listKey: "registries" }),
      listService: async () => {
        calls.listService++;
        return { count: 1, items: [{ id: "cr-1", name: "app", status: "ACTIVE" }] };
      },
      listRegistryImages: async (oauth, registryId) => {
        calls.images.push({ registryId });
        return [
          { id: "img-1", name: "cr.yandex/cr1/app", tags: ["v1", "latest"], size: 5242880 },
          { id: "img-2", name: "cr.yandex/cr1/app", tags: [], size: 1048576 },
        ];
      },
      findRegistryImage: async (oauth, registryId, ref) => {
        calls.find.push({ registryId, ref });
        if (ref === "img-1") return { id: "img-1", name: "cr.yandex/cr1/app", tags: ["v1", "latest"] };
        if (ref === "v1") return { id: "img-1", name: "cr.yandex/cr1/app", tags: ["v1", "latest"] };
        return null;
      },
      deleteRegistryImage: async (oauth, imageId) => {
        calls.del.push({ imageId });
        return true;
      },
    },
    over || {}
  );
  return { cloud, calls };
}

function buildTools(over, settingsOver) {
  const { cloud, calls } = fakeCloud(over);
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
    yandexCloud: cloud,
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
  return { tools, calls, settings };
}

(async () => {
  const stub = await startRegistryStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Образ ищется по id, тегу и digest — а не только по тому, что назвал человек");

  await test("ycRegistry: поиск различает id, тег и digest, чужое возвращает пусто", () => {
    const images = [
      { id: "img-1", tags: ["v1", "latest"], digest: "sha256:aaa" },
      { id: "img-2", tags: [], digest: "sha256:bbb" },
    ];
    const find = (ref) => {
      const want = String(ref || "").trim();
      if (!want) return null;
      return (
        images.find((i) => i && i.id === want) ||
        images.find((i) => i && Array.isArray(i.tags) && i.tags.indexOf(want) >= 0) ||
        images.find((i) => i && i.digest === want) ||
        null
      );
    };
    // Форма поиска в наборе сверяется с реализацией: она должна быть одна.
    const impl = read("src", "yandex-cloud.js");
    const from = impl.indexOf("async function findRegistryImage(");
    assert.ok(from > 0, "нет функции findRegistryImage");
    const body = impl.slice(from, impl.indexOf("\n}", from));
    for (const part of ["i.id === want", "i.tags.indexOf(want) >= 0", "i.digest === want"]) {
      assert.ok(body.includes(part), "в поиске образа нет " + part);
    }
    assert.strictEqual(find("img-1").id, "img-1", "образ по id не найден");
    assert.strictEqual(find("v1").id, "img-1", "образ по тегу не найден");
    assert.strictEqual(find("sha256:bbb").id, "img-2", "образ по digest не найден");
    assert.strictEqual(find("нет-такого"), null, "чужой образ найден");
    assert.strictEqual(find(""), null, "пустая ссылка что-то нашла");
  });

  console.log("\n[2] Настоящие запросы: список образов и DELETE по id из списка");

  await test("ycRegistry: удаление зовёт DELETE того образа, который лежит в реестре", async () => {
    stub.calls.length = 0;
    stub.reset();
    yandex.resetIamCache();
    const img = await yandex.findRegistryImage("oauth-1", "cr-1", "v1");
    assert.ok(img && img.id === "img-1", "образ по тегу не найден: " + JSON.stringify(plain(img)));
    await yandex.deleteRegistryImage("oauth-1", img.id);
    const call = stub.calls.find((c) => c.method === "DELETE");
    assert.ok(call, "запрос DELETE не ушёл: " + JSON.stringify(stub.calls.map((c) => c.method + " " + c.url)));
    assert.ok(call.url.indexOf("/container-registry/v1/images/img-1") >= 0, "удаляется не тот образ: " + call.url);
    assert.ok(call.url.indexOf("img-2") === -1, "вместе с образом удалился соседний: " + call.url);
    assert.ok(stub.calls.some((c) => c.url.indexOf("/operations/op-7") >= 0), "операция не дождалась завершения");
    assert.ok(!stub.registry.images.some((x) => x.id === "img-1"), "образ остался в реестре");
    assert.strictEqual(stub.registry.images.length, 1, "удаление задело чужие образы");
  });

  await test("ycRegistry: список образов читается из реестра, а пустой id — понятная ошибка", async () => {
    stub.calls.length = 0;
    const images = await yandex.listRegistryImages("oauth-1", "cr-1");
    assert.strictEqual(images.length, 1, "список образов прочитан неверно: " + JSON.stringify(plain(images)));
    const listCall = stub.calls.find((c) => c.url.indexOf("/container-registry/v1/images?") >= 0);
    assert.ok(listCall && /registryId=cr-1/.test(listCall.url), "список запрошен не по реестру: " + (listCall && listCall.url));
    const noId = await yandex.deleteRegistryImage("oauth-1", "").then(() => null, (e) => e);
    assert.ok(noId && /Не указан id образа/.test(noId.message), "пустой id не объяснён: " + (noId && noId.message));
  });

  console.log("\n[3] Панель: обёртка, канал, проброс и подтверждение перед удалением");

  await test("ycRegistry: обёртка панели ищет образ по тегу и требует реестр", async () => {
    stub.reset();
    yandex.resetIamCache();
    const r = await ycConsoleMain.deleteRegistryImage("oauth-1", { registryId: "cr-1", tag: "v1" });
    assert.deepStrictEqual(plain(r), {
      ok: true,
      registryId: "cr-1",
      imageId: "img-1",
      name: "cr.yandex/cr1/app",
      tags: ["v1", "latest"],
    }, "обёртка ответила не тем: " + JSON.stringify(plain(r)));
    const noRegistry = await ycConsoleMain.deleteRegistryImage("oauth-1", { imageId: "img-1" }).then(() => null, (e) => e);
    assert.ok(noRegistry && /id реестра/.test(noRegistry.message), "обёртка не требует реестр: " + (noRegistry && noRegistry.message));
    const noImage = await ycConsoleMain.deleteRegistryImage("oauth-1", { registryId: "cr-1" }).then(() => null, (e) => e);
    assert.ok(noImage && /Не указан образ/.test(noImage.message), "обёртка не требует образ: " + (noImage && noImage.message));
    const missing = await ycConsoleMain.deleteRegistryImage("oauth-1", { registryId: "cr-1", tag: "нет-такого" }).then(() => null, (e) => e);
    assert.ok(missing && /нет образа/.test(missing.message), "чужой образ не объяснён: " + (missing && missing.message));
  });

  await test("ycRegistry: канал IPC, проброс в окно и подтверждение у человека", () => {
    assert.ok(IPC_SRC.includes('ipcMain.handle("yc:console:registryImage"'), "нет канала удаления образа");
    assert.ok(/ycConsole\.deleteRegistryImage\(cfg\.oauth,/.test(IPC_SRC), "канал не зовёт удаление образа");
    assert.ok(PRELOAD_SRC.includes('ycConsoleRegistryImage: (args) => ipcRenderer.invoke("yc:console:registryImage", args || {})'),
      "preload не пробрасывает удаление образа в окно");
    const from = IPC_SRC.indexOf("// Чистка Container Registry");
    assert.ok(from > 0, "канал удаления образа не подписан");
    const handler = IPC_SRC.slice(from, IPC_SRC.indexOf("yc:resources", from));
    assert.ok(handler.indexOf("allowCreate") === -1 && handler.indexOf("allowDelete") === -1,
      "удаление образа из панели закрыто разрешением агента");
    assert.ok(/Неизвестная операция с образом/.test(handler), "чужой op не отвергается");
  });

  await test("ycRegistry: в таблице образов есть удаление с подтверждением", () => {
    assert.ok(/canDeleteImage/.test(CONSOLE_UI_SRC), "нет признака удаляемой таблицы образов");
    assert.ok(CONSOLE_UI_SRC.includes('state.serviceKey === "containerRegistry" && d.key === "images"'),
      "удаление образов не привязано к таблице образов реестра");
    assert.ok(CONSOLE_UI_SRC.includes('apiCall("ycConsoleRegistryImage"'), "кнопка не вызывает канал удаления образа");
    // Подтверждение обязано СТОЯТЬ перед удалением. Проверка на одно лишь
    // упоминание `window.uiConfirm` пропускала снятый страж: негативный контроль
    // `if (false) window.uiConfirm(...)` оставлял набор зелёным, а образ удалялся
    // бы с одного клика. Поэтому спрашиваем не имя, а порядок: вопрос — раньше,
    // чем вызов удаления.
    const gateAt = CONSOLE_UI_SRC.indexOf('typeof window.uiConfirm === "function"');
    assert.ok(gateAt > 0, "удаление образа не спрашивает подтверждение у панели");
    const callAt = CONSOLE_UI_SRC.indexOf("go()");
    assert.ok(callAt > gateAt, "образ удаляется раньше подтверждения — один клик, без вопроса");
    assert.ok(CONSOLE_UI_SRC.indexOf("window.confirm(") > gateAt, "нет запасного вопроса, если панель его не дала");
    // Подтверждение — тот же модальный диалог панели: свой дубль разошёлся бы с ним.
    assert.ok(/window\.uiConfirm = confirmModal;/.test(SIDE_PANEL_SRC), "панель не отдаёт подтверждение наружу");
    assert.ok(/confirmModal: \(\.\.\.a\) => ProjectPanel\.confirmModal\(\.\.\.a\)/.test(APP_SRC), "оболочка не передаёт подтверждение в панель");
    assert.ok(/образ будет нельзя/.test(CONSOLE_UI_SRC), "в подтверждении не сказано, что образ не вернуть");
    assert.ok(/btn-danger/.test(CONSOLE_UI_SRC), "удаление образа не выглядит опасным (btn-danger)");
    assert.ok(CONSOLE_CSS.includes(".ykc-actions"), "в стилях нет колонки действий");
  });

  console.log("\n[4] Инструмент агента ycRegistry");

  await test("ycRegistry: разрешения и чужое действие — до всякой сети", async () => {
    const env = buildTools();
    const del = await env.tools.ycRegistry({ action: "delete", registry: "app", image: "v1" }, {});
    assert.ok(/⛔/.test(del) && /удалять ресурсы/.test(del), "удаление без разрешения не отбито: " + del.slice(0, 120));
    assert.strictEqual(env.calls.del.length, 0, "удаление ушло без разрешения");
    assert.strictEqual(env.calls.find.length, 0, "поиск образа пошёл до проверки разрешения");
    const bad = await env.tools.ycRegistry({ action: "почисти" }, {});
    assert.ok(/неизвестное действие ycRegistry/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 120));
    assert.strictEqual(env.calls.listService, 0, "при неизвестном действии пошли в облако");
    const noImage = await buildTools({}, { ycAllowAgentDelete: true }).tools.ycRegistry({ action: "delete", registry: "app" }, {});
    assert.ok(/укажи образ/.test(noImage), "удаление без образа не объяснено: " + noImage.slice(0, 140));
  });

  await test("ycRegistry: images показывает теги, размер и подсказывает удаление", async () => {
    const env = buildTools();
    const out = await env.tools.ycRegistry({ action: "images" }, {});
    assert.ok(/Реестр «app» \(cr-1\)/.test(out), "реестр не назван: " + out.slice(0, 120));
    assert.ok(/Образы \(2\)/.test(out), "образы не перечислены: " + out.slice(0, 200));
    assert.ok(/теги: v1, latest/.test(out), "теги образа не показаны: " + out.slice(0, 240));
    assert.ok(/без тега/.test(out), "образ без тега не отличён от тегированного");
    assert.ok(/5 МБ/.test(out), "размер образа не показан: " + out.slice(0, 240));
    assert.ok(/id img-1/.test(out), "id образа не показан — по нему удалять");
    assert.ok(/action: "delete"/.test(out), "не сказано, как удалять образы");
    assert.ok(/необратимо/.test(out) && /контейнер/.test(out), "не сказано, что удаление необратимо и забирает теги работающего контейнера");
  });

  await test("ycRegistry: реестр ищется по имени и по id, а чужое имя честно перечисляет реестры", async () => {
    const byId = buildTools();
    const out = await byId.tools.ycRegistry({ action: "images", registry: "cr-1" }, {});
    assert.ok(/cr-1/.test(out), "реестр по id не найден: " + out.slice(0, 120));

    const many = buildTools({
      listService: async () => ({
        count: 2,
        items: [{ id: "r1", name: "app" }, { id: "r2", name: "web" }],
      }),
    });
    const ambiguous = await many.tools.ycRegistry({ action: "images" }, {});
    assert.ok(/Реестров несколько/.test(ambiguous) && /app/.test(ambiguous), "неоднозначность не объяснена: " + ambiguous.slice(0, 160));
    const wrong = await many.tools.ycRegistry({ action: "images", registry: "нет-такой" }, {});
    assert.ok(/Не нашёл реестр/.test(wrong) && /web/.test(wrong), "чужой реестр не перечисляет доступные: " + wrong.slice(0, 160));

    const none = buildTools({ listService: async () => ({ count: 0, items: [] }) });
    const empty = await none.tools.ycRegistry({ action: "images" }, {});
    assert.ok(/Реестров в каталоге/.test(empty) && /ycCreate/.test(empty), "пустой каталог не подсказывает создание реестра: " + empty.slice(0, 160));

    const noImages = buildTools({ listRegistryImages: async () => [] });
    const blank = await noImages.tools.ycRegistry({ action: "images" }, {});
    assert.ok(/Образов нет/.test(blank) && /dockerBuild/.test(blank), "пустой реестр не подсказывает сборку: " + blank.slice(0, 160));
  });

  await test("ycRegistry: delete удаляет по тегу и по id, а чужой образ — честный ответ", async () => {
    const env = buildTools({}, { ycAllowAgentDelete: true });
    const byTag = await env.tools.ycRegistry({ action: "delete", registry: "app", image: "v1" }, {});
    assert.ok(/🗑/.test(byTag) && /теги: v1, latest/.test(byTag), "удаление по тегу не подтверждено: " + byTag.slice(0, 180));
    assert.deepStrictEqual(plain(env.calls.find[0]), { registryId: "cr-1", ref: "v1" }, "образ искали не в том реестре");
    assert.deepStrictEqual(plain(env.calls.del[0]), { imageId: "img-1" }, "удаление ушло не с тем id: " + JSON.stringify(plain(env.calls.del)));
    assert.ok(/action: "images"/.test(byTag), "после удаления не предложено посмотреть, что осталось");

    const byId = await env.tools.ycRegistry({ action: "delete", registry: "app", image: "img-1" }, {});
    assert.ok(/🗑/.test(byId), "удаление по id не сработало: " + byId.slice(0, 140));

    const missing = await env.tools.ycRegistry({ action: "delete", registry: "app", image: "нет-такого" }, {});
    assert.ok(/нет образа/.test(missing) && /action: "images"/.test(missing), "чужой образ не объяснён: " + missing.slice(0, 180));
    assert.strictEqual(env.calls.del.length, 2, "удаление ушло для образа, которого нет");
  });

  await test("ycRegistry: без подключения и без каталога отвечает честно", async () => {
    const off = buildTools({}, { yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await off.tools.ycRegistry({ action: "images" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({}, { ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycRegistry({ action: "images" }, {})), "нет ответа про каталог");
  });

  console.log("\n[5] Согласованность: схема, промпт, политика, справочник, smoke");

  await test("ycRegistry: схема, группа облака, промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycRegistry"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 1600);
    for (const part of ["action", "registry", "image", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/images/.test(schema) && /delete/.test(schema), "схема не называет действия");
    assert.ok(/удалять ресурсы/.test(schema), "схема не называет разрешение");
    assert.ok(/необратим/.test(schema), "схема не предупреждает, что удаление необратимо");
    const group = CORE_SRC.slice(CORE_SRC.indexOf('id: "cloud"'), CORE_SRC.indexOf('id: "cloud"') + 700);
    assert.ok(/ycRegistry/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycRegistry/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycRegistry \(образы Container Registry/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycRegistry");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 300).includes('"ycRegistry"'), "нет назначения cloud.read для ycRegistry");
  });

  await test("ycRegistry: справочник агента учит чистить реестр и не трогать рабочий тег", () => {
    assert.ok(/ycRegistry/.test(GUIDE_SRC), "в yc.md нет ycRegistry");
    assert.ok(/вместе со всеми его тегами/.test(GUIDE_SRC), "в yc.md не сказано, что удаление забирает теги");
    assert.ok(/спроси пользователя/.test(GUIDE_SRC), "в yc.md нет указания спросить перед удалением");
    assert.ok(/не удаляй тег, на который ссылается работающий/.test(GUIDE_SRC), "в yc.md не сказано про работающий контейнер");
  });

  await test("ycRegistry: набор и канал не выпадают из smoke-набора", () => {
    assert.ok(SMOKE_SRC.includes('"yc:console:registryImage"'), "канал удаления образа не назван в smoke-наборе");
    const list = SMOKE_SRC.slice(SMOKE_SRC.indexOf("for (const n of [\"ycStatus\""), SMOKE_SRC.indexOf("for (const n of [\"ycStatus\"") + 320);
    assert.ok(/"ycRegistry"/.test(list), "инструмента нет в списке инструментов smoke-набора");
    assert.ok(/"ycDns"/.test(list), "инструмента ycDns нет в списке инструментов smoke-набора");
  });

  await test("ycRegistry: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-registry.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ── Секреты Lockbox: наполнение секрета (версия со значениями) ───────────────
   Запуск: node test/yc-secret.test.js   (входит в общий `npm test`)

   Зачем набор. Секрет Lockbox умели только СОЗДАТЬ (ycCreate) и показать
   карточкой в панели облака — и всё. Ни агент, ни человек не могли добавить
   версию, а без версии секрет бесполезен: ревизия контейнера ссылается на ключ,
   которого в секрете нет, и прогон падает уже в облаке. Версии писал только
   движок деплоя — свои собственные, из .env.

   Что проверяется:
     • разбор пар «ключ → значение» из обоих видов, в которых они приходят
       (список объектов от панели, обычный объект от модели), и мусора;
     • настоящий запрос в облако: :addVersion, payloadEntries с textValue,
       ожидание операции и ответ наружу БЕЗ значений — только id и ключи;
     • обёртка панели (src/yc-console.js) и её канал IPC с пробросом в окно;
     • инструмент агента ycSecret: отказы без разрешения, list / versions /
       putversion и то, что значения секрета не утекают в текст ответа;
     • согласованность: схема, группа промпта, политика прав, справочник yc.md;
     • набор стоит в цепочке npm test — иначе это не набор.

   Сеть не нужна. Модуль облака ходит на подменённый HTTP-сервер (штатный хук
   AI_AGENT_YC_BASE, которым пользуются живые прогоны), а инструмент агента
   получает подменённый модуль облака — так проверяется текст и права. */

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
const CONSOLE_CSS = read("src", "renderer", "yc-console.css");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const PKG = JSON.parse(read("package.json"));

// ── Подменённое облако: отвечает на всё сразу ───────────────────────────────
// Один ответ закрывает три разные ручки: обмен OAuth → IAM (iamToken),
// создание версии (id операции) и ожидание операции (done + response.id).
function startCloudStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          iamToken: "iam-test",
          expiresAt: new Date(Date.now() + 3600e3).toISOString(),
          id: "op-1",
          done: true,
          response: { id: "ver-1" },
        })
      );
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, seen, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function fakeCloud(over) {
  const calls = { put: [], list: 0, versions: 0, find: 0 };
  const cloud = Object.assign(
    {
      listSecrets: async () => {
        calls.list++;
        return [{ id: "e6q-secret-1", name: "app-env", status: "ACTIVE" }];
      },
      findSecret: async () => {
        calls.find++;
        return { id: "e6q-secret-1", name: "app-env" };
      },
      getSecret: async () => ({ id: "e6q-secret-1", name: "app-env" }),
      listSecretVersions: async () => {
        calls.versions++;
        return [
          { id: "ver-2", createdAt: "2026-09-25T10:00:00Z", status: "ACTIVE", payloadEntryKeys: ["API_KEY"] },
          { id: "ver-1", createdAt: "2026-09-24T10:00:00Z", status: "ACTIVE", payloadEntryKeys: ["DB_URL"] },
        ];
      },
      putSecretVersion: async (oauth, id, entries) => {
        calls.put.push({ oauth, id, entries });
        return { versionId: "ver-9", keys: ["API_KEY"] };
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
  const stub = await startCloudStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Разбор пар «ключ → значение»");

  await test("ycSecret: пары принимаются и объектом, и списком, мусор отсеивается", () => {
    assert.deepStrictEqual(plain(yandex.normalizeSecretEntries({ API_KEY: "1", DB_URL: "2" })), [
      { key: "API_KEY", value: "1" },
      { key: "DB_URL", value: "2" },
    ], "обычный объект разобран неверно");
    assert.deepStrictEqual(plain(yandex.normalizeSecretEntries([{ key: "A", value: "1" }, { key: "", value: "x" }, "мусор", null])), [
      { key: "A", value: "1" },
    ], "список объектов разобран неверно");
    assert.deepStrictEqual(plain(yandex.normalizeSecretEntries({ "  KEY  ": 5 })), [{ key: "KEY", value: "5" }],
      "ключ не подрезан и значение не приведено к строке");
    assert.deepStrictEqual(plain(yandex.normalizeSecretEntries({ "": "x", "  ": "y" })), [], "пустые ключи приняты");
    for (const junk of [null, undefined, "", "строка", 42, true]) {
      assert.deepStrictEqual(plain(yandex.normalizeSecretEntries(junk)), [], "мусор «" + String(junk) + "» стал парами");
    }
  });

  console.log("\n[2] Настоящий запрос в облако: :addVersion без утечки значений");

  await test("ycSecret: putSecretVersion шлёт payloadEntries и отдаёт только ключи", async () => {
    stub.seen.length = 0;
    yandex.resetIamCache();
    const r = await yandex.putSecretVersion("oauth-1", "sec-1", [{ key: "API_KEY", value: "s3cret" }]);
    assert.deepStrictEqual(plain(r), { versionId: "ver-1", keys: ["API_KEY"] }, "ответ версии не тот: " + JSON.stringify(plain(r)));
    const call = stub.seen.find((c) => c.url.indexOf(":addVersion") >= 0);
    assert.ok(call, "запрос :addVersion не ушёл: " + stub.seen.map((c) => c.url).join(", "));
    assert.strictEqual(call.method, "POST", "версия создаётся не POST");
    assert.ok(/^\/lockbox\/v1\/secrets\/sec-1:addVersion/.test(call.url), "неверный путь версии: " + call.url);
    const body = JSON.parse(call.body);
    assert.deepStrictEqual(body.payloadEntries, [{ key: "API_KEY", textValue: "s3cret" }],
      "payloadEntries собраны неверно: " + call.body);
    assert.strictEqual(typeof body.description, "string", "у версии нет описания");
    // Наружу значения не уходят ни в каком виде.
    assert.ok(JSON.stringify(r).indexOf("s3cret") === -1, "значение секрета попало в ответ");
  });

  await test("ycSecret: объект от модели доходит до облака теми же парами", async () => {
    stub.seen.length = 0;
    const r = await yandex.putSecretVersion("oauth-1", "sec-1", { API_KEY: "a", DB_URL: "b" });
    assert.deepStrictEqual(plain(r.keys), ["API_KEY", "DB_URL"], "объект разобран не в том порядке: " + r.keys.join(","));
    const body = JSON.parse(stub.seen.find((c) => c.url.indexOf(":addVersion") >= 0).body);
    assert.deepStrictEqual(body.payloadEntries, [
      { key: "API_KEY", textValue: "a" },
      { key: "DB_URL", textValue: "b" },
    ], "объект не превратился в пары: " + JSON.stringify(body.payloadEntries));
  });

  await test("ycSecret: пустая версия и плохой ключ — понятная ошибка без запроса", async () => {
    stub.seen.length = 0;
    const empty = await yandex.putSecretVersion("oauth-1", "sec-1", {}).then(() => null, (e) => e);
    assert.ok(empty && /ни одной пары/.test(empty.message), "пустая версия не объяснена: " + (empty && empty.message));
    const bad = await yandex
      .putSecretVersion("oauth-1", "sec-1", { "плохой ключ": "x" })
      .then(() => null, (e) => e);
    assert.ok(bad && /не годится для Lockbox/.test(bad.message), "плохой ключ не объяснён: " + (bad && bad.message));
    const noId = await yandex.putSecretVersion("oauth-1", "", { A: "1" }).then(() => null, (e) => e);
    assert.ok(noId && /id секрета/.test(noId.message), "пустой id не объяснён: " + (noId && noId.message));
    assert.strictEqual(stub.seen.filter((c) => c.url.indexOf(":addVersion") >= 0).length, 0, "запрос ушёл несмотря на ошибку ввода");
  });

  console.log("\n[3] Панель: обёртка модуля, канал IPC и форма в карточке");

  await test("ycSecret: обёртка панели отдаёт id версии и ключи", async () => {
    const r = await ycConsoleMain.putSecretVersion("oauth-1", { secretId: "sec-1", entries: { API_KEY: "1" } });
    assert.deepStrictEqual(plain(r), { ok: true, secretId: "sec-1", versionId: "ver-1", keys: ["API_KEY"] },
      "обёртка панели ответила не тем: " + JSON.stringify(plain(r)));
    const noId = await ycConsoleMain.putSecretVersion("oauth-1", {}).then(() => null, (e) => e);
    assert.ok(noId && /id секрета/.test(noId.message), "обёртка панели не требует id секрета");
  });

  await test("ycSecret: канал IPC, проброс в окно и разрешение не спрашивается у человека", () => {
    assert.ok(IPC_SRC.includes('ipcMain.handle("yc:console:secretVersion"'), "нет канала версии секрета");
    assert.ok(/ycConsole\.putSecretVersion\(cfg\.oauth,/.test(IPC_SRC), "канал не зовёт операцию модуля консоли");
    assert.ok(PRELOAD_SRC.includes('ycConsoleSecretVersion: (args) => ipcRenderer.invoke("yc:console:secretVersion", args || {})'),
      "preload не пробрасывает версию секрета в окно");
    // Панель — действие самого человека: галочки «Разрешить АГЕНТУ…» её не касаются
    // (те же правила у соседних yc:create / yc:delete).
    const from = IPC_SRC.indexOf("// Новая версия секрета Lockbox из карточки");
    assert.ok(from > 0, "канал версии секрета не подписан");
    const handler = IPC_SRC.slice(from, IPC_SRC.indexOf("yc:resources", from));
    assert.ok(handler.indexOf("allowCreate") === -1, "создание версии из панели закрыто разрешением агента");
    assert.ok(/Разрешить АГЕНТУ/.test(handler), "нет пояснения, почему разрешение агента тут не при чём");
  });

  await test("ycSecret: в карточке секрета есть форма версии, значения закрыты", () => {
    assert.ok(CONSOLE_UI_SRC.includes("function secretVersionForm()"), "нет формы новой версии");
    assert.ok(CONSOLE_UI_SRC.includes('state.serviceKey === "lockbox"') && CONSOLE_UI_SRC.includes("secretVersionForm()"),
      "форма версии не подключена к карточке секрета");
    assert.ok(CONSOLE_UI_SRC.includes('v.type = "password"'), "значение версии печатается открытым текстом");
    assert.ok(CONSOLE_UI_SRC.includes('apiCall("ycConsoleSecretVersion"'), "форма не вызывает канал версии");
    assert.ok(/keys \|\| \[\]\)\.join/.test(CONSOLE_UI_SRC), "в подтверждении не показываются ключи");
    assert.ok(/в приложении не сохраняются/.test(CONSOLE_UI_SRC), "форма не предупреждает, что значения не сохраняются");
    assert.ok(/secretId: \(state\.item && state\.item\.id\)/.test(CONSOLE_UI_SRC), "версия уходит не тому секрету");
    for (const cls of [".ykc-secret {", ".ykc-secret-row", ".ykc-secret-key", ".ykc-secret-val"]) {
      assert.ok(CONSOLE_CSS.includes(cls), "в стилях нет " + cls);
    }
  });

  console.log("\n[4] Инструмент агента ycSecret");

  await test("ycSecret: без подключения и без каталога отвечает честно", async () => {
    const off = buildTools({}, { yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await off.tools.ycSecret({ action: "list" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({}, { ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycSecret({ action: "list" }, {})), "нет ответа про каталог");
  });

  await test("ycSecret: putversion без разрешения отказывает и в облако не идёт", async () => {
    const env = buildTools();
    const out = await env.tools.ycSecret({ action: "putversion", secret: "app-env", entries: { A: "1" } }, {});
    assert.ok(/⛔/.test(out) && /создавать ресурсы/.test(out), "нет отказа без разрешения: " + out.slice(0, 120));
    assert.strictEqual(env.calls.put.length, 0, "запрос в облако ушёл без разрешения");
    assert.ok(/action list \/ versions/.test(out), "отказ не подсказывает доступное чтение");
  });

  await test("ycSecret: список и версии — без значений, но с ключами", async () => {
    const env = buildTools();
    const list = await env.tools.ycSecret({ action: "list" }, {});
    assert.ok(/app-env/.test(list) && /e6q-secret-1/.test(list), "список секретов не показан: " + list.slice(0, 120));
    assert.ok(/putversion/.test(list) && /versions/.test(list), "список не подсказывает, как наполнить секрет");
    const emptyList = await buildTools({ listSecrets: async () => [] }).tools.ycSecret({ action: "list" }, {});
    assert.ok(/ycCreate/.test(emptyList) && /putversion/.test(emptyList), "пустой каталог не подсказывает путь до версии");

    const versions = await env.tools.ycSecret({ action: "versions", secret: "app-env" }, {});
    assert.ok(/ver-2/.test(versions) && /ver-1/.test(versions), "версии не перечислены: " + versions.slice(0, 160));
    assert.ok(/ключи: API_KEY/.test(versions) && /ключи: DB_URL/.test(versions), "имена ключей версии не показаны");
    assert.ok(/Значения секретов API не отдаёт/.test(versions), "не сказано, что значения не читаются");
    assert.strictEqual(env.calls.versions, 1, "версии спрошены не один раз");
  });

  await test("ycSecret: putversion с разрешением создаёт версию и не печатает значение", async () => {
    const env = buildTools({}, { ycAllowAgentCreate: true });
    const out = await env.tools.ycSecret({ action: "putversion", secret: "app-env", entries: { API_KEY: "s3cret-value" } }, {});
    assert.ok(/✅/.test(out) && /ver-9/.test(out), "версия не подтверждена: " + out.slice(0, 160));
    assert.ok(/API_KEY/.test(out), "в подтверждении нет имён ключей");
    assert.ok(out.indexOf("s3cret-value") === -1, "значение секрета попало в текст ответа агенту");
    assert.strictEqual(env.calls.put.length, 1, "в облако ушёл не один запрос версии");
    assert.deepStrictEqual(plain(env.calls.put[0].entries), { API_KEY: "s3cret-value" }, "версия ушла не с теми парами");
    assert.ok(/ycContainer/.test(out) && /secrets/.test(out), "не сказано, как привязать ключ к ревизии");
  });

  await test("ycSecret: поиск по id, когда имя не совпало, и чужое действие", async () => {
    const byId = buildTools({
      findSecret: async () => null,
      getSecret: async () => ({ id: "e6q-byid", name: "app-env" }),
    });
    const out = await byId.tools.ycSecret({ action: "versions", secret: "e6q-byid" }, {});
    assert.ok(/e6q-byid/.test(out), "секрет по id не найден: " + out.slice(0, 120));

    const env = buildTools();
    const bad = await env.tools.ycSecret({ action: "стирай" }, {});
    assert.ok(/неизвестное действие ycSecret/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 120));
    const noRef = await env.tools.ycSecret({ action: "versions" }, {});
    assert.ok(/укажи secret/.test(noRef), "без имени секрета нет подсказки: " + noRef.slice(0, 120));
  });

  console.log("\n[5] Согласованность: схема, промпт, политика, справочник");

  await test("ycSecret: схема, группа облака, промпт и права знают инструмент", () => {
    assert.ok(SCHEMAS_SRC.includes('name: "ycSecret"'), "нет схемы инструмента в tool-schemas");
    const at = SCHEMAS_SRC.indexOf('name: "ycSecret"');
    const schema = SCHEMAS_SRC.slice(at, at + 1800);
    for (const part of ["action", "secret", "entries", "required: [\"action\"]"]) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/Разрешить агенту создавать ресурсы/.test(schema), "схема не называет разрешение");
    assert.ok(/ycSecret/.test(CORE_SRC.slice(CORE_SRC.indexOf('id: "cloud"'), CORE_SRC.indexOf('id: "cloud"') + 700)),
      "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycSecret/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycSecret/.test(PROMPTS_SRC) && /наполнить секрет/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycSecret");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 220).includes('"ycSecret"'),
      "нет назначения cloud.read для ycSecret");
  });

  await test("ycSecret: справочник агента описывает порядок «создать → наполнить → привязать»", () => {
    assert.ok(/ycSecret/.test(GUIDE_SRC), "в yc.md нет ycSecret");
    assert.ok(/putversion/.test(GUIDE_SRC), "в yc.md нет действия putversion");
    assert.ok(/Секрет без версии бесполезен/.test(GUIDE_SRC), "в yc.md не сказано, зачем версия");
    assert.ok(/lockbox\.payloadViewer|environmentVariable/.test(GUIDE_SRC), "в yc.md нет привязки секрета к ревизии");
  });

  await test("ycSecret: набор стоит в цепочке npm test — иначе это не набор", () => {
    const chain = String(PKG.scripts.test || "");
    assert.ok(chain.indexOf("test/yc-secret.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

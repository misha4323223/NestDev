"use strict";

/* ── Файлы бакета Object Storage: посмотреть, положить, забрать и убрать ──────
   Запуск: node test/yc-storage.test.js   (входит в общий `npm test`)

   Зачем набор. Бакет в приложении было чем СОЗДАТЬ, а положить в него файл —
   нечем: список бакетов читался, а сами объекты не открывались нигде, кроме
   консоли Yandex Cloud. При этом бакет и создаётся «для файлов и статики», то
   есть созданный ресурс был пустой полкой: ни выложить статику, ни отдать файл.

   Главная тонкость, ради которой набор и написан. Объекты живут не в консольном
   API каталога (storage-api), а в S3-совместимом (storage.yandexcloud.net), и у
   него два отличия, которые легко потерять при правке:
     1) ответы — XML, а не JSON (JSON-варианта у S3 нет), причём с экранированием
        (&amp; в ключе объекта — это имя файла пользователя);
     2) авторизация IAM-токеном работает БЕЗ подписи запроса
        (Authorization: Bearer <IAM>), поэтому ни статический ключ, ни подпись
        AWS4-HMAC-SHA256 приложению не нужны.
   Если однажды кто-то «упростит» запрос до JSON или добавит подпись — набор
   обязан покраснеть.

   Что проверяется:
     • разбор XML (ключи, размер, дата, ETag без кавычек, экранирование);
     • тип содержимого по расширению ключа (от него зависит, откроется картинка
       в браузере или скачается файл);
     • настоящие запросы: GET ?list-type=2, PUT с ключом-путём, DELETE по ключу и
       человеческий текст отказа S3 вместо XML-а;
     • инструмент агента ycStorage: разрешения ДО сети, список, загрузка файла и
       текстом, скачивание на диск, удаление и все честные отказы;
     • панель: обёртка, канал IPC, связь «Объекты» в карточке бакета и удаление
       объекта из таблицы — с подтверждением, а не с одного клика;
     • согласованность: схема, группа промпта, политика прав, справочник yc.md,
       список инструментов в smoke-наборе и цепочка npm test.

   Сеть не нужна: S3 подменён локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE уводит туда и S3-адрес), а инструмент агента получает
   подменённый модуль облака.

   Чего набор НЕ проверяет (честно): настоящий предел размера объекта
   (64 МБ — это и запись на диск в тесте, и память) и права аккаунта на конкретный
   бакет — для этого нужен живой каталог владельца (scripts/live-yc-real.js). */

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
const ycConsoleMain = require(path.join(ROOT, "src", "yc-console.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const YC_SRC = read("src", "yandex-cloud.js");
const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const MOBILE_SRC = read("src", "mobile-bridge.js");
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "yc-storage-work-"));

// ── Подменённое облако: консольный API (JSON) и S3-совместимый (XML) ────────
// Один сервер, потому что штатный хук AI_AGENT_YC_BASE уводит на него оба
// адреса: и сервисы каталога, и storage.yandexcloud.net.
const BUCKETS = [{ id: "b1", name: "site-bucket", folderId: "f1", createdAt: "2026-09-01T10:00:00Z" }];
const SEED_OBJECTS = [
  { key: "index.html", size: 2048, lastModified: "2026-09-20T10:00:00.000Z", etag: "aaa" },
  { key: "a&b.txt", size: 10, lastModified: "2026-09-21T10:00:00.000Z", etag: "bbb" },
];
const BODY = { "download.txt": "файл из облака" };

function startStorageStub() {
  const calls = [];
  const state = { objects: plain(SEED_OBJECTS), anonymous: { read: false, list: false, configRead: false } };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = req.url || "";
      calls.push({ method: req.method, url: url, headers: req.headers, body: body.toString("utf8"), bytes: body.length });
      const json = (o) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const xml = (t, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/xml" });
        res.end(t);
      };
      const noKey = () =>
        xml('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>', 404);
      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      // Консольный API бакета: список, карточка и PATCH анонимного доступа.
      // Именно он (НЕ S3-совместимый) держит флаги публичности бакета.
      // ВНИМАНИЕ: сначала КОНКРЕТНЫЙ бакет, потом список — иначе общий маршрут
      // перехватит и карточку бакета (путь «/storage/v1/buckets/site-bucket»
      // содержит в себе «/storage/v1/buckets»), и getBucketAccess прочитал бы
      // флаги из СПИСКА: publicAccess вечно выключен, а смена флага «не менялась».
      if (url.indexOf("/storage/v1/buckets/site-bucket") >= 0) {
        const one = plain(BUCKETS[0]);
        one.anonymousAccessFlags = plain(state.anonymous);
        if (req.method === "PATCH") {
          let sent = null;
          try { sent = JSON.parse(body.toString("utf8") || "{}"); } catch {}
          // Настоящий сервис без updateMask обнулил бы остальные поля бакета —
          // это полезно проверять: маска обязана быть, а её снятие должно ломать.
          if (!sent || !sent.updateMask) {
            state.anonymous = { read: false, list: false, configRead: false };
            return json({});
          }
          if (sent.anonymousAccessFlags) state.anonymous = plain(sent.anonymousAccessFlags);
          return json(one);
        }
        return json(one);
      }
      if (url.indexOf("/storage/v1/buckets") >= 0) return json({ buckets: plain(BUCKETS) });
      // Список объектов: настоящая форма ответа S3-совместимого API.
      if (url.indexOf("list-type=2") >= 0) {
        const rows = state.objects
          .map((o) => {
            const key = String(o.key).replace(/&/g, "&amp;").replace(/</g, "&lt;");
            return (
              "<Contents><Key>" + key + "</Key>" +
              (o.lastModified ? "<LastModified>" + o.lastModified + "</LastModified>" : "") +
              (o.etag ? "<ETag>&quot;" + o.etag + "&quot;</ETag>" : "") +
              "<Size>" + Number(o.size || 0) + "</Size></Contents>"
            );
          })
          .join("");
        return xml('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>site-bucket</Name>' + rows + "<IsTruncated>false</IsTruncated></ListBucketResult>");
      }
      const m = /^\/site-bucket\/(.+)$/.exec(url);
      if (m) {
        const key = decodeURIComponent(m[1]);
        if (req.method === "PUT") {
          state.objects = state.objects.filter((o) => o.key !== key).concat([{ key: key, size: body.length, etag: "new" }]);
          res.writeHead(200, { "Content-Type": "application/xml", ETag: '"etag-new"' });
          return res.end("");
        }
        if (req.method === "DELETE") {
          state.objects = state.objects.filter((o) => o.key !== key);
          res.writeHead(204);
          return res.end();
        }
        if (BODY[key] != null) {
          res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(Buffer.byteLength(BODY[key])) });
          return res.end(BODY[key]);
        }
        return noKey();
      }
      return json({});
    });
  });
  return new Promise((r) => {
    const reset = () => {
      state.objects = plain(SEED_OBJECTS);
      state.anonymous = { read: false, list: false, configRead: false };
    };
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

// ── Подменённый модуль облака для инструмента агента ───────────────────────
const TOOL_BUCKET = { id: "b1", name: "site-bucket", folderId: "f1" };

// Публичность бакета: по умолчанию закрыт — так он и создан в облаке. Состояние
// живёт ВНУТРИ подменённого облака, а не в общем объекте на файл модуля: иначе
// один набор (включил публичность) делал бы следующий «уже публичный» — и
// проверка закрытия валила бы не код, а память между наборами.
function fakeCloud(over) {
  const accessState = { publicRead: false };
  const calls = { listService: 0, list: [], put: [], get: [], del: [], access: [], accessSet: [] };
  const cloud = Object.assign(
    {
      S3_MAX_BYTES: 64 * 1024 * 1024,
      serviceByKey: () => ({ key: "storage", title: "Object Storage", svc: "storage-api", listPath: "/storage/v1/buckets", listKey: "buckets" }),
      listService: async () => {
        calls.listService++;
        return { count: 1, items: [TOOL_BUCKET] };
      },
      contentTypeFor: (key) => (/\.html$/.test(String(key)) ? "text/html; charset=utf-8" : "application/octet-stream"),
      objectPublicUrl: (b, k) => "https://storage.yandexcloud.net/" + b + "/" + String(k).replace(/^\/+/, ""),
      listBucketObjects: async (oauth, opts) => {
        calls.list.push(plain(opts));
        return {
          count: 2,
          truncated: false,
          prefix: opts.prefix || "",
          items: [
            { key: "index.html", size: 2048, lastModified: "2026-09-20T10:00:00.000Z" },
            { key: "a&b.txt", size: 10, lastModified: "2026-09-21T10:00:00.000Z" },
          ],
        };
      },
      putBucketObject: async (oauth, opts) => {
        const size = opts.body ? opts.body.length : 0;
        // Подменённое облако повторяет отказ НАСТОЯЩЕГО модуля (он проверен
        // выше, в [2], на живом HTTP): пустой объект в бакет не отправляется.
        if (!size) throw new Error("Пустое содержимое: объект нулевого размера не отправляем — в бакете появилась бы пустышка вместо файла.");
        calls.put.push({ bucket: opts.bucket, key: opts.key, size: size, text: String(opts.body) });
        return { bucket: opts.bucket, key: opts.key, size: size, etag: "e1", url: "https://storage.yandexcloud.net/" + opts.bucket + "/" + opts.key };
      },
      getBucketObject: async (oauth, opts) => {
        calls.get.push(plain(opts));
        return { bucket: opts.bucket, key: opts.key, body: Buffer.from("файл из облака", "utf8"), size: 26, contentType: "text/plain" };
      },
      deleteBucketObject: async (oauth, opts) => {
        calls.del.push(plain(opts));
        return { bucket: opts.bucket, key: opts.key };
      },
      getBucketAccess: async (oauth, bucket) => {
        calls.access.push(String(bucket));
        return { bucket: bucket, flags: { read: !!accessState.publicRead, list: false, configRead: false } };
      },
      setBucketPublicAccess: async (oauth, bucket, on) => {
        calls.accessSet.push({ bucket: bucket, on: !!on });
        accessState.publicRead = !!on;
        return { bucket: bucket, flags: { read: !!on, list: false, configRead: false }, public: !!on };
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
      workingDir: work,
      yandexOauthToken: "oauth-1",
      ycCloudId: "cloud-1",
      ycFolderId: "folder-1",
      ycFolderName: "prod",
      ycAllowAgentCreate: false,
      ycAllowAgentDelete: false,
      ycAllowAgentUpdate: false,
      ycAllowAgentPublic: false,
    },
    settingsOver || {}
  );
  const tools = createCloudTools({
    path: path,
    fs: fs,
    yandexCloud: cloud,
    resolvePath: (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(work, String(p))),
    agentWorkDir: () => work,
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
        allowPublic: !!st.ycAllowAgentPublic,
      };
    },
    loadSettings: () => settings,
  });
  return { tools, calls, settings };
}

(async () => {
  const stub = await startStorageStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Разбор ответов S3: XML, тип содержимого и открытый адрес");

  await test("ycStorage: список объектов разбирается из XML, экранирование снято", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
      "<Contents><Key>site/index.html</Key><LastModified>2026-09-20T10:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>1024</Size></Contents>" +
      "<Contents><Key>a&amp;b&lt;c.txt</Key><Size></Size></Contents>" +
      "<IsTruncated>true</IsTruncated></ListBucketResult>";
    const items = yandex.parseObjectList(xml);
    assert.strictEqual(items.length, 2, "разобрано не два объекта: " + JSON.stringify(plain(items)));
    assert.strictEqual(items[0].key, "site/index.html", "ключ прочитан неверно");
    assert.strictEqual(items[0].size, 1024, "размер прочитан неверно");
    assert.strictEqual(items[0].etag, "abc", "ETag оставлен в кавычках: " + items[0].etag);
    assert.strictEqual(items[0].lastModified, "2026-09-20T10:00:00.000Z", "дата прочитана неверно");
    assert.strictEqual(items[1].key, "a&b<c.txt", "экранирование ключа не снято: " + items[1].key);
    assert.strictEqual(items[1].size, 0, "пустой размер должен стать нулём: " + items[1].size);
    assert.ok(!JSON.stringify(items).includes("IsTruncated"), "служебные теги попали в объекты");
    // Форма самого запроса — часть контракта: у S3 нет JSON-варианта.
    const from = YC_SRC.indexOf("async function listBucketObjects(");
    assert.ok(from > 0, "нет функции listBucketObjects");
    const body = YC_SRC.slice(from, YC_SRC.indexOf("\n}\n", from));
    assert.ok(body.includes('"list-type=2&max-keys="'), "список запрашивается не в форме S3");
  });

  await test("ycStorage: тип содержимого берётся из расширения ключа", () => {
    assert.strictEqual(yandex.contentTypeFor("index.html"), "text/html; charset=utf-8");
    assert.strictEqual(yandex.contentTypeFor("site/assets/app.js"), "text/javascript; charset=utf-8");
    assert.strictEqual(yandex.contentTypeFor("a/b/logo.PNG"), "image/png", "верхний регистр расширения не учтён");
    assert.strictEqual(yandex.contentTypeFor("data.json"), "application/json; charset=utf-8");
    assert.strictEqual(yandex.contentTypeFor("noext"), "application/octet-stream");
    assert.strictEqual(yandex.contentTypeFor(""), "application/octet-stream");
    // У S3 нет «сам угадает»: заголовок ставит тот, кто кладёт файл.
    const from = YC_SRC.indexOf("async function putBucketObject(");
    const body = YC_SRC.slice(from, YC_SRC.indexOf("\n}\n", from));
    assert.ok(/contentType: o\.contentType \|\| contentTypeFor\(key\)/.test(body), "при загрузке тип содержимого не ставится");
  });

  await test("ycStorage: открытый адрес собирается без двойных слешей", () => {
    assert.strictEqual(yandex.objectPublicUrl("site-bucket", "/site/index.html"), "https://storage.yandexcloud.net/site-bucket/site/index.html");
    assert.strictEqual(yandex.objectPublicUrl("site-bucket", ""), "https://storage.yandexcloud.net/site-bucket/");
  });

  console.log("\n[2] Настоящие запросы к S3-совместимому API");

  await test("ycStorage: список читается у S3 и уходит БЕЗ подписи AWS (IAM-токеном)", async () => {
    stub.calls.length = 0;
    yandex.resetIamCache();
    const r = await yandex.listBucketObjects("oauth-1", { bucket: "site-bucket", prefix: "site/" });
    assert.strictEqual(r.count, 2, "объектов прочитано не два: " + JSON.stringify(plain(r.items)));
    assert.strictEqual(r.items[1].key, "a&b.txt", "экранированный ключ не раскодирован на живом ответе");
    const list = stub.calls.find((c) => c.url.indexOf("list-type=2") >= 0);
    assert.ok(list, "список не запрошен у S3: " + JSON.stringify(stub.calls.map((c) => c.method + " " + c.url)));
    assert.ok(/\/site-bucket\?/.test(list.url), "список запрошен не по бакету: " + list.url);
    assert.ok(/prefix=site%2F/.test(list.url), "префикс (папка) не ушёл в запрос: " + list.url);
    const auth = String(list.headers.authorization || "");
    assert.ok(/^Bearer /.test(auth), "запрос авторизован не IAM-токеном: " + auth.slice(0, 20));
    assert.ok(auth.indexOf("AWS4-HMAC") === -1 && auth.indexOf("AWS ") !== 0, "запрос подписан как AWS, а этого не нужно");
    assert.ok(!stub.calls.some((c) => (c.url || "").indexOf("X-Amz-Signature") >= 0), "в запросе появилась подпись AWS");
  });

  await test("ycStorage: загрузка уходит PUT по ключу-пути и возвращает адрес", async () => {
    stub.calls.length = 0;
    stub.reset();
    const r = await yandex.putBucketObject("oauth-1", { bucket: "site-bucket", key: "site/assets/app.js", body: "console.log(1)" });
    const put = stub.calls.find((c) => c.method === "PUT");
    assert.ok(put, "загрузка не ушла: " + JSON.stringify(stub.calls.map((c) => c.method + " " + c.url)));
    assert.ok(put.url.indexOf("/site-bucket/site/assets/app.js") >= 0, "ключ-путь собран неверно (слеши стали частью имени?): " + put.url);
    assert.strictEqual(put.body, "console.log(1)", "в облако ушло не то содержимое: " + put.body);
    assert.strictEqual(put.headers["content-type"], "text/javascript; charset=utf-8", "тип содержимого не поставлен по расширению");
    assert.strictEqual(r.size, 14, "размер в ответе неверен: " + r.size);
    assert.strictEqual(r.etag, "etag-new", "ETag из ответа не снят с кавычек: " + r.etag);
    assert.strictEqual(r.url, "https://storage.yandexcloud.net/site-bucket/site/assets/app.js");
    assert.ok(stub.state.objects.some((o) => o.key === "site/assets/app.js"), "файл не появился в бакете");
  });

  await test("ycStorage: пустое содержимое и пустой ключ не уходят в облако", async () => {
    stub.calls.length = 0;
    const empty = await yandex.putBucketObject("oauth-1", { bucket: "site-bucket", key: "empty.txt", body: "" }).then(() => null, (e) => e);
    assert.ok(empty && /Пустое содержимое/.test(empty.message), "пустой объект не отбит: " + (empty && empty.message));
    const noKey = await yandex.putBucketObject("oauth-1", { bucket: "site-bucket", key: "" }).then(() => null, (e) => e);
    assert.ok(noKey && /Не указан ключ объекта/.test(noKey.message), "пустой ключ не объяснён: " + (noKey && noKey.message));
    const noBucket = await yandex.putBucketObject("oauth-1", { bucket: "", key: "a.txt", body: "x" }).then(() => null, (e) => e);
    assert.ok(noBucket && /Не указан бакет/.test(noBucket.message), "пустой бакет не объяснён: " + (noBucket && noBucket.message));
    assert.strictEqual(stub.calls.filter((c) => c.method === "PUT").length, 0, "на пустых данных что-то ушло в облако");
  });

  await test("ycStorage: скачивание отдаёт настоящие байты, а отказ S3 — словами", async () => {
    const obj = await yandex.getBucketObject("oauth-1", { bucket: "site-bucket", key: "download.txt" });
    assert.strictEqual(obj.body.toString("utf8"), "файл из облака", "скачано не то: " + obj.body.toString("utf8"));
    assert.strictEqual(obj.size, 26, "размер скачанного неверен: " + obj.size);
    const missing = await yandex.getBucketObject("oauth-1", { bucket: "site-bucket", key: "нет-такого.txt" }).then(() => null, (e) => e);
    assert.ok(missing, "отказ S3 не вернулся ошибкой");
    assert.ok(/Такого объекта в бакете нет/.test(missing.message), "отказ S3 не объяснён словами: " + missing.message.slice(0, 120));
    assert.ok(missing.message.indexOf("<?xml") === -1, "человеку отдан XML вместо объяснения");
    const noKey = await yandex.getBucketObject("oauth-1", { bucket: "site-bucket", key: "/" }).then(() => null, (e) => e);
    assert.ok(noKey && /Не указан ключ объекта/.test(noKey.message), "пустой ключ не объяснён: " + (noKey && noKey.message));
  });

  await test("ycStorage: удаление идёт DELETE по своему ключу, пустой ключ не уходит", async () => {
    stub.calls.length = 0;
    const r = await yandex.deleteBucketObject("oauth-1", { bucket: "site-bucket", key: "old.txt" });
    assert.deepStrictEqual(plain(r), { bucket: "site-bucket", key: "old.txt" });
    const del = stub.calls.find((c) => c.method === "DELETE");
    assert.ok(del && del.url.indexOf("/site-bucket/old.txt") >= 0, "удаление ушло не по тому ключу: " + (del && del.url));
    const noKey = await yandex.deleteBucketObject("oauth-1", { bucket: "site-bucket", key: "" }).then(() => null, (e) => e);
    assert.ok(noKey && /Не указан ключ объекта/.test(noKey.message), "пустой ключ не объяснён: " + (noKey && noKey.message));
    assert.strictEqual(stub.calls.filter((c) => c.method === "DELETE").length, 1, "лишний DELETE ушёл в облако");
  });

  console.log("\n[3] Инструмент агента ycStorage");

  await test("ycStorage: разрешения и чужое действие — до всякой сети", async () => {
    const env = buildTools();
    const up = await env.tools.ycStorage({ action: "upload", file: "index.html", key: "index.html" }, {});
    assert.ok(/⛔/.test(up) && /создавать ресурсы/.test(up), "загрузка без разрешения не отбита: " + up.slice(0, 120));
    const del = await env.tools.ycStorage({ action: "delete", key: "index.html" }, {});
    assert.ok(/⛔/.test(del) && /удалять ресурсы/.test(del), "удаление без разрешения не отбито: " + del.slice(0, 120));
    assert.strictEqual(env.calls.put.length + env.calls.del.length, 0, "без разрешения что-то ушло в облако");
    assert.strictEqual(env.calls.listService, 0, "без разрешения пошли в облако за списком бакетов");
    const bad = await buildTools({}, { ycAllowAgentCreate: true }).tools.ycStorage({ action: "стереть" }, {});
    assert.ok(/неизвестное действие ycStorage/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 120));
    const noKey = await buildTools({}, { ycAllowAgentCreate: true }).tools.ycStorage({ action: "upload", content: "x" }, {});
    assert.ok(/укажи key/.test(noKey), "загрузка без ключа не объяснена: " + noKey.slice(0, 140));
  });

  await test("ycStorage: список показывает объекты, размер и открытый адрес", async () => {
    const env = buildTools();
    const out = await env.tools.ycStorage({ action: "list" }, {});
    assert.ok(/Бакет «site-bucket» \(b1\)/.test(out), "бакет не назван: " + out.slice(0, 140));
    assert.ok(/index\.html · 2 КБ/.test(out), "объект и его размер не показаны: " + out.slice(0, 240));
    assert.ok(/a&b\.txt/.test(out), "второй объект не показан: " + out.slice(0, 240));
    assert.ok(/Объекты: 2/.test(out), "число объектов не названо: " + out.slice(0, 200));
    assert.strictEqual(env.calls.list[0].bucket, "site-bucket", "список запрошен не по своему бакету: " + JSON.stringify(plain(env.calls.list)));
    assert.strictEqual(env.calls.list[0].prefix, "", "без префикса в облако ушёл лишний фильтр: " + JSON.stringify(plain(env.calls.list[0])));
    assert.ok(/storage\.yandexcloud\.net\/site-bucket\/index\.html/.test(out), "не назван открытый адрес объекта");
    assert.ok(/анонимное чтение/.test(out), "не сказано, когда адрес работает у других");
    assert.ok(/action: "download"/.test(out) && /action "upload"/.test(out) && /action "delete"/.test(out), "не сказано, что ещё можно делать: " + out.slice(-160));

    const pref = buildTools();
    const only = await pref.tools.ycStorage({ action: "list", prefix: "site/" }, {});
    assert.strictEqual(pref.calls.list[0].prefix, "site/", "префикс не дошёл до модуля облака");
    assert.ok(/по префиксу «site\/»/.test(only), "префикс не назван в ответе: " + only.slice(0, 140));
  });

  await test("ycStorage: загрузка файла — настоящий путь, вложенный ключ и честные отказы", async () => {
    fs.writeFileSync(path.join(work, "index.html"), "<h1>Привет</h1>");
    const env = buildTools({}, { ycAllowAgentCreate: true });
    const out = await env.tools.ycStorage({ action: "upload", file: "index.html", key: "site/index.html" }, {});
    assert.ok(/✅ Файл положили в облако из файла «index\.html»: site\/index\.html/.test(out), "загрузка не подтверждена: " + out.slice(0, 180));
    assert.strictEqual(env.calls.put[0].key, "site/index.html", "ключ объекта передан неверно: " + JSON.stringify(plain(env.calls.put[0])));
    assert.strictEqual(env.calls.put[0].text, "<h1>Привет</h1>", "содержимое файла не ушло: " + env.calls.put[0].text);
    assert.ok(/text\/html/.test(out), "тип содержимого не назван в ответе: " + out.slice(0, 180));
    assert.ok(/анонимное чтение/.test(out), "не сказано, что адрес откроется у других только с публичным доступом");

    const text = await env.tools.ycStorage({ action: "upload", key: "notes/hello.txt", content: "привет" }, {});
    assert.ok(/✅ Файл положили в облако: notes\/hello\.txt/.test(text), "загрузка текстом не сработала: " + text.slice(0, 160));
    assert.strictEqual(env.calls.put[1].text, "привет", "готовое содержимое ушло не то: " + env.calls.put[1].text);

    const beforeEmpty = env.calls.put.length;
    const empty = await env.tools.ycStorage({ action: "upload", key: "empty.txt", content: "" }, {});
    assert.ok(/Пустое содержимое/.test(empty), "пустой объект не отбит: " + empty.slice(0, 140));
    const noFile = await env.tools.ycStorage({ action: "upload", file: "нет-такого.html", key: "x.html" }, {});
    assert.ok(/файла «нет-такого\.html» нет/.test(noFile), "отсутствующий файл не назван: " + noFile.slice(0, 160));
    assert.strictEqual(env.calls.put.length, beforeEmpty, "на пустых данных загрузка всё равно ушла");
  });

  await test("ycStorage: скачивание кладёт объект на диск (и туда, куда просили)", async () => {
    const env = buildTools();
    const out = await env.tools.ycStorage({ action: "download", key: "download.txt", to: "из-облака/файл.txt" }, {});
    assert.ok(/✅ Объект скачан: download\.txt/.test(out), "скачивание не подтверждено: " + out.slice(0, 160));
    const saved = path.join(work, "из-облака", "файл.txt");
    assert.ok(fs.existsSync(saved), "файл не появился на диске: " + saved);
    assert.strictEqual(fs.readFileSync(saved, "utf8"), "файл из облака", "на диск записано не то");
    const byName = buildTools();
    const auto = await byName.tools.ycStorage({ action: "download", key: "a/b/download.txt" }, {});
    assert.ok(/→ .*download\.txt/.test(auto), "без «to» файл не назван: " + auto.slice(0, 160));
    assert.ok(fs.existsSync(path.join(work, "download.txt")), "без «to» файл не лёг в рабочую папку по имени объекта");
  });

  await test("ycStorage: бакет ищется по имени и по id, а чужое имя — честный ответ", async () => {
    const byId = buildTools();
    const out = await byId.tools.ycStorage({ action: "list", bucket: "b1" }, {});
    assert.ok(/Бакет «site-bucket» \(b1\)/.test(out), "бакет по id не найден: " + out.slice(0, 140));

    const many = buildTools({ listService: async () => ({ count: 2, items: [{ id: "b1", name: "site-bucket" }, { id: "b2", name: "backup" }] }) });
    const ambiguous = await many.tools.ycStorage({ action: "list" }, {});
    assert.ok(/Бакетов несколько/.test(ambiguous) && /backup/.test(ambiguous), "неоднозначность не объяснена: " + ambiguous.slice(0, 160));
    const wrong = await many.tools.ycStorage({ action: "list", bucket: "нет-такого" }, {});
    assert.ok(/Не нашёл бакет/.test(wrong) && /site-bucket/.test(wrong), "чужой бакет не перечисляет доступные: " + wrong.slice(0, 160));

    const none = buildTools({ listService: async () => ({ count: 0, items: [] }) });
    const empty = await none.tools.ycStorage({ action: "list" }, {});
    assert.ok(/Бакетов в каталоге/.test(empty) && /ycCreate/.test(empty), "пустой каталог не подсказывает создание бакета: " + empty.slice(0, 180));

    const blank = buildTools({ listBucketObjects: async () => ({ count: 0, truncated: false, items: [] }) });
    const noObjects = await blank.tools.ycStorage({ action: "list" }, {});
    assert.ok(/нет ни одного объекта/.test(noObjects) && /action: "upload"/.test(noObjects), "пустой бакет не подсказывает загрузку: " + noObjects.slice(0, 200));
  });

  await test("ycStorage: удаление уходит по своему бакету и ключу", async () => {
    const env = buildTools({}, { ycAllowAgentDelete: true });
    const out = await env.tools.ycStorage({ action: "delete", key: "old.txt" }, {});
    assert.ok(/🗑 Объект удалён: old\.txt/.test(out), "удаление не подтверждено: " + out.slice(0, 140));
    assert.deepStrictEqual(plain(env.calls.del[0]), { bucket: "site-bucket", key: "old.txt" }, "удаление ушло не за тем объектом: " + JSON.stringify(plain(env.calls.del)));
    assert.ok(/action: "list"/.test(out), "после удаления не предложено посмотреть, что осталось");
  });

  await test("ycStorage: без подключения и без каталога отвечает честно", async () => {
    const off = buildTools({}, { yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await off.tools.ycStorage({ action: "list" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({}, { ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycStorage({ action: "list" }, {})), "нет ответа про каталог");
  });

  console.log("\n[4] Панель: карточка бакета, канал и удаление с подтверждением");

  await test("ycStorage: обёртка панели требует бакет и ключ", async () => {
    stub.calls.length = 0;
    stub.reset();
    const r = await ycConsoleMain.deleteBucketObject("oauth-1", { bucket: "site-bucket", key: "old.txt" });
    assert.deepStrictEqual(plain(r), { ok: true, bucket: "site-bucket", key: "old.txt" }, "обёртка ответила не тем: " + JSON.stringify(plain(r)));
    const noBucket = await ycConsoleMain.deleteBucketObject("oauth-1", { key: "old.txt" }).then(() => null, (e) => e);
    assert.ok(noBucket && /бакета/.test(noBucket.message), "обёртка не требует бакет: " + (noBucket && noBucket.message));
    const noKey = await ycConsoleMain.deleteBucketObject("oauth-1", { bucket: "site-bucket" }).then(() => null, (e) => e);
    assert.ok(noKey && /Не указан объект/.test(noKey.message), "обёртка не требует ключ: " + (noKey && noKey.message));
  });

  await test("ycStorage: связь «Объекты» читается из S3 и видна в карточке бакета", async () => {
    stub.calls.length = 0;
    yandex.resetIamCache();
    const rel = (ycConsoleMain.RELATIONS.storage || []).find((r) => r.key === "objects");
    assert.ok(rel, "у бакета нет связи «Объекты» — карточка не покажет файлы");
    assert.strictEqual(rel.s3, true, "связь объектов не помечена как идущая в S3-совместимый API");
    const caps = ycConsoleMain.capabilities().find((c) => c.serviceKey === "storage");
    assert.ok(caps && caps.relations.some((r) => r.key === "objects"), "связь не доходит до возможностей карточки");
    const r = await ycConsoleMain.relationList("oauth-1", { serviceKey: "storage", relationKey: "objects", id: "b1", name: "site-bucket", folderId: "f1" });
    assert.strictEqual(r.ok, true, "связь не прочиталась: " + r.error);
    assert.deepStrictEqual(plain(r.columns.map((c) => c.key)), ["key", "size", "lastModified"], "колонки таблицы не те: " + JSON.stringify(plain(r.columns)));
    assert.ok(r.rows[0][0].indexOf("index.html") >= 0, "объект не показан в таблице: " + JSON.stringify(plain(r.rows)));
    assert.ok(/2 КБ/.test(r.rows[0][1]), "размер объекта не показан по-человечески: " + r.rows[0][1]);
    assert.strictEqual(r.count, 2, "число объектов неверно: " + r.count);
    const list = stub.calls.find((c) => c.url.indexOf("list-type=2") >= 0);
    assert.ok(list && /\/site-bucket\?/.test(list.url), "карточка спросила объекты не у S3: " + JSON.stringify(stub.calls.map((c) => c.method + " " + c.url)));

    // Отказ S3 не должен выглядеть как «в бакете пусто»: человеку нужна причина.
    const bad = await ycConsoleMain.relationList("oauth-1", { serviceKey: "storage", relationKey: "objects", id: "b1", name: "", folderId: "f1" });
    assert.strictEqual(bad.ok, false, "пустое имя бакета выдалось за пустой бакет");
    assert.ok(/Не указан бакет/.test(bad.error || ""), "причина отказа не названа: " + bad.error);
  });

  await test("ycStorage: канал IPC, проброс в окно и запрет телефону", () => {
    assert.ok(IPC_SRC.includes('ipcMain.handle("yc:console:storageObject"'), "нет канала удаления объекта");
    assert.ok(/ycConsole\.deleteBucketObject\(cfg\.oauth,/.test(IPC_SRC), "канал не зовёт удаление объекта");
    assert.ok(PRELOAD_SRC.includes('ycConsoleStorageObject: (args) => ipcRenderer.invoke("yc:console:storageObject", args || {})'),
      "preload не пробрасывает удаление объекта в окно");
    const from = IPC_SRC.indexOf("// Файлы в бакете из карточки бакета");
    assert.ok(from > 0, "канал удаления объекта не подписан");
    const handler = IPC_SRC.slice(from, IPC_SRC.indexOf("yc:resources", from));
    assert.ok(handler.indexOf("allowCreate") === -1 && handler.indexOf("allowDelete") === -1,
      "удаление объекта из панели закрыто разрешением агента");
    assert.ok(/Неизвестная операция с объектом/.test(handler), "чужой op не отвергается");
    // Файлы облака с телефона не трогаем: платные ресурсы — только с ПК.
    const phone = MOBILE_SRC.slice(MOBILE_SRC.indexOf("const NOT_FOR_PHONE"));
    assert.ok(/\["yc:console:storageObject"/.test(phone), "канал удаления объекта не закрыт телефону");
    // И его нет среди разрешённых: телефону платные ресурсы не отдаём.
    const allow = MOBILE_SRC.slice(MOBILE_SRC.indexOf("const ALLOW"), MOBILE_SRC.indexOf("const NOT_FOR_PHONE"));
    assert.ok(allow.indexOf("yc:console:storageObject") === -1, "канал удаления объекта попал в разрешённые телефону");
    assert.ok(allow.indexOf("yc:console:") === -1, "телефону отданы каналы консоли облака");
  });

  await test("ycStorage: в таблице объектов есть удаление — с вопросом ПЕРЕД удалением", () => {
    assert.ok(/canDeleteObject/.test(CONSOLE_UI_SRC), "нет признака удаляемой таблицы объектов");
    assert.ok(CONSOLE_UI_SRC.includes('state.serviceKey === "storage" && d.key === "objects"'),
      "удаление объектов не привязано к таблице объектов бакета");
    const from = CONSOLE_UI_SRC.indexOf("if (canDeleteObject) {");
    const to = CONSOLE_UI_SRC.indexOf("if (canRollback) {", from);
    assert.ok(from > 0 && to > from, "блок удаления объекта не найден");
    const block = CONSOLE_UI_SRC.slice(from, to);
    assert.ok(block.indexOf('apiCall("ycConsoleStorageObject"') > 0, "кнопка не вызывает канал удаления объекта");
    // Проверяем ПОРЯДОК, а не упоминание: вопрос обязан стоять на пути к удалению.
    // (Урок части 46: контроль со снятым стражем `window.uiConfirm` набор не ловил,
    // потому что спрашивал «имя есть в файле», а не «решение стоит на пути».)
    const gateAt = block.indexOf('typeof window.uiConfirm === "function"');
    const goAt = block.indexOf("go()");
    assert.ok(gateAt > 0, "удаление объекта не спрашивает подтверждение у панели");
    assert.ok(goAt > gateAt, "объект удаляется раньше подтверждения — один клик, без вопроса");
    assert.ok(block.indexOf("window.confirm(") > gateAt, "нет запасного вопроса, если панель его не дала");
    assert.ok(/window\.uiConfirm = confirmModal;/.test(SIDE_PANEL_SRC), "панель не отдаёт подтверждение наружу");
    assert.ok(/confirmModal: \(\.\.\.a\) => ProjectPanel\.confirmModal\(\.\.\.a\)/.test(APP_SRC), "оболочка не передаёт подтверждение в панель");
    assert.ok(/вернуть его будет нельзя/.test(block), "в подтверждении не сказано, что объект не вернуть");
    assert.ok(/btn-danger/.test(block), "удаление объекта не выглядит опасным (btn-danger)");
    assert.ok(CONSOLE_CSS.includes(".ykc-actions"), "в стилях нет колонки действий");
  });

  console.log("\n[5] Согласованность: схема, промпт, политика, справочник, smoke");

  // ── Публичный доступ к бакету ─────────────────────────────────────────────
  console.log("\n[5] Публичный доступ к бакету: прочитать, открыть, закрыть");

  await test("публичность: чтение и PATCH идут в КОНСОЛЬНЫЙ API, с updateMask", async () => {
    stub.reset();
    const off = await yandex.getBucketAccess("oauth-1", "site-bucket");
    assert.deepStrictEqual(plain(off.flags), { read: false, list: false, configRead: false },
      "новый бакет прочитан не как закрытый: " + JSON.stringify(plain(off)));
    const on = await yandex.setBucketPublicAccess("oauth-1", "site-bucket", true);
    assert.strictEqual(on.public, true, "публичность не включилась: " + JSON.stringify(plain(on)));
    const patch = stub.calls.filter((c) => c.method === "PATCH" && /\/storage\/v1\/buckets\/site-bucket/.test(c.url));
    assert.strictEqual(patch.length, 1, "PATCH к бакету не ушёл: " + JSON.stringify(plain(stub.calls.map((c) => c.method + " " + c.url))));
    const sent = JSON.parse(patch[0].body);
    assert.strictEqual(sent.updateMask, "anonymousAccessFlags",
      "нет updateMask — сервис обнулит остальные поля бакета: " + JSON.stringify(sent));
    assert.deepStrictEqual(sent.anonymousAccessFlags, { read: true, list: false, configRead: false },
      "включён не только read (перечисление файлов анонимно — лишняя утечка): " + JSON.stringify(sent));
    // Права бакета — консольный API, а не S3-совместимый: там нужен был бы
    // заголовок X-Amz-Acl и подпись запроса, которой у приложения нет.
    assert.ok(!/storage\.yandexcloud\.net/.test(patch[0].url), "PATCH ушёл в S3-совместимый API: " + patch[0].url);
    assert.ok(/^Bearer /.test(String(patch[0].headers.authorization || "")), "PATCH ушёл без IAM-токена");
    await yandex.setBucketPublicAccess("oauth-1", "site-bucket", false);
    assert.strictEqual((await yandex.getBucketAccess("oauth-1", "site-bucket")).flags.read, false, "бакет не закрылся обратно");
    // Бакет без имени не отправляем в сеть.
    let ref = "";
    try { await yandex.setBucketPublicAccess("oauth-1", "", true); } catch (e) { ref = e.message; }
    assert.ok(/Не указан бакет/.test(ref), "пустой бакет не отвергнут: " + ref);
  });

  await test("публичность: смена флага ПРОВЕРЯЕТСЯ перечитыванием, а не фактом отправки", async () => {
    // Облако, которое ПРИНЯЛО запрос, но флаг не выставило (нет роли на бакете).
    const liar = {
      getBucketAccess: async () => ({ bucket: "site-bucket", flags: { read: false, list: false, configRead: false } }),
    };
    const from = YC_SRC.indexOf("async function setBucketPublicAccess(");
    assert.ok(from > 0, "нет функции setBucketPublicAccess");
    const body = YC_SRC.slice(from, YC_SRC.indexOf("\n}\n", from));
    const checkAt = body.indexOf("getBucketAccess");
    const throwAt = body.indexOf("throw e");
    assert.ok(checkAt > 0, "результат PATCH не перечитывается — «сделал публичным» может остаться обещанием");
    assert.ok(throwAt > checkAt, "отказ бросается до проверки результата");
    assert.ok(/storage\.admin|storage\.editor/.test(body), "в отказе не сказано, какая роль нужна");
    assert.ok(liar.getBucketAccess, "подмена приготова");
  });

  await test("публичность: агент спрашивает разрешение ДО сети и не требует key", async () => {
    const env = buildTools();
    const pub = await env.tools.ycStorage({ action: "public" }, {});
    assert.ok(/⛔/.test(pub) && /делать бакет публичным/.test(pub), "открытие без разрешения не отбито: " + pub.slice(0, 160));
    const priv = await env.tools.ycStorage({ action: "private" }, {});
    assert.ok(/⛔/.test(priv), "закрытие без разрешения не отбито: " + priv.slice(0, 160));
    assert.strictEqual(env.calls.accessSet.length, 0, "без разрешения флаги бакета менялись");
    assert.strictEqual(env.calls.listService, 0, "без разрешения пошли в облако вообще");
    // Ключ объекта для public/private не нужен — права у всего бакета.
    const on = buildTools({}, { ycAllowAgentPublic: true });
    const out = await on.tools.ycStorage({ action: "public" }, {});
    assert.ok(!/укажи key/.test(out), "public требует key объекта: " + out.slice(0, 160));
    assert.deepStrictEqual(on.calls.accessSet, [{ bucket: "site-bucket", on: true }], "флаг меняется не по тому бакуту: " + JSON.stringify(plain(on.calls.accessSet)));
  });

  await test("публичность: ответ говорит, что именно станет видно, и как вернуть обратно", async () => {
    const env = buildTools({}, { ycAllowAgentPublic: true });
    const out = await env.tools.ycStorage({ action: "public" }, {});
    assert.ok(/открыт для чтения из интернета/i.test(out), "не сказано, что бакет открыт: " + out.slice(0, 200));
    assert.ok(/ПОИСКОВИКАМ|поисковикам/i.test(out), "не сказано про поисковики: " + out.slice(0, 320));
    assert.ok(/https:\/\/storage\.yandexcloud\.net\/site-bucket\/index\.html/.test(out), "не показан рабочий адрес: " + out.slice(0, 400));
    assert.ok(/action: "private"/.test(out), "не сказано, как закрыть обратно: " + out.slice(0, 400));
    assert.ok(/Lockbox/.test(out), "не сказано, куда класть закрытые данные: " + out.slice(0, 400));
    // Перечисление содержимого анонимно остаётся выключенным — и это сказано.
    assert.ok(/Перечисление содержимого анонимно: выкл/.test(out), "не сказано, что список файлов закрыт: " + out.slice(0, 400));
    const back = await env.tools.ycStorage({ action: "private" }, {});
    assert.ok(/снова закрыт/i.test(back), "закрытие не отчиталось: " + back.slice(0, 200));
    assert.ok(/403/.test(back), "не сказано, что будет с ссылками: " + back.slice(0, 300));
  });

  await test("публичность: «уже публичный» — честный ответ, а не лишняя смена", async () => {
    const env = buildTools({}, { ycAllowAgentPublic: true });
    await env.tools.ycStorage({ action: "public" }, {});
    const again = await env.tools.ycStorage({ action: "public" }, {});
    assert.ok(/уже публичный/.test(again), "повтор не отмечен как пустое действие: " + again.slice(0, 160));
    assert.strictEqual(env.calls.accessSet.length, 1, "состояние менялось повторно без нужды: " + JSON.stringify(plain(env.calls.accessSet)));
  });

  await test("публичность: карточка бакета показывает состояние и спрашивает перед сменой", async () => {
    assert.ok(/ycConsoleBucketAccess/.test(CONSOLE_UI_SRC), "карточка бакета не читает публичный доступ");
    assert.ok(/bucketAccessBox/.test(CONSOLE_UI_SRC), "нет блока публичного доступа в карточке");
    assert.ok(/apiCall\("ycConsoleBucketAccess", \{ op: "get"/.test(CONSOLE_UI_SRC), "состояние не читается при открытии карточки");
    assert.ok(/state\.serviceKey === "storage" && item\.name/.test(CONSOLE_UI_SRC), "блок показан не только для бакета");
    assert.ok(/Открыть бакет/.test(CONSOLE_UI_SRC) && /Закрыть бакет/.test(CONSOLE_UI_SRC), "нет обеих кнопок");
    // Открытие бакета — это отдача файлов наружу: вопрос ПЕРЕД сменой, как у удаления.
    const from = CONSOLE_UI_SRC.indexOf("function bucketAccessBox(");
    assert.ok(from > 0, "нет функции блока");
    const body = CONSOLE_UI_SRC.slice(from, CONSOLE_UI_SRC.indexOf("\n  }", from));
    // Проверяем ПУТЬ, а не порядок строк (урок части 46 в применении к себе):
    // смена объявлена раньше вопроса — так и работает правильная развязка
    // (функция go описана, а вызвать её можно только из подтверждения), и
    // «op: set» раньше «uiConfirm» НЕ значит «мимо вопроса». Значит спрашиваем
    // другое: смена живёт внутри go, и ни одного её вызова ДО вопроса нет.
    const goAt = body.indexOf("const go = async () =>");
    const setAt = body.indexOf('op: "set"');
    const gateAt = body.indexOf("uiConfirm");
    assert.ok(goAt > 0, "смены флага нет отдельной функцией");
    assert.ok(setAt > goAt, "смена флага объявлена вне функции смены");
    assert.ok(gateAt > 0, "смена флага идёт без вопроса панели");
    const goCalls = body.match(/\bgo\(\)/g) || [];
    assert.ok(goCalls.length > 0, "функция смены нигде не вызывается");
    assert.ok(body.indexOf("go()") > gateAt, "функция смены вызывается ДО вопроса — мимо подтверждения");
    assert.ok(/ПОИСКОВИКАМ|поисковикам/i.test(body), "в вопросе не сказано про поисковики");
    assert.ok(/403/.test(body), "в вопросе о закрытии не сказано про отказ по ссылке");
    // Стили блока есть, иначе он съехал бы в общий поток.
    assert.ok(/\.ykc-access/.test(CONSOLE_CSS), "нет стилей блока публичного доступа");
  });

  await test("публичность: канал IPC, разрешение агента и запрет телефону", () => {
    assert.ok(IPC_SRC.includes('ipcMain.handle("yc:console:bucketAccess"'), "нет канала публичного доступа");
    assert.ok(/ycConsole\.setBucketPublicAccess\(cfg\.oauth,/.test(IPC_SRC), "канал не зовёт смену флага");
    assert.ok(PRELOAD_SRC.includes('ycConsoleBucketAccess: (args) => ipcRenderer.invoke("yc:console:bucketAccess", args || {})'),
      "preload не пробрасывает канал в окно");
    const from = IPC_SRC.indexOf("// Публичный доступ к бакету из карточки бакета");
    assert.ok(from > 0, "канал публичного доступа не подписан");
    const handler = IPC_SRC.slice(from, IPC_SRC.indexOf("yc:resources", from));
    // Как и удаление объекта, действие человека в своём окне: галочки ограничивают
    // модель, а не человека, который сам нажал кнопку (и ответил на вопрос).
    assert.ok(handler.indexOf("allowPublic") === -1, "публичность из панели закрыта разрешением агента");
    assert.ok(/Неизвестная операция с бакетом/.test(handler), "чужой op не отвергается");
    assert.ok(/Не указано, делать бакет публичным/.test(handler), "без public не сказано, что это за op");
    const phone = MOBILE_SRC.slice(MOBILE_SRC.indexOf("const NOT_FOR_PHONE"));
    assert.ok(/\["yc:console:bucketAccess"/.test(phone), "канал публичного доступа не закрыт телефону");
    const allow = MOBILE_SRC.slice(MOBILE_SRC.indexOf("const ALLOW"), MOBILE_SRC.indexOf("const NOT_FOR_PHONE"));
    assert.ok(allow.indexOf("yc:console:") === -1, "телефону отданы каналы консоли облака");
  });

  await test("публичность: отдельное разрешение в настройках — и оно про галочку", () => {
    const html = read("src", "renderer", "index.html");
    assert.ok(html.includes('id="s-yc-allow-public"'), "нет чекбокса публичного доступа");
    assert.ok(/Разрешить агенту делать бакет публичным/.test(html), "чекбокс назван не тем, что разрешает");
    assert.ok(/выключено по умолчанию/i.test(html.split('id="s-yc-allow-public"')[1].slice(0, 400)),
      "не сказано, что по умолчанию выключено");
    // Четыре чекбокса — один вызов: забытое поле молча сбросило бы разрешение.
    const panel = read("src", "renderer", "yc-panel.js");
    assert.ok(/api\.ycSetPermissions\(create, del, upd, pub\)/.test(panel), "четвёртое разрешение не сохраняется");
    const save = panel.slice(panel.indexOf("function saveYcPerms("), panel.indexOf("function saveYcPerms(") + 420);
    assert.ok(/allow-public/.test(save), "новый чекбокс не читается при сохранении");
    assert.ok(/s-yc-allow-public"\)\.checked/.test(panel), "состояние нового чекбокса не показывается при открытии настроек");
    assert.ok(PRELOAD_SRC.includes("ycSetPermissions: (allowCreate, allowDelete, allowUpdate, allowPublic)"),
      "preload не передаёт четвёртое разрешение");
    assert.ok(/ipcMain\.handle\("yc:setPermissions", \(_e, allowCreate, allowDelete, allowUpdate, allowPublic\)/.test(IPC_SRC),
      "канал не принимает четвёртое разрешение");
    assert.ok(/ycAllowAgentPublic: !!allowPublic/.test(IPC_SRC), "разрешение не сохраняется на диск");
    const cfg = read("src", "yc-service.js");
    assert.ok(/allowPublic: !!s\.ycAllowAgentPublic/.test(cfg), "разрешение не доходит до инструментов агента");
  });

  await test("публичность: схема, промпт и справочник учат правила и границу", () => {
    const from = SCHEMAS_SRC.indexOf('name: "ycStorage"');
    assert.ok(from > 0, "в схеме нет ycStorage");
    const body = SCHEMAS_SRC.slice(from, from + 3200);
    assert.ok(/public \| private/.test(body), "в схеме не названы новые действия");
    assert.ok(/list \| upload \| download \| delete \| public \| private/.test(body), "в параметре action нет новых действий");
    assert.ok(/Разрешить агенту делать бакет публичным/.test(body), "в схеме не названо нужное разрешение");
    assert.ok(/только по явной просьбе пользователя/i.test(body), "в схеме нет правила «только по просьбе»");
    assert.ok(/ПОИСКОВИКАМ|поисковикам/i.test(body), "в схеме не сказано про поисковики");
    // Промпт — место, где агент читает запрет до того, как возьмётся за инструмент.
    assert.ok(/action list\/upload\/download\/delete\/public\/private/.test(PROMPTS_SRC), "промпт не знает новых действий");
    assert.ok(/ТОЛЬКО по явной просьбе/.test(PROMPTS_SRC), "промпт не запрещает открывать бакет самовольно");
    assert.ok(/публичный доступ на чтение включай action public/.test(PROMPTS_SRC), "промпт не велит включать публичность по просьбе");
    // Справочник.
    assert.ok(/`public` \/ `private` — открыть бакет/.test(GUIDE_SRC), "в yc.md нет новых действий");
    assert.ok(/Правило для `public`/.test(GUIDE_SRC), "в yc.md нет правила про публичность");
    assert.ok(/видно ПОИСКОВИКАМ/.test(GUIDE_SRC), "в yc.md не сказано про поисковики");
    assert.ok(/в консоли облака \(в приложении этой галочки пока нет\)/.test(GUIDE_SRC) === false,
      "yc.md всё ещё обещает отсутствие галочки — она уже есть");
  });

  await test("публичность: канал назван в smoke-наборе рядом с каналом объектов", () => {
    assert.ok(SMOKE_SRC.includes('"yc:console:bucketAccess"'), "новый канал не назван в smoke-наборе");
    const list = SMOKE_SRC.slice(SMOKE_SRC.indexOf('for (const n of ["ycStatus"'), SMOKE_SRC.indexOf('for (const n of ["ycStatus"') + 340);
    assert.ok(/"ycStorage"/.test(list), "инструмента нет в списке инструментов smoke-набора");
  });

  await test("ycStorage: схема, группа облака, промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycStorage"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    // Окно схемы — до закрывающих скобок параметров, а не «сколько попалось»:
    // описание выросло (публичность), и required уехал за прежние 2200 символов.
    const schema = SCHEMAS_SRC.slice(at, SCHEMAS_SRC.indexOf("\n  },\n", at));
    for (const part of ["action", "bucket", "key", "file", "content", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/list/.test(schema) && /upload/.test(schema) && /download/.test(schema) && /delete/.test(schema), "схема не называет действия");
    assert.ok(/создавать ресурсы/.test(schema) && /удалять ресурсы/.test(schema), "схема не называет разрешения");
    assert.ok(/публичный доступ/.test(schema), "схема не предупреждает про публичный доступ к бакету");
    const group = CORE_SRC.slice(CORE_SRC.indexOf('id: "cloud"'), CORE_SRC.indexOf('id: "cloud"') + 700);
    assert.ok(/ycStorage/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycStorage/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycStorage \(файлы в бакете Object Storage/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycStorage");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 320).includes('"ycStorage"'), "нет назначения cloud.read для ycStorage");
  });

  await test("ycStorage: справочник агента учит работать с бакетом и не обещать ссылку", () => {
    assert.ok(/\`ycStorage \{ action/.test(GUIDE_SRC), "в yc.md нет ycStorage");
    assert.ok(/list\` — что лежит|list\` —/.test(GUIDE_SRC), "в yc.md не сказано, что делает list");
    assert.ok(/cоздавать ресурсы|создавать ресурсы/.test(GUIDE_SRC), "в yc.md не названы разрешения");
    assert.ok(/публичный доступ на чтение/.test(GUIDE_SRC), "в yc.md не сказано про публичный доступ к бакету");
  });

  await test("ycStorage: набор и канал не выпадают из smoke-набора", () => {
    assert.ok(SMOKE_SRC.includes('"yc:console:storageObject"'), "канал удаления объекта не назван в smoke-наборе");
    const list = SMOKE_SRC.slice(SMOKE_SRC.indexOf("for (const n of [\"ycStatus\""), SMOKE_SRC.indexOf("for (const n of [\"ycStatus\"") + 340);
    assert.ok(/\"ycStorage\"/.test(list), "инструмента нет в списке инструментов smoke-набора");
  });

  await test("ycStorage: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-storage.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {}
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

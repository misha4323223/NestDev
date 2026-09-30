"use strict";

/* ── Яндекс AI: перевод, текст с картинки и речь (SpeechKit) ──────────────────
   Запуск: node test/yc-ai.test.js   (входит в общий `npm test`)

   Зачем набор. Облако умеет четыре вещи, которых в приложении не было ни одной:
   перевести текст, вытащить текст со снимка, озвучить ответ и расшифровать
   запись. Живут они на ЧЕТЫРЁХ разных хостах и с разными формами запроса —
   JSON у Translate и Vision, urlencoded-форма и ДВОИЧНЫЙ ответ у SpeechKit v1, —
   и ошибиться в любой из форм легко, а заметить это без набора нечем.

   Что проверяется:
     • авторизация и каталог уходят на все четыре сервиса (Bearer + x-folder-id);
     • перевод: МАССИВ языков = пачка запросов, у каждого свой целевой язык, а
       строки едут одним запросом; язык источника подставляется, только если задан;
     • справочник языков и голоса: из облака, а при его отказе — проверенный
       запасной список (подсказка не должна пропадать вместе с сетью);
     • OCR: защитный разбор ответа (полный текст ИЛИ строки блоков), модель и
       языки по умолчанию;
     • речь: форма TTS со всеми полями и двоичным ответом, запрос STT со строкой
       параметров и телом-звуком; честные отказы на lpcm без частоты;
     • инструмент ycAi: каталог и токен обязательны, чужие действия отвергаются,
       пределы 10 МБ (картинка) и 1 МБ (звук) держатся ДО запроса, озвучка пишет
       настоящие файлы, а картинки и записи ищутся по рабочей папке;
     • согласованность: схема, группа промпта, политика прав, справочник yc.md,
       список smoke-набора, адреса сервисов и цепочка npm test;
     • ИНТЕРФЕЙС (часть 87): семейство действий в src/renderer/yc-actions.js и
       канал «yc:ai» через НАСТОЯЩИЙ registerYcIpc с подменённым окном — перевод
       пачкой языков, снимок с диска, речь с проигрыванием и расшифровка записи,
       а также вход в действия из панели облака;
     • AI STUDIO (часть 90): список моделей каталога (с запасным списком при
       молчании облака), ответ модели с разбором `alternatives` и `usage`,
       БЕСПЛАТНЫЙ счёт токенов и вектор текста — в модуле, в инструменте ycAi и
       в канале «yc:ai»; тарифы считаются до запроса и после ответа.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а файлы живут во временной папке. */

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

const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
const { createYcAi, VOICES, AI_MODELS, modelNameOf, modelUriFor, aiPriceFor, aiPriceLine, aiCostText } = require(path.join(ROOT, "src", "yc-ai.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const ACTIONS_CSS = read("src", "renderer", "yc-actions.css");
const PANEL_SRC = read("src", "renderer", "yc-panel.js");
const PRELOAD_SRC = read("src", "preload.js");
const HTML_SRC = read("src", "renderer", "index.html");
const IPC_SRC = read("src", "yc-ipc.js");
const ACTIONS_TEST_SRC = read("test", "yc-actions.test.js");
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke", "03-cloud.js");
const MAIN_SRC = read("src", "main.js");
const YC_SRC = read("src", "yandex-cloud.js");
const PKG = JSON.parse(read("package.json"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "yc-ai-"));

// ── Подменённое облако Яндекс AI ────────────────────────────────────────────
// Отвечает на те же адреса и в тех же формах, что настоящие сервисы: JSON у
// перевода и зрения, форма у синтеза речи, ДВОИЧНЫЙ ответ у звука. Форма ответа
// Vision менялась — поэтому стенд умеет отвечать и полным текстом, и строками
// блоков: разбор проверяется на обеих.
function startAiStub() {
  const calls = [];
  let voicesFail = false;
  let modelsFail = false;
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts);
      const url = req.url || "";
      calls.push({ method: req.method, url: url, headers: req.headers, body: raw.toString("utf8"), bytes: raw.length });
      const json = (o, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (url.indexOf("/translate/v2/translate") >= 0) {
        const b = JSON.parse(raw.toString("utf8") || "{}");
        return json({
          translations: (b.texts || []).map((t) => ({ text: "[" + b.targetLanguageCode + "] " + t, detectedLanguageCode: b.sourceLanguageCode || "ru" })),
        });
      }
      if (url.indexOf("/translate/v2/detect") >= 0) return json({ languageCode: "ru" });
      if (url.indexOf("/translate/v2/languages") >= 0) return json({ languages: [{ code: "ru", name: "Русский" }, { code: "en", name: "English" }] });
      if (url.indexOf("/ocr/v1/recognizeText") >= 0) {
        const b = JSON.parse(raw.toString("utf8") || "{}");
        if (b.model === "table") {
          // Только строки блоков: полного текста в ответе нет вовсе.
          return json({ result: { textAnnotation: { blocks: [{ lines: [{ text: "Строка 1" }] }, { lines: [{ text: "Строка 2" }] }] } } });
        }
        return json({ result: { textAnnotation: { width: "10", height: "10", fullText: "РАСПОЗНАНО: " + String(b.content || "").slice(0, 4) } } });
      }
      if (url.indexOf("tts:synthesize") >= 0) {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        return res.end(Buffer.from([1, 2, 3, 4, 5]));
      }
      if (url.indexOf("stt:recognize") >= 0) return json({ result: "распознанный текст" });
      if (url.indexOf("/tts/v3/voices") >= 0) {
        if (voicesFail) return json({ message: "Not found" }, 404);
        return json({ voices: [{ id: "alena", name: "Алёна", languages: ["ru-RU"] }, { id: "filipp", name: "Филипп", languages: ["ru-RU"] }] });
      }
      // ── AI Studio: список моделей, ответ, токены и вектор ──
      // Формы те же, что у живого облака: модели — OpenAI-совместимый `data`,
      // ответ — `result.alternatives[0].message.text` и `usage`, токены —
      // массив с текстом/номером, вектор — `embedding` из 256 чисел.
      if (url.indexOf("/v1/models") >= 0) {
        if (modelsFail) return json({ message: "Not found" }, 404);
        return json({
          data: [
            { id: "yandexgpt-5-lite", owned_by: "yandex", kind: "текст" },
            { id: "text-search-doc", owned_by: "yandex" },
          ],
        });
      }
      if (url.indexOf("/foundationModels/v1/completion") >= 0) {
        const b = JSON.parse(raw.toString("utf8") || "{}");
        return json({
          result: {
            alternatives: [{ message: { text: "Ответ модели: " + (b.messages || []).map((m) => m.text).join(" | ") }, status: "ALTERNATIVE_STATUS_FINAL" }],
            usage: { inputTextTokens: "1200", completionTokens: "400", totalTokens: "1600" },
            modelVersion: "v5.1",
          },
        });
      }
      if (url.indexOf("/foundationModels/v1/tokenizeCompletion") >= 0) {
        return json({ tokens: [{ text: "При" }, { text: "вет" }, { id: 42 }] });
      }
      if (url.indexOf("/foundationModels/v1/textEmbedding") >= 0) {
        return json({ embedding: Array.from({ length: 256 }, (_, i) => (i + 1) / 1000) });
      }
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () =>
      r({
        server: server,
        calls: calls,
        base: "http://127.0.0.1:" + server.address().port,
        setVoicesFail: (v) => {
          voicesFail = !!v;
        },
        setModelsFail: (v) => {
          modelsFail = !!v;
        },
      })
    );
  });
}

// Модуль собирается ОДИН раз — как в main.js: он держит кэш IAM-токена, и второй
// экземпляр ходил бы за токеном лишний раз.
const ai = createYcAi({
  fetchJson: yandex._fetchJson,
  endpoint: yandex.endpoint,
  getIamToken: yandex.getIamToken,
  serviceError: yandex.serviceError,
  isNetworkError: yandex.isNetworkError,
});

function settingsFor(over) {
  return Object.assign(
    { yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "folder-1", ycFolderName: "prod" },
    over || {}
  );
}

function buildTools(settingsOver) {
  const settings = settingsFor(settingsOver);
  const tools = createCloudTools({
    path: path,
    fs: fs,
    yandexCloud: yandex,
    ycAi: ai,
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
    // Файлы ищутся от временной рабочей папки — как в приложении от рабочей
    // папки агента: путь проверяется ДО чтения файла.
    resolvePath: (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(work, String(p))),
    agentWorkDir: () => work,
  });
  return { tools: tools, settings: settings };
}

const callsTo = (stub, part) => stub.calls.filter((c) => c.url.indexOf(part) >= 0);

(async () => {
  const stub = await startAiStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Авторизация и адреса четырёх сервисов");

  await test("ycAi: на все четыре сервиса уходит IAM-токен и каталог", async () => {
    const from = stub.calls.length;
    await ai.translate("oauth-1", { texts: ["Привет"], targets: ["en"], folderId: "folder-1" });
    await ai.recognizeText("oauth-1", { content: Buffer.from("PNG!").toString("base64"), mimeType: "image/png", folderId: "folder-1" });
    await ai.synthesize("oauth-1", { text: "Привет", voice: "alena", folderId: "folder-1" });
    await ai.recognizeSpeech("oauth-1", { audio: Buffer.from([1, 2, 3]), folderId: "folder-1" });
    const sent = stub.calls.slice(from).filter((c) => c.url.indexOf("/iam/") === -1);
    assert.strictEqual(sent.length, 4, "улетело не четыре запроса: " + sent.length);
    for (const c of sent) {
      assert.strictEqual(c.headers.authorization, "Bearer iam-test", "нет IAM-токена у " + c.url);
      assert.strictEqual(c.headers["x-folder-id"], "folder-1", "нет каталога у " + c.url);
    }
  });

  console.log("\n[2] Перевод: несколько языков сразу");

  await test("ycAi: каждый целевой язык — свой запрос, строки — одним", async () => {
    const from = callsTo(stub, "/translate/v2/translate").length;
    const out = await ai.translate("oauth-1", { texts: ["Привет", "Пока"], targets: ["en", "de", "fr"], folderId: "folder-1" });
    const sent = callsTo(stub, "/translate/v2/translate").slice(from);
    assert.strictEqual(sent.length, 3, "на три языка ушло не три запроса: " + sent.length);
    const langs = sent.map((c) => JSON.parse(c.body).targetLanguageCode);
    assert.deepStrictEqual(langs, ["EN", "DE", "FR"], "языки не дошли или не подняты в верхний регистр: " + langs.join(","));
    for (const c of sent) {
      const b = JSON.parse(c.body);
      assert.deepStrictEqual(b.texts, ["Привет", "Пока"], "строки поехали не пачкой: " + c.body);
      assert.strictEqual(b.folderId, "folder-1", "в теле нет каталога");
      assert.strictEqual(b.format, "PLAIN_TEXT", "нет формата PLAIN_TEXT");
      assert.strictEqual(b.sourceLanguageCode, undefined, "источник ушёл, хотя его не задавали");
    }
    assert.strictEqual(out.length, 3, "в ответе не три языка");
    assert.strictEqual(out[0].language, "EN");
    assert.strictEqual(out[0].detected, "ru", "определённый облаком язык не попал в ответ");
    assert.deepStrictEqual(out[0].translations, ["[EN] Привет", "[EN] Пока"], "перевод строк разобран неверно");
  });

  await test("ycAi: заданный источник уходит в запрос и виден в ответе", async () => {
    const out = await ai.translate("oauth-1", { text: "Hello", target: "ru", source: "en", folderId: "folder-1" });
    const last = callsTo(stub, "/translate/v2/translate").slice(-1)[0];
    assert.strictEqual(JSON.parse(last.body).sourceLanguageCode, "EN", "источник не поднят в верхний регистр");
    assert.strictEqual(out[0].detected, "EN", "в ответе нет языка источника");
    assert.deepStrictEqual(out[0].translations, ["[RU] Hello"]);
  });

  await test("ycAi: пустой текст и пустая цель — честные ошибки до сети", async () => {
    const from = stub.calls.length;
    await assert.rejects(() => ai.translate("oauth-1", { targets: ["en"], folderId: "folder-1" }), /Нечего переводить/);
    await assert.rejects(() => ai.translate("oauth-1", { text: "Привет", folderId: "folder-1" }), /Не указан язык перевода/);
    assert.strictEqual(stub.calls.length, from, "при ошибке всё-таки ушли запросы");
  });

  await test("ycAi: справочник языков приходит из облака", async () => {
    const langs = await ai.listLanguages("oauth-1", "folder-1");
    assert.deepStrictEqual(langs, [{ code: "ru", name: "Русский" }, { code: "en", name: "English" }]);
    const sent = callsTo(stub, "/translate/v2/languages").slice(-1)[0];
    assert.strictEqual(JSON.parse(sent.body).folderId, "folder-1", "справочник запрошен без каталога");
  });

  console.log("\n[3] Картинка и речь");

  await test("ycAi: OCR разбирает и полный текст, и строки блоков", async () => {
    const full = await ai.recognizeText("oauth-1", { content: Buffer.from("PNG!").toString("base64"), mimeType: "image/png", folderId: "folder-1" });
    assert.ok(/^РАСПОЗНАНО/.test(full.text), "полный текст ответа не разобран: " + full.text);
    const blocks = await ai.recognizeText("oauth-1", { content: "AAA=", mimeType: "image/png", model: "table", folderId: "folder-1" });
    assert.strictEqual(blocks.text, "Строка 1\nСтрока 2", "строки блоков не собраны: " + blocks.text);
  });

  await test("ycAi: модель page и языки ru/en — по умолчанию, тип файла уходит телом", async () => {
    await ai.recognizeText("oauth-1", { content: "AAA=", mimeType: "image/jpeg", folderId: "folder-1" });
    const b = JSON.parse(callsTo(stub, "/ocr/v1/recognizeText").slice(-1)[0].body);
    assert.strictEqual(b.model, "page", "модель по умолчанию не page: " + b.model);
    assert.deepStrictEqual(b.languageCodes, ["ru", "en"], "языки по умолчанию не ru/en");
    assert.strictEqual(b.mimeType, "image/jpeg", "тип файла не дошёл");
    assert.strictEqual(b.content, "AAA=", "содержимое не дошло");
    await assert.rejects(() => ai.recognizeText("oauth-1", { mimeType: "image/png", folderId: "folder-1" }), /Нужно содержимое картинки/);
  });

  await test("ycAi: речь — форма со всеми полями и ДВОИЧНЫЙ ответ", async () => {
    const r = await ai.synthesize("oauth-1", { text: "Привет, мир", voice: "filipp", lang: "ru-RU", format: "mp3", speed: 1.2, emotion: "good", sampleRateHertz: 48000, folderId: "folder-1" });
    const sent = callsTo(stub, "tts:synthesize").slice(-1)[0];
    assert.ok(/application\/x-www-form-urlencoded/.test(sent.headers["content-type"]), "у синтеза речи не форма: " + sent.headers["content-type"]);
    const f = new URLSearchParams(sent.body);
    assert.strictEqual(f.get("text"), "Привет, мир");
    assert.strictEqual(f.get("voice"), "filipp");
    assert.strictEqual(f.get("lang"), "ru-RU");
    assert.strictEqual(f.get("format"), "mp3");
    assert.strictEqual(f.get("speed"), "1.2");
    assert.strictEqual(f.get("emotion"), "good");
    assert.strictEqual(f.get("sampleRateHertz"), "48000");
    assert.strictEqual(r.audio.length, 5, "двоичный ответ разобран не как звук");
    assert.strictEqual(r.voice, "filipp");
    assert.strictEqual(r.format, "mp3");
  });

  await test("ycAi: lpcm без частоты и незнакомый формат — отказ до запроса", async () => {
    const from = stub.calls.length;
    await assert.rejects(() => ai.synthesize("oauth-1", { text: "Привет", format: "lpcm", folderId: "folder-1" }), /нужен sampleRateHertz/);
    await assert.rejects(() => ai.synthesize("oauth-1", { text: "Привет", format: "flac", folderId: "folder-1" }), /Неизвестный формат звука/);
    await assert.rejects(() => ai.recognizeSpeech("oauth-1", { audio: Buffer.from([1]), format: "flac", folderId: "folder-1" }), /Неизвестный формат звука/);
    assert.strictEqual(stub.calls.length, from, "при ошибке всё-таки ушли запросы");
  });

  await test("ycAi: распознавание речи уходит строкой параметров, тело — сам звук", async () => {
    const r = await ai.recognizeSpeech("oauth-1", { audio: Buffer.from([9, 8, 7, 6]), format: "oggopus", topic: "deferred", folderId: "folder-1" });
    const sent = callsTo(stub, "stt:recognize").slice(-1)[0];
    assert.ok(/lang=ru-RU/.test(sent.url), "в адресе нет языка: " + sent.url);
    assert.ok(/format=oggopus/.test(sent.url), "в адресе нет формата: " + sent.url);
    assert.ok(/topic=deferred/.test(sent.url), "в адресе нет темы: " + sent.url);
    assert.strictEqual(sent.bytes, 4, "телом ушёл не сам звук: " + sent.bytes);
    assert.strictEqual(r.text, "распознанный текст");
  });

  await test("ycAi: голоса берутся у облака, а при отказе — запасной список", async () => {
    const fromCloud = await ai.listVoices("oauth-1", "folder-1");
    assert.strictEqual(fromCloud.fromCloud, true, "список облака не разобран");
    assert.strictEqual(fromCloud.voices[0].id, "alena");
    assert.strictEqual(fromCloud.voices[0].lang, "ru-RU");
    stub.setVoicesFail(true);
    const fallback = await ai.listVoices("oauth-1", "folder-1");
    stub.setVoicesFail(false);
    assert.strictEqual(fallback.fromCloud, false, "отказ облака не распознан");
    assert.ok(fallback.voices.length > 0, "подсказка про голоса пропала вместе с сетью");
    assert.ok(VOICES.some((v) => v.id === "alena"), "запасной список без alena");
  });

  console.log("\n[4] AI Studio: модели, токены, ответ и вектор");

  await test("ycAi: адрес модели, тарифы и оценка ответа считаются без сети", () => {
    assert.strictEqual(modelUriFor("yandexgpt-5-lite", "f1"), "gpt://f1/yandexgpt-5-lite", "адрес текстовой модели не собран");
    assert.strictEqual(modelUriFor("text-search-doc", "f1", "embed"), "emb://f1/text-search-doc", "у векторов не префикс emb://");
    assert.strictEqual(modelUriFor("gpt://f1/aliceai-llm/rc", "f9"), "gpt://f1/aliceai-llm/rc", "полный адрес переписан");
    assert.strictEqual(modelNameOf("gpt://f1/yandexgpt-5-lite/rc"), "yandexgpt-5-lite", "имя из адреса не вынуто");
    assert.throws(() => modelUriFor("", "f1"), /Не указана модель/, "пустая модель принята");
    assert.throws(() => modelUriFor("yandexgpt-5-lite", ""), /каталог/, "без каталога адрес не собрать");
    const alice = aiPriceFor("gpt://f1/aliceai-llm");
    assert.ok(alice && alice.in1000 === 0.5 && alice.out1000 === 1.2, "тариф Alice не найден: " + JSON.stringify(alice));
    assert.strictEqual(aiPriceFor("незнакомая-модель"), null, "чужой модели приписан тариф");
    const line = aiPriceLine("yandexgpt-5-lite");
    assert.ok(/0\.2 ₽/.test(line) && /бесплатна/.test(line), "тариф Lite не назван: " + line);
    assert.strictEqual(aiCostText("yandexgpt-5-lite", { input: 1200, output: 400 }), "≈ 0.32 ₽", "цена ответа посчитана неверно");
    assert.strictEqual(aiCostText("незнакомая", { input: 10 }), "", "неизвестной модели приписана цена");
    assert.strictEqual(AI_MODELS.length, 6, "запасной список моделей неполон: " + AI_MODELS.length);
    assert.ok(AI_MODELS.some((m) => m.id === "text-search-doc" && m.kind === "векторы"), "в запасе нет модели векторов");
  });

  await test("ycAi: модели — из облака и запасным списком, каталог уходит заголовком", async () => {
    const r = await ai.listModels("oauth-1", "folder-1");
    assert.strictEqual(r.fromCloud, true, "список облака не разобран");
    assert.deepStrictEqual(r.models.map((m) => m.id), ["yandexgpt-5-lite", "text-search-doc"], "модели не разобраны");
    assert.strictEqual(r.models[1].kind, "векторы", "вид модели не угадан по имени: " + r.models[1].kind);
    assert.strictEqual(r.models[0].kind, "текст", "вид модели не взят из ответа: " + r.models[0].kind);
    const sent = callsTo(stub, "/v1/models").slice(-1)[0];
    assert.strictEqual(sent.headers["openai-project"], "folder-1", "каталог не ушёл заголовком OpenAI-Project");
    assert.strictEqual(sent.headers.authorization, "Bearer iam-test", "нет IAM-токена у списка моделей");
    stub.setModelsFail(true);
    const fb = await ai.listModels("oauth-1", "folder-1");
    stub.setModelsFail(false);
    assert.strictEqual(fb.fromCloud, false, "отказ облака не распознан");
    assert.ok(fb.models.some((m) => m.id === "text-search-doc"), "подсказка про модели пропала вместе с сетью");
  });

  await test("ycAi: ответ модели — синхронный запрос с ролью и оценкой по токенам", async () => {
    const from = stub.calls.length;
    const r = await ai.complete("oauth-1", { prompt: "Привет", system: "Отвечай коротко", folderId: "folder-1" });
    assert.ok(stub.calls.length > from, "запрос к модели не ушёл");
    const b = JSON.parse(callsTo(stub, "/foundationModels/v1/completion").slice(-1)[0].body);
    assert.strictEqual(b.modelUri, "gpt://folder-1/yandexgpt-5-lite", "адрес модели не собран");
    assert.strictEqual(b.completionOptions.stream, false, "это не синхронный режим");
    assert.strictEqual(b.completionOptions.temperature, 0.3, "температура по умолчанию не 0.3");
    assert.strictEqual(b.completionOptions.maxTokens, "2000", "maxTokens ушёл не строкой: " + JSON.stringify(b.completionOptions.maxTokens));
    assert.deepStrictEqual(b.messages.map((m) => m.role), ["system", "user"], "роль не ушла первой");
    assert.strictEqual(r.text, "Ответ модели: Отвечай коротко | Привет", "текст ответа не разобран: " + r.text);
    assert.deepStrictEqual(r.usage, { input: 1200, output: 400, total: 1600 }, "токены ответа не разобраны");
    assert.strictEqual(r.modelVersion, "v5.1", "версия модели не разобрана");
    assert.strictEqual(r.status, "ALTERNATIVE_STATUS_FINAL", "статус альтернативы не разобран");
    assert.ok(r.price && r.price.in1000 === 0.2, "тариф не приложен к ответу");
  });

  await test("ycAi: без запроса, с температурой 2 и длиной 0 — отказ ДО сети", async () => {
    const from = stub.calls.length;
    await assert.rejects(() => ai.complete("oauth-1", { folderId: "folder-1" }), /Нечего спросить/);
    await assert.rejects(() => ai.complete("oauth-1", { prompt: "а", temperature: 2, folderId: "folder-1" }), /temperature — число от 0 до 1/);
    await assert.rejects(() => ai.complete("oauth-1", { prompt: "а", maxTokens: 0, folderId: "folder-1" }), /maxTokens — целое от 1 до 32000/);
    await assert.rejects(() => ai.tokenize("oauth-1", { folderId: "folder-1" }), /Нечего считать/);
    await assert.rejects(() => ai.embed("oauth-1", { folderId: "folder-1" }), /Нечего векторизовать/);
    assert.strictEqual(stub.calls.length, from, "на отказах всё-таки ушли запросы");
  });

  await test("ycAi: токены считаются бесплатно, вектор — эмбеддингом из 256 чисел", async () => {
    const tk = await ai.tokenize("oauth-1", { text: "Привет", model: "yandexgpt-5.1", folderId: "folder-1" });
    const tb = JSON.parse(callsTo(stub, "/foundationModels/v1/tokenizeCompletion").slice(-1)[0].body);
    assert.deepStrictEqual(tb, { modelUri: "gpt://folder-1/yandexgpt-5.1", text: "Привет" }, "тело токенизации разошлось");
    assert.strictEqual(tk.count, 3, "токены не посчитаны: " + tk.count);
    assert.deepStrictEqual(tk.first, ["При", "вет", "42"], "первые токены не разобраны: " + JSON.stringify(tk.first));
    const em = await ai.embed("oauth-1", { text: "документ", folderId: "folder-1" });
    const eb = JSON.parse(callsTo(stub, "/foundationModels/v1/textEmbedding").slice(-1)[0].body);
    assert.deepStrictEqual(eb, { modelUri: "emb://folder-1/text-search-doc", text: "документ" }, "тело вектора разошлось");
    assert.strictEqual(em.dims, 256, "размерность вектора: " + em.dims);
    assert.strictEqual(em.vector[0], 0.001, "числа вектора не разобраны: " + em.vector[0]);
    const q = await ai.embed("oauth-1", { text: "запрос", model: "text-search-query", folderId: "folder-1" });
    assert.strictEqual(q.modelUri, "emb://folder-1/text-search-query", "у поискового запроса своя модель");
    assert.ok(q.price && q.price.in1000 === 0.0101, "тариф векторов не приложен к ответу");
  });

  console.log("\n[5] Инструмент агента ycAi");

  await test("ycAi: без подключения, без каталога и с чужим действием — до сети", async () => {
    const off = buildTools({ yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await off.tools.ycAi({ action: "translate", text: "a", target: "en" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({ ycFolderId: "" });
    assert.ok(/выбери каталог/.test(await noFolder.tools.ycAi({ action: "translate", text: "a", target: "en" }, {})), "нет ответа про каталог");
    const env = buildTools();
    const bad = await env.tools.ycAi({ action: "стирай" }, {});
    assert.ok(/неизвестное действие ycAi/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 120));
  });

  await test("ycAi: перевод сразу на несколько языков объясняет счёт запросов", async () => {
    const env = buildTools();
    const from = callsTo(stub, "/translate/v2/translate").length;
    const out = await env.tools.ycAi({ action: "translate", texts: ["Привет", "Пока"], targets: ["en", "de"] }, {});
    assert.strictEqual(callsTo(stub, "/translate/v2/translate").length - from, 2, "на два языка ушло не два запроса");
    assert.ok(/языков 2/.test(out), "в ответе нет числа языков: " + out.slice(0, 200));
    assert.ok(/строк 2/.test(out), "в ответе нет числа строк");
    assert.ok(/\[EN\]/.test(out) && /\[DE\]/.test(out), "в ответе нет самих переводов");
    assert.ok(/ОТДЕЛЬНЫЙ запрос/.test(out), "ответ не предупреждает про тариф по языкам");
    const noTarget = await env.tools.ycAi({ action: "translate", text: "Привет" }, {});
    assert.ok(/укажи target/.test(noTarget), "без языка нет подсказки: " + noTarget.slice(0, 120));
  });

  await test("ycAi: озвучка пишет настоящие файлы, несколько голосов — несколько файлов", async () => {
    const env = buildTools();
    const out = await env.tools.ycAi({ action: "speak", text: "Привет, это проверка озвучки" }, {});
    assert.ok(/Речь готова/.test(out), "нет ответа про готовую речь: " + out.slice(0, 200));
    assert.ok(/alena/.test(out), "голос по умолчанию не указан в ответе");
    assert.ok(/openPath/.test(out), "ответ не говорит, как послушать звук");
    const multi = await env.tools.ycAi({ action: "speak", text: "Разные голоса", voices: ["alena", "filipp"] }, {});
    const paths = multi.split("\n").filter((l) => /^• /.test(l)).map((l) => l.split("→")[1].trim().split(" ")[0]);
    assert.strictEqual(paths.length, 2, "на два голоса не два файла: " + multi.slice(0, 200));
    for (const p of paths) {
      assert.ok(fs.existsSync(p), "файла озвучки нет на диске: " + p);
      assert.strictEqual(fs.statSync(p).size, 5, "в файле не тот звук, что отдало облако");
    }
    assert.ok(/speech-\w+/.test(out) || /ai-speech-/.test(out), "имя файла не про речь");
  });

  await test("ycAi: картинка распознаётся по рабочей папке, чужие файлы и пределы — отказ", async () => {
    const env = buildTools();
    fs.writeFileSync(path.join(work, "scan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const out = await env.tools.ycAi({ action: "ocr", file: "scan.png", langs: ["ru"] }, {});
    assert.ok(/РАСПОЗНАНО/.test(out), "текст с картинки не разобран: " + out.slice(0, 200));
    assert.ok(/scan\.png/.test(out) && /image\/png/.test(out), "в ответе нет файла и его типа");
    const sent = JSON.parse(callsTo(stub, "/ocr/v1/recognizeText").slice(-1)[0].body);
    assert.strictEqual(sent.mimeType, "image/png", "тип определён не по расширению");
    assert.deepStrictEqual(sent.languageCodes, ["ru"], "язык из аргументов не дошёл");
    assert.strictEqual(sent.folderId, "folder-1", "каталог не дошёл до запроса");

    assert.ok(/файла «нет-такого\.png» нет/.test(await env.tools.ycAi({ action: "ocr", file: "нет-такого.png" }, {})), "нет отказа на пропавший файл");
    fs.writeFileSync(path.join(work, "док.docx"), Buffer.from([1, 2, 3]));
    assert.ok(/не понял тип файла/.test(await env.tools.ycAi({ action: "ocr", file: "док.docx" }, {})), "WORD-файл не отвергнут");
    fs.writeFileSync(path.join(work, "big.png"), Buffer.alloc(10 * 1048576 + 1));
    assert.ok(/до 10 МБ/.test(await env.tools.ycAi({ action: "ocr", file: "big.png" }, {})), "картинка больше 10 МБ не отвергнута");
  });

  await test("ycAi: запись расшифровывается, а большая и незнакомая — отказ", async () => {
    const env = buildTools();
    fs.writeFileSync(path.join(work, "voice.ogg"), Buffer.from([1, 2, 3, 4]));
    const from = callsTo(stub, "stt:recognize").length;
    const out = await env.tools.ycAi({ action: "listen", file: "voice.ogg" }, {});
    assert.ok(/распознанный текст/.test(out), "текст записи не разобран: " + out.slice(0, 200));
    assert.ok(/voice\.ogg/.test(out), "в ответе нет имени записи");
    assert.ok(/тарифицируется/.test(out), "ответ не говорит про цену");
    const sent = callsTo(stub, "stt:recognize").slice(-1)[0];
    assert.strictEqual(callsTo(stub, "stt:recognize").length - from, 1, "ушёл не один запрос");
    assert.ok(/format=oggopus/.test(sent.url), "формат .ogg не разобран в oggopus: " + sent.url);
    assert.strictEqual(sent.bytes, 4, "телом ушёл не сам файл");

    assert.ok(/нужен file/.test(await env.tools.ycAi({ action: "listen" }, {})), "нет ответа про пропавший file");
    fs.writeFileSync(path.join(work, "long.ogg"), Buffer.alloc(1048577));
    assert.ok(/до 1 МБ/.test(await env.tools.ycAi({ action: "listen", file: "long.ogg" }, {})), "запись больше 1 МБ не отвергнута");
  });

  await test("ycAi: справочники языков и голосов отвечают словами", async () => {
    const env = buildTools();
    const langs = await env.tools.ycAi({ action: "languages" }, {});
    assert.ok(/Русский/.test(langs) && /English/.test(langs), "языки не перечислены: " + langs.slice(0, 160));
    assert.ok(/targets/.test(langs), "ответ про языки не подсказывает, как переводить");
    const voices = await env.tools.ycAi({ action: "voices" }, {});
    assert.ok(/alena/.test(voices) && /filipp/.test(voices), "голоса не перечислены: " + voices.slice(0, 160));
    assert.ok(/voices: \[/.test(voices), "ответ про голоса не подсказывает про несколько сразу");
  });

  await test("ycAi: модели, токены, ответ и вектор отвечают словами и называют цену", async () => {
    const env = buildTools();
    const models = await env.tools.ycAi({ action: "models" }, {});
    assert.ok(/yandexgpt-5-lite/.test(models) && /text-search-doc/.test(models), "модели не перечислены: " + models.slice(0, 220));
    assert.ok(/0\.2 ₽/.test(models), "тариф Lite не назван в списке моделей");
    assert.ok(/action: "tokens"/.test(models), "ответ не подсказывает бесплатный счёт токенов");
    const tokens = await env.tools.ycAi({ action: "tokens", text: "Привет" }, {});
    assert.ok(/Токены текста: 3/.test(tokens), "токены не посчитаны: " + tokens.slice(0, 200));
    assert.ok(/бесплатн/.test(tokens), "не сказано, что токенизация бесплатна");
    assert.ok(/yandexgpt-5-lite/.test(tokens), "модель по умолчанию не названа");
    const done = await env.tools.ycAi({ action: "complete", prompt: "Привет", system: "Отвечай коротко" }, {});
    assert.ok(/Ответ модели: Отвечай коротко \| Привет/.test(done), "текст ответа не отдан: " + done.slice(0, 220));
    assert.ok(/вход 1200, ответ 400/.test(done), "токены ответа не названы");
    assert.ok(/≈ 0\.32 ₽/.test(done), "цена ответа не посчитана: " + done.slice(0, 320));
    assert.ok(/YandexGPT Lite 5/.test(done), "тариф после ответа не назван");
    const vec = await env.tools.ycAi({ action: "embed", text: "документ" }, {});
    assert.ok(/256 чисел/.test(vec), "размерность вектора не названа: " + vec.slice(0, 220));
    assert.ok(/text-search-doc/.test(vec) && /text-search-query/.test(vec), "модели векторов не названы");
    assert.ok(/0\.0101/.test(vec), "тариф векторов не назван");
    assert.ok(/Ошибка: нужен text/.test(await env.tools.ycAi({ action: "tokens" }, {})), "нет отказа без текста для токенов");
    assert.ok(/Ошибка: нужен prompt/.test(await env.tools.ycAi({ action: "complete" }, {})), "нет отказа без запроса к модели");
    assert.ok(/Ошибка: нужен text/.test(await env.tools.ycAi({ action: "embed" }, {})), "нет отказа без текста для вектора");
  });

  console.log("\n[6] Согласованность: схема, промпт, политика, справочник");

  await test("ycAi: схема, группа облака, промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycAi"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 7200);
    for (const part of ["action", "text", "texts", "target", "targets", "source", "file", "files", "langs", "model", "voice", "voices", "lang", "format", "speed", "emotion", "out", "topic", "sampleRateHertz", "prompt", "system", "temperature", "maxTokens", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/SpeechKit/.test(schema) && /Vision OCR|Vision/.test(schema), "схема не называет сервисы");
    assert.ok(/10 МБ/.test(schema) && /1 МБ/.test(schema), "схема не называет пределы");
    assert.ok(/AI Studio/.test(schema), "схема не называет AI Studio");
    assert.ok(/models \(модели AI Studio каталога\)/.test(schema) && /tokens/.test(schema) && /complete/.test(schema) && /embed/.test(schema), "схема не описывает действия AI Studio");
    assert.ok(/temperature 0…1/.test(schema) && /maxTokens — длина ответа/.test(schema), "схема не объясняет температуру и длину ответа");
    // Границы записи группы, а не число знаков: окно в 800 знаков ломалось от
    // каждого нового ключевого слова группы (часть 91 добавила «группа машин»),
    // хотя проверяемое свойство — «инструмент есть в группе облака» — не менялось.
    const groupAt = CORE_SRC.indexOf('id: "cloud"');
    const groupEnd = CORE_SRC.indexOf('id: "', groupAt + 10);
    const cloudGroup = CORE_SRC.slice(groupAt, groupEnd > groupAt ? groupEnd : groupAt + 1400);
    assert.ok(groupAt > 0 && cloudGroup.includes('"ycAi"'), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycAi/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycAi \(ЯНДЕКС AI/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycAi");
    assert.ok(/AI Studio/.test(PROMPTS_SRC) && /tokens — посчитать токены текста/.test(PROMPTS_SRC), "промпт не называет действия AI Studio");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 260).includes('"ycAi"'), "нет назначения cloud.read для ycAi");
    assert.ok(SMOKE_SRC.includes('"ycAi"'), "smoke-набор не знает про ycAi");
  });

  await test("ycAi: справочник агента объясняет, когда что брать", () => {
    assert.ok(/ycAi/.test(GUIDE_SRC), "в yc.md нет ycAi");
    assert.ok(/SpeechKit/.test(GUIDE_SRC) && /ocr/.test(GUIDE_SRC), "в yc.md не названы сервисы");
    assert.ok(/targets: \[/.test(GUIDE_SRC) && /voices: \[/.test(GUIDE_SRC), "в yc.md нет примера со списками");
    assert.ok(/10 МБ/.test(GUIDE_SRC) && /1 МБ/.test(GUIDE_SRC), "в yc.md нет пределов");
    assert.ok(/ключа API заводить НЕ нужно|отдельного ключа API/.test(GUIDE_SRC), "в yc.md не сказано, что ключ API не нужен");
    assert.ok(/AI Studio/.test(GUIDE_SRC) && /tokens/.test(GUIDE_SRC), "в yc.md нет действий AI Studio");
    assert.ok(/text-search-doc/.test(GUIDE_SRC) && /text-search-query/.test(GUIDE_SRC), "в yc.md не названы модели векторов");
  });

  await test("ycAi: адреса четырёх сервисов известны облаку без сети", () => {
    for (const part of [
      '"translate": "https://translate.api.cloud.yandex.net"',
      '"ocr": "https://ocr.api.cloud.yandex.net"',
      '"tts": "https://tts.api.cloud.yandex.net"',
      '"stt": "https://stt.api.cloud.yandex.net"',
      '"ai": "https://llm.api.cloud.yandex.net"',
      '"ai-llm": "https://ai.api.cloud.yandex.net"',
    ]) {
      assert.ok(YC_SRC.includes(part), "в KNOWN_ENDPOINTS нет " + part);
    }
    assert.ok(MAIN_SRC.includes('require("./yc-ai.js")'), "модуль не собран в main.js");
    assert.ok(/const ycAi = createYcAi\(/.test(MAIN_SRC), "модуль не собран в main.js");
    const deps = MAIN_SRC.slice(MAIN_SRC.indexOf("ycCdn,\n  ycAi,"), MAIN_SRC.indexOf("ycCdn,\n  ycAi,") + 40);
    assert.ok(deps.includes("ycAi"), "модуль не передан инструментам агента");
  });

  await test("ycAi: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-ai.test.js") >= 0, "набора нет в цепочке npm test");
  });

  console.log("\n[7] Интерфейс: канал «yc:ai» и вход в панели");

  await test("yc:ai: канал отвечает теми же действиями, что форма, и зовёт тот же модуль", () => {
    // Якорь именно на ОБЪЯВЛЕНИЕ КАНАЛА, а не на список ops в интерфейсе: у них
    // одинаковое начало строки, и первый попавшийся нашёлся бы не там.
    const at = IPC_SRC.indexOf('ipcMain.handle("yc:ai"');
    assert.ok(at > 0, "в yc-ipc.js нет канала yc:ai");
    let end = IPC_SRC.indexOf("ipcMain.handle(\"", at + 10);
    if (end < 0) end = IPC_SRC.length;
    const body = IPC_SRC.slice(at, end);
    // Список действий печатается СБОРКОЙ из массива ALL (`"Доступно: " + ALL.join(", ")`)
    // — разбор строки здесь ничего не найдёт. Читаем сам массив: он и есть список,
    // а строка «Доступно:» обязана звать именно его.
    const arr = body.match(/const ALL = \[([^\]]+)\];/);
    assert.ok(arr, "в канале нет списка доступных действий");
    assert.ok(/Доступно:\s*" \+ ALL\.join\(", "\)/.test(body), "отказ канала не называет действия из ALL");
    assert.deepStrictEqual(
      arr[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")),
      ["translate", "languages", "detect", "ocr", "voices", "speak", "listen", "models", "tokens", "complete", "embed"],
      "список действий канала разошёлся с интерфейсом"
    );
    for (const part of ["ycAi.translate(", "ycAi.listLanguages(", "ycAi.detectLanguage(", "ycAi.recognizeText(", "ycAi.listVoices(", "ycAi.synthesize(", "ycAi.recognizeSpeech(", "ycAi.mimeForExt(", "ycAi.listModels(", "ycAi.complete(", "ycAi.tokenize(", "ycAi.embed("]) {
      assert.ok(body.includes(part), "канал не зовёт " + part);
    }
    assert.ok(PRELOAD_SRC.includes('ycAi: (args) => ipcRenderer.invoke("yc:ai", args || {})'), "preload не пробрасывает Яндекс AI в окно");
    const reg = /registerYcIpc\(\{([\s\S]{0,700}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /ycAi/.test(reg[1]), "модуль не передан каналам (main.js)");
    assert.ok(reg && /resolvePath/.test(reg[1]) && /agentWorkDir/.test(reg[1]), "канал не получил чтение файлов и рабочую папку");
  });

  // ── Канал через НАСТОЯЩИЙ registerYcIpc: окно подменено, всё остальное — как
  // в приложении. Так проверяется то, ради чего канал и написан: перевод пачкой
  // языков, снимок С ДИСКА, речь (файл + содержимое для плеера) и расшифровка.
  function buildIpc(settings) {
    const handlers = new Map();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-ai-ui-"));
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
      ycAi: ai,
      fs: fs,
      path: path,
      resolvePath: (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(workDir, String(p))),
      agentWorkDir: () => workDir,
      loadSettings: () => settings,
      saveSettings: () => {},
      svc: {
        YANDEX_OAUTH_URL: "https://oauth.yandex.ru/authorize",
        ycConfig: () => ({
          oauth: String(settings.yandexOauthToken || ""),
          cloudId: settings.ycCloudId || "",
          folderId: settings.ycFolderId || "",
          folderName: settings.ycFolderName || "",
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
    return { call: (args) => handlers.get("yc:ai")({}, args || {}), workDir: workDir };
  }

  await test("yc:ai: перевод пачкой языков, снимок с диска, речь и расшифровка записи", async () => {
    const env = buildIpc(settingsFor());
    const from = callsTo(stub, "/translate/v2/translate").length;
    const tr = await env.call({ op: "translate", text: "Привет", targets: "en, de" });
    assert.strictEqual(tr.ok, true, "канал отказал: " + (tr.error || ""));
    assert.strictEqual(callsTo(stub, "/translate/v2/translate").length - from, 2, "на два языка ушло не два запроса");
    const text = (tr.lines || []).join("\n");
    assert.ok(text.includes("[EN] Привет") && text.includes("[DE] Привет"), "переводы не показаны: " + text);
    assert.ok(/2 языка — это 2 запроса/.test(tr.message), "число запросов не названо по-русски: " + tr.message);
    assert.ok((tr.warnings || []).join(" ").includes("платный"), "о тарифе не сказано");

    // Снимок: файл лежит в рабочей папке канала, тип определяется РАСШИРЕНИЕМ.
    fs.writeFileSync(path.join(env.workDir, "снимок.png"), Buffer.from("PNG-DATA"));
    const ocr = await env.call({ op: "ocr", files: "снимок.png", langs: "ru, en" });
    assert.strictEqual(ocr.ok, true, "распознавание отказало: " + (ocr.error || ""));
    assert.ok(/РАСПОЗНАНО/.test((ocr.lines || []).join("\n")), "текст со снимка не показан: " + (ocr.lines || []).join(" | "));
    const sentOcr = callsTo(stub, "/ocr/v1/recognizeText").slice(-1)[0];
    assert.strictEqual(JSON.parse(sentOcr.body).mimeType, "image/png", "тип файла определён не по расширению");

    // Речь: два голоса — два файла НА ДИСКЕ и два плеера в ответе.
    const sp = await env.call({ op: "speak", text: "Привет", voices: "alena, filipp" });
    assert.strictEqual(sp.ok, true, "озвучка отказала: " + (sp.error || ""));
    assert.strictEqual((sp.files || []).length, 2, "файлов не два: " + JSON.stringify((sp.files || []).map((f) => f.path)));
    assert.ok(fs.existsSync(sp.files[0].path) && fs.statSync(sp.files[0].path).size === 5, "файл речи не записан");
    assert.strictEqual((sp.audios || []).length, 2, "в ответе нет звука для плеера");
    assert.strictEqual(Buffer.from(sp.audios[0].base64, "base64").length, 5, "содержимое звука потерялось");
    assert.ok(/audio\/mpeg/.test(sp.audios[0].mime), "тип звука не назван: " + sp.audios[0].mime);

    // Запись: формат берётся из расширения (ogg → oggopus), текст возвращается.
    fs.writeFileSync(path.join(env.workDir, "голос.ogg"), Buffer.from([1, 2, 3, 4]));
    const ls = await env.call({ op: "listen", file: "голос.ogg" });
    assert.strictEqual(ls.ok, true, "расшифровка отказала: " + (ls.error || ""));
    assert.strictEqual(ls.text, "распознанный текст", "текст записи не разобран: " + JSON.stringify(ls.text));
  });

  await test("yc:ai: чужие файлы и пределы — отказ ДО запроса, иначе платили бы за ошибку", async () => {
    const env = buildIpc(settingsFor());
    const from = stub.calls.length;
    const missing = await env.call({ op: "ocr", files: "нет-такого.png" });
    assert.strictEqual(missing.ok, false, "отсутствующий файл принят");
    assert.ok(/нет\. Проверь путь/.test(missing.error), "отказ не объяснён: " + missing.error);
    // Картинка сверх 10 МБ и запись сверх 1 МБ отсекаются ДО подъёма содержимого.
    fs.writeFileSync(path.join(env.workDir, "большая.png"), Buffer.alloc(10 * 1048576 + 10));
    const hugeImg = await env.call({ op: "ocr", files: "большая.png" });
    assert.ok(/до 10 МБ/.test(hugeImg.error), "предел картинки не назван: " + hugeImg.error);
    fs.writeFileSync(path.join(env.workDir, "длинная.ogg"), Buffer.alloc(1048576 + 10));
    const hugeAudio = await env.call({ op: "listen", file: "длинная.ogg" });
    assert.ok(/до 1 МБ/.test(hugeAudio.error), "предел звука не назван: " + hugeAudio.error);
    assert.strictEqual(stub.calls.length, from, "на отказах всё-таки ушли запросы в облако");

    const bad = await env.call({ op: "транслит" });
    assert.strictEqual(bad.ok, false);
    assert.ok(/Доступно: translate, languages, detect, ocr, voices, speak, listen/.test(bad.error), "чужое действие не объяснено: " + bad.error);
    const noFolder = buildIpc(settingsFor({ ycFolderId: "" }));
    const rf = await noFolder.call({ op: "languages" });
    assert.strictEqual(rf.ok, false, "без каталога канал не отказал");
    assert.ok(/каталог/.test(rf.error), "отказ про каталог не сказан: " + rf.error);
    const noToken = buildIpc(settingsFor({ yandexOauthToken: "" }));
    assert.ok(/не подключён/.test((await noToken.call({ op: "languages" })).error), "отказ про токен не сказан");
  });

  await test("yc:ai: модели, токены, ответ и вектор — канал отвечает теми же формами", async () => {
    const env = buildIpc(settingsFor());
    const models = await env.call({ op: "models" });
    assert.strictEqual(models.ok, true, "канал отказал: " + (models.error || ""));
    assert.deepStrictEqual((models.lines || []).length, 2, "строк не две: " + JSON.stringify(models.lines));
    assert.ok(/yandexgpt-5-lite/.test((models.lines || []).join("\n")), "моделей нет в строках");
    const sent = callsTo(stub, "/v1/models").slice(-1)[0];
    assert.strictEqual(sent.headers["openai-project"], "folder-1", "канал не назвал каталог заголовком");
    const tk = await env.call({ op: "tokens", text: "Привет" });
    assert.strictEqual(tk.ok, true, "токены отказали: " + (tk.error || ""));
    assert.strictEqual(tk.tokens, 3, "токенов не 3: " + tk.tokens);
    assert.ok(/бесплатн/.test((tk.warnings || []).join(" ")), "о бесплатности токенизации не сказано");
    const done = await env.call({ op: "complete", prompt: "Привет", system: "Роль" });
    assert.strictEqual(done.ok, true, "ответ модели отказал: " + (done.error || ""));
    assert.ok(/Ответ модели: Роль \| Привет/.test(done.answer), "текст ответа не отдан: " + done.answer);
    assert.deepStrictEqual(done.usage, { input: 1200, output: 400, total: 1600 }, "токены ответа не разобраны");
    assert.ok(/≈ 0\.32 ₽/.test((done.lines || []).join("\n")), "цена не посчитана: " + (done.lines || []).join(" | "));
    const em = await env.call({ op: "embed", text: "документ" });
    assert.strictEqual(em.ok, true, "вектор отказал: " + (em.error || ""));
    assert.strictEqual(em.dims, 256, "размерность вектора: " + em.dims);
    assert.ok(/Первые числа: 0\.001/.test((em.lines || []).join("\n")), "первые числа не показаны: " + (em.lines || []).join(" | "));
    const bad = await env.call({ op: "tokens" });
    assert.strictEqual(bad.ok, false, "пустые токены приняты");
    assert.ok(/Впиши текст/.test(bad.error), "отказ без текста не объяснён: " + bad.error);
    const noPrompt = await env.call({ op: "complete" });
    assert.strictEqual(noPrompt.ok, false, "пустой запрос к модели принят");
    assert.ok(/Впиши запрос/.test(noPrompt.error), "отказ без запроса не объяснён: " + noPrompt.error);
    const noVec = await env.call({ op: "embed" });
    assert.strictEqual(noVec.ok, false, "пустой текст для вектора принят");
    assert.ok(/Впиши текст/.test(noVec.error), "отказ без текста для вектора не объяснён: " + noVec.error);
  });

  await test("yc:ai: семейство в интерфейсе, вход в панели и плеер для звука", () => {
    assert.ok(/ai: "ycAi"/.test(ACTIONS_SRC), "в таблице действий нет канала Яндекс AI");
    assert.ok(/ai: \["translate", "languages", "detect", "ocr", "voices", "speak", "listen", "models", "tokens", "complete", "embed"\]/.test(ACTIONS_SRC), "нет списка допустимых действий");
    assert.ok(/ai: \{ title: "Яндекс AI", ru: "запрос" \}/.test(ACTIONS_SRC), "нет подписи семейства");
    const at = ACTIONS_SRC.indexOf('ai: [\n      { id: "languages"');
    assert.ok(at > 0, "нет таблицы действий Яндекс AI");
    const body = ACTIONS_SRC.slice(at, ACTIONS_SRC.indexOf("\n    ],", at));
    for (const part of ['op: "translate"', 'op: "ocr"', 'op: "voices"', 'op: "speak"', 'op: "listen"', 'op: "models"', 'op: "tokens"', 'op: "complete"', 'op: "embed"', "targets", "files", "model", "emotion", "prompt", "temperature"]) {
      assert.ok(body.includes(part), "в семействе Яндекс AI нет " + part);
    }
    assert.ok(/paid: true/.test(body), "платные запросы не помечены");
    assert.ok(/ai: "yc:ai"/.test(ACTIONS_TEST_SRC), "набор действий не знает семейство — сверка каналов его не увидит");
    assert.ok(PANEL_SRC.includes('window.YcActions.forService("ai")'), "панель не знает про действия Яндекс AI");
    assert.ok(PANEL_SRC.includes('ycOpenActions("ai"'), "в панели нет входа в действия Яндекс AI");
    assert.ok(/🧠 Яндекс AI/.test(PANEL_SRC), "чип Яндекс AI не подписан");
    // Речь проигрывает окно: содержимое приходит base64, значит нужен и плеер,
    // и разрешение CSP — без media-src звук молча не заиграет.
    assert.ok(/audios/.test(ACTIONS_SRC) && /yc-act-audio/.test(ACTIONS_SRC), "ответ со звуком не разбирается");
    assert.ok(/#sp-cloud \.yc-act-audio/.test(ACTIONS_CSS), "у плеера нет стилей в панели");
    assert.ok(/media-src 'self' data:/.test(HTML_SRC), "CSP не разрешает проиграть звук из данных");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ─── Яндекс AI: перевод, текст с картинки и речь ─────────────────────────────
   Чистый Node-модуль (fetch + таймеры), как остальные облачные модули
   (`src/yc-*.js`): тел запросов в оболочке `main.js` не появляется, а сам модуль
   проверяется в plain-node.

   Авторизация та же, что у всего облака: человек даёт OAuth-токен, приложение
   меняет его на IAM (`getIamToken`) и ходит с `Authorization: Bearer <IAM>` и
   заголовком `x-folder-id`. Отдельный ключ API (Api-Key) не нужен — иначе
   человеку пришлось бы заводить ВТОРОЙ секрет ради тех же сервисов.

   Четыре сервиса, у каждого свой хост:
     Translate   translate.api.cloud.yandex.net/translate/v2/...    — текст между языками
     Vision OCR  ocr.api.cloud.yandex.net/ocr/v1/recognizeText      — текст со снимка/PDF
     SpeechKit   tts.api.cloud.yandex.net/speech/v1/tts:synthesize  — текст в звук
     SpeechKit   stt.api.cloud.yandex.net/speech/v1/stt:recognize   — звук в текст

   Деньги: все четыре тарифицируются ПО ЗАПРОСУ (SpeechKit — ещё и по длине
   звука), поэтому действие говорит о тарифе до отправки, а не удивляет счётом.

   «Несколько вариантов сразу» здесь не украшение, а суть сервисов, и поэтому
   оно встроено в сами методы: `translate` принимает МАССИВ языков (targets) и
   массив строк (texts), `recognizeText` — массив языков и снимков,
   `synthesize` — массив голосов. Один вызов инструмента делает всю пачку.

   Ответы разбираются ЗАЩИТНО: форма ответа Vision менялась (полный текст лежит то
   в `textAnnotation.fullText`, то только строками блоков), поэтому текст
   собирается из нескольких мест, а не из одного поля — иначе смена формы ответа
   выглядела бы как «распознавание не работает». */

// Голоса SpeechKit v1 (ru-RU и самые ходовые чужие). Список нужен для подсказки
// и как запасной, когда облако не отдало свой: инструмент голоса не выдумывает,
// а показывает проверенные имена — опечатка в голосе ловится до запроса.
const VOICES = [
  { id: "alena", lang: "ru-RU", who: "Алёна, женский — нейтральный" },
  { id: "filipp", lang: "ru-RU", who: "Филипп, мужской — нейтральный" },
  { id: "ermil", lang: "ru-RU", who: "Ермил, мужской — нейтральный" },
  { id: "jane", lang: "ru-RU", who: "Джейн, женский — нейтральный" },
  { id: "omazh", lang: "ru-RU", who: "Омаж, женский — нейтральный" },
  { id: "zahar", lang: "ru-RU", who: "Захар, мужской — нейтральный" },
  { id: "madirus", lang: "ru-RU", who: "Мадирус, мужской — нейтральный" },
  { id: "dasha", lang: "ru-RU", who: "Даша, женский — разговорный" },
  { id: "julia", lang: "ru-RU", who: "Юля, женский — разговорный" },
  { id: "lera", lang: "ru-RU", who: "Лера, женский — разговорный" },
  { id: "masha", lang: "ru-RU", who: "Маша, женский — детский" },
  { id: "john", lang: "en-US", who: "John, мужской — английский" },
  { id: "madi", lang: "en-US", who: "Madi, женский — английский" },
];

// Модели Vision OCR. `page` — обычный документ, `page-column-sort` — текст в
// колонках, `handwritten` — рукописный, `table` — таблица, `markdown` — разметка,
// `mathmarkdown` — формулы. Модель `page` понимает ВСЁ остальное, поэтому она и
// по умолчанию: заказчик обычно не знает заранее, что лежит на снимке.
const OCR_MODELS = [
  { id: "page", who: "Обычный документ/снимок (по умолчанию)" },
  { id: "page-column-sort", who: "Текст в колонках — порядок чтения по колонкам" },
  { id: "handwritten", who: "Рукописный текст" },
  { id: "table", who: "Таблицы" },
  { id: "markdown", who: "Markdown-разметка" },
  { id: "mathmarkdown", who: "Формулы (LaTeX в markdown)" },
];

const TTS_FORMATS = ["mp3", "oggopus", "lpcm", "wav"]; // lpcm — только с sampleRateHertz
const STT_FORMATS = ["oggopus", "lpcm", "mp3"];

// Расширение файла → mimeType для Vision. Список закрытый: облако принимает
// строго эти типы, и «угадать по имени» лучше здесь, чем получить отказ сервиса.
const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
};

function mimeForExt(ext) {
  return MIME_BY_EXT[String(ext || "").toLowerCase()] || "";
}

function createYcAi(deps) {
  const { fetchJson, endpoint, getIamToken, serviceError, isNetworkError } = deps || {};

  // Заголовки всех четырёх сервисов одинаковые: IAM-токен и каталог. Каталог
  // уходит и заголовком, и (где можно) телом: Translate и Vision принимают
  // `folderId` телом, SpeechKit v1 знает только заголовок.
  async function headers(oauth, folderId, contentType) {
    const token = await getIamToken(oauth);
    const h = { Authorization: "Bearer " + token };
    if (contentType) h["Content-Type"] = contentType;
    if (folderId) h["x-folder-id"] = String(folderId);
    return h;
  }

  async function baseOf(serviceId) {
    const b = await endpoint(serviceId);
    if (!b) throw new Error("Облако не отдало адрес сервиса «" + serviceId + "» — проверь подключение к интернету.");
    return b;
  }

  // Двоичный ответ (звук) нельзя разобрать через fetchJson: он ждёт JSON и на
  // аудио падает разбором. Свой маленький запрос — тем же fetch и тем же
  // таймаутом, что у остальных модулей.
  async function fetchBin(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const text = buf.toString("utf8").slice(0, 400);
        const e = new Error(text || ("HTTP " + res.status));
        e.status = res.status;
        throw e;
      }
      return { status: res.status, contentType: res.headers.get("content-type") || "", buf };
    } finally {
      clearTimeout(timer);
    }
  }

  const one = (v) => String(v == null ? "" : v).trim();
  const arr = (v) => (Array.isArray(v) ? v.map(one).filter(Boolean) : one(v) ? [one(v)] : []);

  // ── Translate ──────────────────────────────────────────────────────────────
  // Один запрос = один целевой язык (такова форма API), поэтому массив целей
  // превращается в пачку запросов. Строк в одном запросе может быть много — это
  // и есть «перевести сразу несколько».
  async function translate(oauth, opts) {
    const o = opts || {};
    const texts = arr(o.texts && o.texts.length ? o.texts : o.text);
    if (!texts.length) throw new Error("Нечего переводить: нужен text или texts.");
    const targets = arr(o.targets && o.targets.length ? o.targets : o.target).map((t) => t.toUpperCase());
    if (!targets.length) throw new Error("Не указан язык перевода (target или targets): ru, en, de, zh и т.д.");
    const source = one(o.source).toUpperCase();
    const folderId = one(o.folderId);
    const base = await baseOf("translate");
    const path = "/translate/v2/translate";
    const headersJson = await headers(oauth, folderId, "application/json");

    const send = async (lang) => {
      const body = { texts: texts, targetLanguageCode: lang, format: "PLAIN_TEXT" };
      if (folderId) body.folderId = folderId;
      if (source) body.sourceLanguageCode = source;
      const j = await fetchJson(base + path, { method: "POST", headers: headersJson, body: JSON.stringify(body) }, 30000).catch((e) => {
        throw new Error(serviceError(e, base, path));
      });
      const list = Array.isArray(j && j.translations) ? j.translations : [];
      return {
        language: lang,
        detected: list.find((t) => t && t.detectedLanguageCode) ? list[0].detectedLanguageCode : source || "",
        translations: list.map((t) => one(t && t.text)),
      };
    };
    return await Promise.all(targets.map(send));
  }

  // Язык текста, когда человек его не знает и хочет переводить «с любого».
  async function detectLanguage(oauth, opts) {
    const o = opts || {};
    const texts = arr(o.texts && o.texts.length ? o.texts : o.text);
    if (!texts.length) throw new Error("Нечего распознавать: нужен text или texts.");
    const folderId = one(o.folderId);
    const base = await baseOf("translate");
    const path = "/translate/v2/detect";
    const body = { texts: texts };
    if (folderId) body.folderId = folderId;
    const j = await fetchJson(base + path, { method: "POST", headers: await headers(oauth, folderId, "application/json"), body: JSON.stringify(body) }, 30000).catch((e) => {
      throw new Error(serviceError(e, base, path));
    });
    if (j && j.languageCode) return one(j.languageCode);
    if (j && Array.isArray(j.languages) && j.languages[0]) return one(j.languages[0].languageCode || j.languages[0].code);
    return "";
  }

  // Справочник языков перевода — из облака, а не из моей памяти: он меняется.
  async function listLanguages(oauth, folderId) {
    const base = await baseOf("translate");
    const path = "/translate/v2/languages";
    const body = {};
    if (folderId) body.folderId = folderId;
    const j = await fetchJson(base + path, { method: "POST", headers: await headers(oauth, folderId, "application/json"), body: JSON.stringify(body) }, 30000).catch((e) => {
      throw new Error(serviceError(e, base, path));
    });
    const list = Array.isArray(j && j.languages) ? j.languages : [];
    return list.map((l) => ({ code: one(l && (l.code || l.languageCode)), name: one(l && l.name) })).filter((l) => l.code);
  }

  // ── Vision OCR ─────────────────────────────────────────────────────────────
  // `content` — уже готовый base64 (инструмент кодирует файл сам, чтобы модуль не
  // знал про диск: он чистый и проверяется без файлов).
  function extractOcrText(j) {
    const r = (j && j.result) || {};
    const ta = r.textAnnotation || r.text_annotation || null;
    if (ta) {
      if (typeof ta.fullText === "string" && ta.fullText.trim()) return ta.fullText;
      if (Array.isArray(ta.blocks)) {
        const lines = [];
        for (const b of ta.blocks) {
          for (const l of (b && b.lines) || []) if (l && l.text) lines.push(one(l.text));
        }
        if (lines.length) return lines.join("\n");
      }
    }
    if (typeof r.text === "string") return r.text;
    if (typeof j.text === "string") return j.text;
    return "";
  }

  async function recognizeText(oauth, opts) {
    const o = opts || {};
    const content = one(o.content);
    if (!content) throw new Error("Нужно содержимое картинки: content (base64).");
    const mimeType = one(o.mimeType) || "image/jpeg";
    const langs = arr(o.languageCodes || o.langs);
    const folderId = one(o.folderId);
    const base = await baseOf("ocr");
    const path = "/ocr/v1/recognizeText";
    const body = { mimeType: mimeType, content: content, model: one(o.model) || "page" };
    body.languageCodes = langs.length ? langs : ["ru", "en"];
    if (folderId) body.folderId = folderId;
    const j = await fetchJson(base + path, { method: "POST", headers: await headers(oauth, folderId, "application/json"), body: JSON.stringify(body) }, 60000).catch((e) => {
      throw new Error(serviceError(e, base, path));
    });
    return { text: extractOcrText(j), model: body.model, languageCodes: body.languageCodes };
  }

  // ── SpeechKit: текст в звук ────────────────────────────────────────────────
  // v1 отдаёт ЗВУК телом ответа (не JSON), поэтому здесь нужен fetchBin.
  async function synthesize(oauth, opts) {
    const o = opts || {};
    const text = one(o.text);
    if (!text) throw new Error("Нечего озвучивать: нужен text.");
    const format = (one(o.format) || "mp3").toLowerCase();
    if (TTS_FORMATS.indexOf(format) === -1) throw new Error("Неизвестный формат звука «" + format + "». Доступно: " + TTS_FORMATS.join(", ") + ".");
    const sampleRate = parseInt(o.sampleRateHertz, 10) || 0;
    if (format === "lpcm" && !sampleRate) throw new Error("Для формата lpcm нужен sampleRateHertz (например 48000).");
    const voice = one(o.voice) || "alena";
    const folderId = one(o.folderId);
    const base = await baseOf("tts");
    const path = "/speech/v1/tts:synthesize";
    const form = new URLSearchParams();
    form.set("text", text);
    form.set("voice", voice);
    form.set("lang", one(o.lang) || "ru-RU");
    form.set("format", format);
    form.set("speed", String(o.speed || 1.0));
    if (sampleRate) form.set("sampleRateHertz", String(sampleRate));
    // Эмоция есть только у русских голосов; чужому голосу облако на неё ответит
    // отказом, поэтому она уходит, лишь когда её задали явно.
    if (one(o.emotion)) form.set("emotion", one(o.emotion));
    const h = await headers(oauth, folderId, "application/x-www-form-urlencoded");
    const r = await fetchBin(base + path, { method: "POST", headers: h, body: form.toString() }, 60000).catch((e) => {
      throw new Error(serviceError(e, base, path));
    });
    if (!r.buf.length) throw new Error("Облако вернуло пустой звук — проверь голос и текст.");
    return { audio: r.buf, contentType: r.contentType, voice: voice, format: format, lang: one(o.lang) || "ru-RU" };
  }

  // ── SpeechKit: звук в текст ────────────────────────────────────────────────
  // Одним запросом распознаётся короткое аудио (до ~1 минуты и ~1 МБ). Длинное
  // записывается отдельной операцией — про её предел инструмент и предупреждает.
  async function recognizeSpeech(oauth, opts) {
    const o = opts || {};
    const audio = o.audio;
    if (!audio || !audio.length) throw new Error("Нужен звук: audio (буфер файла).");
    const format = (one(o.format) || "oggopus").toLowerCase();
    if (STT_FORMATS.indexOf(format) === -1) throw new Error("Неизвестный формат звука «" + format + "». Доступно: " + STT_FORMATS.join(", ") + ".");
    const sampleRate = parseInt(o.sampleRateHertz, 10) || 0;
    if (format === "lpcm" && !sampleRate) throw new Error("Для формата lpcm нужен sampleRateHertz (например 48000).");
    const folderId = one(o.folderId);
    const base = await baseOf("stt");
    const q = new URLSearchParams();
    q.set("lang", one(o.lang) || "ru-RU");
    q.set("format", format);
    // topic=general лучше для коротких команд, topic=deferred — для длинной речи;
    // облако требует его ВСЕГДА, когда в аудио больше одного канала/темы.
    q.set("topic", one(o.topic) || "general");
    if (sampleRate) q.set("sampleRateHertz", String(sampleRate));
    const path = "/speech/v1/stt:recognize?" + q.toString();
    const h = await headers(oauth, folderId, "application/octet-stream");
    const j = await fetchJson(base + path, { method: "POST", headers: h, body: audio }, 120000).catch((e) => {
      throw new Error(serviceError(e, base, path));
    });
    return { text: one(j && j.result), format: format, lang: one(o.lang) || "ru-RU" };
  }

  // ── Голоса ─────────────────────────────────────────────────────────────────
  // Спрашиваем у облака (список пополняется); не ответило — отдаём проверенный
  // запасной список, а не пустоту: подсказка «какие есть голоса» обязана быть.
  async function listVoices(oauth, folderId) {
    try {
      const base = await baseOf("tts");
      const path = "/tts/v3/voices" + (folderId ? "?folderId=" + encodeURIComponent(folderId) : "");
      const j = await fetchJson(base + path, { method: "GET", headers: await headers(oauth, folderId, null) }, 20000);
      const raw = Array.isArray(j && j.voices) ? j.voices : [];
      const list = raw
        .map((v) => ({
          id: one(v && (v.id || v.name)),
          lang: one(v && v.languages && v.languages[0]) || "ru-RU",
          who: one(v && v.name) || one(v && v.id),
        }))
        .filter((v) => v.id);
      if (list.length) return { voices: list, fromCloud: true };
    } catch (e) {
      // Молча падать нельзя, но и ронять подсказку незачем: причина уйдёт в ответ.
      if (isNetworkError && isNetworkError(e)) return { voices: VOICES, fromCloud: false, why: "сеть" };
    }
    return { voices: VOICES, fromCloud: false };
  }

  return {
    VOICES,
    OCR_MODELS,
    TTS_FORMATS,
    STT_FORMATS,
    mimeForExt,
    translate,
    detectLanguage,
    listLanguages,
    recognizeText,
    synthesize,
    recognizeSpeech,
    listVoices,
  };
}

module.exports = { createYcAi, VOICES, OCR_MODELS, TTS_FORMATS, STT_FORMATS, MIME_BY_EXT };

"use strict";

/* ─── Контекст прогона: рабочая история агента, которая переживает остановку ────
   Новый модуль (часть 41).

   Почему он появился. Пауза, «Стоп» и закрытие приложения убивали весь ход работы:
   рабочий контекст (роль assistant с вызовами инструментов и их результаты) живёт
   внутри прогона и вместе с ним выбрасывается. В новый прогон уходят только реплики
   диалога — интерфейс шлёт одни тексты (src/renderer/chat-send.js фильтрует
   role:"tool"), а сводка миссии есть лишь при включённой долгой работе. Поэтому
   агент после паузы заново искал, чем занимался: перечитывал файлы, повторял команды,
   спрашивал «а что уже сделано».

   Что делает модуль. После каждого шага прогона рабочая история (без системного
   промпта и без сводки миссии — они собираются заново) ложится на диск рядом с
   проектом: .agent/runs/<чат>.json — тем же способом, что миссии и памятки. Папка
   .agent целиком исключена из git (.agent/.gitignore = «*»), а тексты перед записью
   проходят маскировку секретов: чекпоинт не имеет права вынести ключ из переписки
   в файл проекта.

   Когда прогон начинается заново (человек нажал «продолжай», кнопку «▶ Продолжить»
   или просто перезапустил приложение), контекст возвращается в работу: рабочая
   история встаёт ПЕРЕД свежими репликами окна. Свежие реплики берутся не целиком:
   опора — последняя реплика человека, которая есть в чекпоинте; всё, что в окне
   после неё (обрывок оборванного ответа, заметки, новая просьба), дописывается
   в конец. Так история не удваивается и не теряет то, что человек сказал после
   остановки.

   Ошибки тут тихие и дорогие, поэтому каждое решение записано вместе с причиной:

     • чекпоинт сохраняется ДО запроса к модели и ПОСЛЕ выполнения инструментов:
       обрыв на любом из этих шагов оставляет работу на диске, а не только в памяти;
     • оборванный на полуслове ответ не оставляет «висящий» assistant с вызовами
       без результатов — иначе следующий запрос падал бы 400 (tool_calls без tool);
     • результат инструмента обрезается (начало + конец): без обрезки один вывод
       сборки в 2 МБ делал бы файл нечитаемым и медленным;
     • картинки не сохраняются: base64-скриншот в чекпоинте — это мегабайты на
       каждый шаг, а модель и так видит их описание в тексте;
     • если чат неизвестен, модуль молчит: общий чекпоинт «на всех» подсунул бы
       одной переписке работу другой.

   Всё, что модуль пишет, — это НЕ отчёт и НЕ память пользователя: это рабочий
   контекст одного незавершённого прогона. Прогон дошёл до конца — файл удаляется
   (close), потому что незачем возвращать в работу сданное дело. */

const path = require("path");
const fs = require("fs");
const { atomicWriteText, redactSecrets } = require("./store-files.js");
const { agentRoot, ensureAgentRoot } = require("./mission-store.js");

// Папка чекпоинтов внутри .agent (рядом с missions/ и context/).
const RUN_CTX_DIR = "runs";
const RUN_CTX_VERSION = 1;
// Потолок файла: контекст — не архив. Переполнение лечится отбрасыванием старых
// шагов, а не отказом от записи: незачем терять хвост работы из-за её начала.
const RUN_CTX_MAX_BYTES = 512 * 1024;
const RUN_CTX_MAX_STEPS = 400; // сообщений в чекпоинте
// Обрезка одного шага: у вывода команды и чтения файла важны и начало, и конец
// (ошибки обычно в хвосте). Середка — «обрезано N символов».
const RUN_CTX_HEAD = 4000;
const RUN_CTX_TAIL = 1500;
const RUN_CTX_CHARS_PER_TOKEN = 3.6; // та же оценка, что у контекст-окна

// Сводка миссии в чекпоинт не попадает: она собирается приложением заново каждый
// раунд (src/run-mission.js), и её копия в истории только запутала бы модель.
const DIGEST_RE = /^\s*СОСТОЯНИЕ РАБОТЫ \(миссия идёт/;

function isDigestMessage(m) {
  return !!(m && m.role === "system" && typeof m.content === "string" && DIGEST_RE.test(m.content));
}

// Текст сообщения для чекпоинта: строки как есть, части — только текстовые,
// картинка превращается в пометку (base64 в файле ни к чему).
function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const p of content) {
      if (!p) continue;
      if (p.type === "text") out.push(String(p.text || ""));
      else if (p.type === "image_url") out.push("[изображение — в чекпоинт не сохраняется]");
      else out.push("[" + String(p.type || "часть") + "]");
    }
    return out.join("\n");
  }
  return content == null ? "" : String(content);
}

// Обрезка одного шага: начало + пометка + конец.
function clipStep(text) {
  const s = String(text == null ? "" : text);
  const keep = RUN_CTX_HEAD + RUN_CTX_TAIL;
  if (s.length <= keep + 120) return s;
  return (
    s.slice(0, RUN_CTX_HEAD) +
    "\n… (обрезано: " + s.length + " символов, показан хвост ниже)\n" +
    s.slice(s.length - RUN_CTX_TAIL)
  );
}

// Оборванный на полуслове ответ: assistant с вызовами инструментов, на который не
// пришло ни одного результата. Такой хвост следующий запрос к API отвергает
// («tool_calls must be followed by tool messages»), поэтому снимаем его.
function dropDanglingCalls(messages) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  while (out.length) {
    const last = out[out.length - 1];
    if (last && last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length) out.pop();
    else break;
  }
  return out;
}

// Что вообще стоит сохранять: реплики человека и агента, результаты инструментов.
// Системные заметки (в том числе сводка миссии) — нет: они либо собираются заново,
// либо живут одним прогоном.
function prepareMessages(messages, opts) {
  const o = opts || {};
  const maxSteps = Math.max(1, Number(o.maxSteps) || RUN_CTX_MAX_STEPS);
  const keepTokens = Math.max(500, Number(o.keepTokens) || 24000);
  let list = (Array.isArray(messages) ? messages : []).filter((m) => {
    if (!m || !m.role) return false;
    if (m.role === "system") return false;
    if (isDigestMessage(m)) return false;
    return true;
  });
  list = list.map((m) => {
    const one = {
      role: m.role,
      content: clipStep(redactSecrets(messageText(m.content))),
    };
    if (m.role === "tool" && m.tool_call_id) one.tool_call_id = m.tool_call_id;
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      one.tool_calls = m.tool_calls.map((c) => ({
        id: c && c.id,
        type: "function",
        function: {
          name: (c && c.function && c.function.name) || "",
          arguments: clipStep(redactSecrets((c && c.function && c.function.arguments) || "")),
        },
      }));
    }
    return one;
  });
  list = dropDanglingCalls(list);
  if (o.sanitize) list = o.sanitize(list);
  // Потолок по числу шагов — с конца: свежая работа важнее начала.
  if (list.length > maxSteps) list = list.slice(list.length - maxSteps);
  // Потолок по «весу»: пока список длиннее, отбрасываем самое старое. Оценка —
  // по символам (3.6 символа на токен), как в контекст-окне.
  const weight = (arr) => Math.ceil(JSON.stringify(arr).length / RUN_CTX_CHARS_PER_TOKEN);
  let guard = 0;
  while (list.length > 2 && weight(list) > keepTokens && guard++ < list.length) list = list.slice(1);
  return dropDanglingCalls(o.sanitize ? o.sanitize(list) : list);
}

/* Решение «возвращаем ли работу в контекст»: чистая функция без диска и без fs,
   поэтому проверяется поведением.
   checkpoint — рабочая история с диска (без system);
   rendererMessages — то, что прислало окно (только реплики человека и агента).
   Возврат: { history, resumed, anchor } — readiness меряется этим же решением. */
function planResume(checkpoint, rendererMessages) {
  const renderer = Array.isArray(rendererMessages) ? rendererMessages.slice() : [];
  const cp = Array.isArray(checkpoint) ? checkpoint : [];
  const plain = { history: renderer, resumed: false, anchor: -1, steps: 0, tools: 0 };
  if (!cp.length) return plain;
  const key = (m) => (typeof m.content === "string" ? m.content.trim() : "");
  const cpHumans = new Set();
  for (const m of cp) {
    if (m && m.role === "user") {
      const t = key(m);
      if (t) cpHumans.add(t);
    }
  }
  if (!cpHumans.size) return plain; // в чекпоинте нет ни одной просьбы человека — опоры не искать
  // Опора — последняя реплика человека в окне, которая есть в чекпоинте. Всё, что
  // в окне после неё (обрывок ответа, служебная заметка, новая просьба), идёт в конец.
  let anchor = -1;
  for (let i = renderer.length - 1; i >= 0; i--) {
    const m = renderer[i];
    if (m && m.role === "user" && cpHumans.has(key(m))) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return plain; // окно не узнаётся в чекпоинте — работаем как раньше
  const history = dropDanglingCalls(cp).concat(renderer.slice(anchor + 1));
  let tools = 0;
  for (const m of cp) if (m && m.role === "tool") tools++;
  return { history: history, resumed: true, anchor: anchor, steps: cp.length, tools: tools };
}

// Имя файла чекпоинта: id чата в безопасном виде. Пустой id — модуль молчит.
function fileFor(workDir, id) {
  const safe = String(id || "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  if (!safe) return "";
  return path.join(agentRoot(workDir), RUN_CTX_DIR, safe + ".json");
}

function createRunContext(deps) {
  const d = deps || {};
  // Папка — функцией: рабочая директория меняется (клонирование, смена проекта),
  // и копия застыла бы на прежней.
  const dirOf = typeof d.dir === "function" ? d.dir : () => String(d.dir || "");
  const id = String(d.id || "");
  const sanitize = typeof d.sanitizeToolPairs === "function" ? d.sanitizeToolPairs : null;
  const now = typeof d.now === "function" ? d.now : () => Date.now();

  const file = () => {
    try {
      return fileFor(dirOf(), id);
    } catch {
      return "";
    }
  };

  // Чтение чекпоинта. Любая беда (нет файла, битый JSON, чужая папка) — это
  // «чекпоинта нет»: прогон обязан идти как раньше, а не падать из-за него.
  const read = () => {
    const f = file();
    if (!f) return null;
    try {
      const raw = fs.readFileSync(f, "utf8");
      const data = JSON.parse(raw);
      if (!data || data.v !== RUN_CTX_VERSION) return null;
      if (!Array.isArray(data.messages) || !data.messages.length) return null;
      // Чекпоинт из другой рабочей папки к этой работе не относится.
      if (String(data.dir || "") !== String(dirOf() || "")) return null;
      // Тексты на диске могли править руками — прогоняем через разбор пар.
      const messages = sanitize ? sanitize(data.messages) : data.messages;
      return { messages: dropDanglingCalls(messages), at: Number(data.at) || 0, steps: messages.length };
    } catch {
      return null;
    }
  };

  const plan = (rendererMessages) => {
    try {
      const cp = read();
      if (!cp) return { history: Array.isArray(rendererMessages) ? rendererMessages.slice() : [], resumed: false, steps: 0, tools: 0 };
      const r = planResume(cp.messages, rendererMessages);
      if (!r.resumed) return r;
      return {
        history: r.history,
        resumed: true,
        steps: r.steps,
        tools: r.tools,
        at: cp.at,
        notice:
          "▶ Продолжаю с места остановки: вернул в работу " +
          r.steps +
          " шагов" +
          (r.tools ? " (результатов инструментов: " + r.tools + ")" : "") +
          " — читать и повторять уже сделанное не нужно.",
      };
    } catch {
      return { history: Array.isArray(rendererMessages) ? rendererMessages.slice() : [], resumed: false, steps: 0, tools: 0 };
    }
  };

  // Запись чекпоинта. Ничего не бросает: сбой записи не имеет права сломать прогон.
  const save = (messages) => {
    const f = file();
    if (!f) return { ok: false, reason: "неизвестен чат" };
    try {
      const list = prepareMessages(messages, { sanitize: sanitize, keepTokens: d.keepTokens, maxSteps: d.maxSteps });
      if (!list.length) return { ok: false, reason: "нечего сохранять" };
      let payload = list;
      let text = "";
      // Потолок файла: если JSON не влез, отбрасываем старые шаги. Цикл ограничен
      // длиной списка — «пустого» зацикливания быть не может.
      for (let i = 0; i <= list.length; i++) {
        text = JSON.stringify({ v: RUN_CTX_VERSION, dir: String(dirOf() || ""), chatId: id, at: now(), steps: payload.length, messages: payload });
        if (Buffer.byteLength(text, "utf8") <= RUN_CTX_MAX_BYTES || payload.length <= 2) break;
        payload = dropDanglingCalls(payload.slice(Math.max(1, Math.ceil(payload.length / 4))));
      }
      if (Buffer.byteLength(text, "utf8") > RUN_CTX_MAX_BYTES) return { ok: false, reason: "не влезает" };
      ensureAgentRoot(dirOf());
      atomicWriteText(f, text);
      return { ok: true, path: f, bytes: Buffer.byteLength(text, "utf8"), steps: payload.length };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    }
  };

  // Прогон дошёл до конца — возвращать в работу нечего.
  const close = () => {
    try {
      const f = file();
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  };

  const info = () => {
    const f = file();
    const cp = read();
    return { path: f, exists: !!cp, at: cp ? cp.at : 0, steps: cp ? cp.steps : 0, chatId: id };
  };

  return { plan: plan, save: save, close: close, info: info, file: file() };
}

module.exports = {
  createRunContext,
  planResume,
  prepareMessages,
  dropDanglingCalls,
  clipStep,
  messageText,
  isDigestMessage,
  fileFor,
  RUN_CTX_VERSION,
  RUN_CTX_MAX_BYTES,
  RUN_CTX_MAX_STEPS,
  RUN_CTX_HEAD,
  RUN_CTX_TAIL,
};

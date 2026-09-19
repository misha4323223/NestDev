"use strict";

/* ── Поток ответа провайдера: пометка обрыва и чистка рассуждений ─────────────
   Запуск: node test/provider-stream.test.js   (входит в общий `npm test`)

   Две правки, которые нашлись при выносе тела раунда (часть 17) и которые до
   этого молчали у пользователя:

   1. Обрыв ответа по лимиту вывода у ОБЛАЧНЫХ провайдеров не помечался вовсе:
      `onTruncated` звался только в ветке Ollama (`done_reason: "length"`), а
      `finish_reason: "length"` в транспорте не читался ни разу. У DeepSeek, Groq
      и OpenAI обрезанный на полуслове ответ выглядел законченным — человек не
      знал, что нужно написать «продолжай». У Claude своё имя: `stop_reason`
      `max_tokens` в `message_delta`.

   2. Чистка рассуждений держала жёсткий хвост в 16 символов. Из-за этого
      короткий ответ (меньше 16 видимых символов) приезжал в чат одним куском
      только в самом конце, а рассуждения уходили в блок мыслей ПО ОДНОМУ СИМВОЛУ.
      Теперь хвост держится ровно настолько, насколько он может оказаться началом
      тега `<think` / `</think`.

   Транспорт и чистка берутся настоящие: проверка ходит через тот же код, что и прогон. */

const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

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

/* Поток из строк: тело ответа провайдера как оно есть — построчно по SSE/NDJSON. */
function streamOf(lines) {
  const text = lines.join("\n") + "\n";
  return {
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
  };
}

const sseChunk = (delta, extra) =>
  "data: " + JSON.stringify(Object.assign({ choices: [{ index: 0, delta: delta }] }, extra || {})) + "\n";

async function consume(lines, provider, handlers) {
  const seen = { text: [], think: [], usage: [], cut: 0 };
  await core.consumeProviderStream(
    Object.assign(
      {
        response: streamOf(lines),
        provider: provider,
        onText: (t) => seen.text.push(t),
        onThinking: (t) => seen.think.push(t),
        onUsage: (u) => seen.usage.push(u),
        onTruncated: () => {
          seen.cut++;
        },
      },
      handlers || {}
    )
  );
  return seen;
}

(async () => {
  // ── 1. Обрыв ответа у облачных провайдеров ───────────────────────────────
  await test("OpenAI-совместимые: finish_reason «length» — обрыв замечен", async () => {
    const seen = await consume(
      [
        sseChunk({ role: "assistant", content: "Начало ответа, который " }),
        sseChunk({ content: "оборвался" }),
        sseChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
        "data: [DONE]",
      ],
      "openai"
    );
    assert.strictEqual(seen.cut, 1, "обрыв по finish_reason «length» не замечен: " + seen.cut);
    assert.strictEqual(seen.text.join(""), "Начало ответа, который оборвался", "текст до обрыва потерян");
  });

  await test("OpenAI-совместимые: обычный конец ответа обрывом не считается", async () => {
    const stop = await consume(
      [sseChunk({ role: "assistant", content: "готово" }), sseChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]"],
      "openai"
    );
    assert.strictEqual(stop.cut, 0, "нормальный конец ответа помечен обрывом");
    assert.strictEqual(stop.text.join(""), "готово");
    const tool = await consume(
      [sseChunk({}, { choices: [{ index: 0, delta: { tool_calls: [callAt(0, "c1", "readFile", { path: "a.js" })] }, finish_reason: "tool_calls" }] }), "data: [DONE]"],
      "openai"
    );
    assert.strictEqual(tool.cut, 0, "вызов инструмента помечен обрывом ответа");
  });

  await test("OpenAI-совместимые: чанк со счётчиками (пустой choices) обрывом не считается", async () => {
    const seen = await consume(
      [
        sseChunk({ role: "assistant", content: "ответ" }),
        "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + "\n",
        "data: [DONE]",
      ],
      "openai"
    );
    assert.strictEqual(seen.cut, 0, "чанк со счётчиками принят за обрыв");
    assert.strictEqual(seen.usage.length, 1, "счётчики потеряны");
    assert.deepStrictEqual(seen.usage[0], { prompt: 10, completion: 2, cached: 0 }, "счётчики разобраны неверно");
  });

  await test("Claude: stop_reason «max_tokens» — обрыв замечен, «end_turn» — нет", async () => {
    const cut = await consume(
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Начало"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":512}}',
      ],
      "anthropic"
    );
    assert.strictEqual(cut.cut, 1, "обрыв Claude по stop_reason не замечен: " + cut.cut);
    const fine = await consume(
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"готово"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
      ],
      "anthropic"
    );
    assert.strictEqual(fine.cut, 0, "нормальный конец ответа Claude помечен обрывом");
  });

  // ── 2. Чистка рассуждений ────────────────────────────────────────────────
  await test("короткий ответ уходит в чат сразу, а не в самом конце", () => {
    const s = core.createThinkingStripper();
    // Раньше жёсткий хвост в 16 символов держал такой ответ до finish().
    assert.strictEqual(s.push("Ответ готов."), "Ответ готов.", "короткий ответ задержан до конца стрима");
    assert.strictEqual(s.finish(), "", "ответ отдан дважды");
  });

  await test("тег, пришедший по кускам, всё равно скрыт", () => {
    const hidden = [];
    const s = core.createThinkingStripper({ onHidden: (t) => hidden.push(t) });
    const out =
      s.push("Думаю <thi") + s.push("nk>секрет</thi") + s.push("nk>готово");
    assert.strictEqual(out + s.finish(), "Думаю готово", "видимый текст искажён: " + JSON.stringify(out));
    assert.strictEqual(hidden.join(""), "секрет", "рассуждения потеряны: " + JSON.stringify(hidden));
  });

  await test("рассуждения приходят куском, а не по одному символу", () => {
    const hidden = [];
    const s = core.createThinkingStripper({ onHidden: (t) => hidden.push(t) });
    s.push("<think>внутреннее рассуждение модели");
    assert.deepStrictEqual(hidden, ["внутреннее рассуждение модели"], "текст мыслей порезан на куски: " + JSON.stringify(hidden));
    assert.ok(hidden.every((t) => t.length > 1), "мысли пришли по символу — блок мыслей будет «печататься» буквами");
  });

  await test("незакрытый блок рассуждений: показываем его целиком, видимого текста нет", () => {
    const hidden = [];
    const s = core.createThinkingStripper({ onHidden: (t) => hidden.push(t) });
    const out = s.push("<think>думаю до конца потока");
    assert.strictEqual(out, "", "рассуждения утекли в текст ответа");
    assert.strictEqual(s.finish(), "", "из оборванного блока выдан текст ответа");
    assert.strictEqual(hidden.join(""), "думаю до конца потока", "рассуждения оборванного блока потеряны");
  });

  await test("текст, похожий на тег, но не тег, не скрывается и не теряется", () => {
    const hidden = [];
    const s = core.createThinkingStripper({ onHidden: (t) => hidden.push(t) });
    const out = s.push("пример <thinks> и <think") + s.finish();
    assert.strictEqual(out, "пример <thinks> и <think", "не-тег принят за рассуждения: " + JSON.stringify(out));
    assert.strictEqual(hidden.length, 0, "не-тег ушёл в блок мыслей");
  });

  await test("хвост, похожий на начало тега, не теряется на finish", () => {
    const s = core.createThinkingStripper();
    assert.strictEqual(s.push("ответ <thi"), "ответ ", "видимый текст отдан неполностью");
    assert.strictEqual(s.finish(), "<thi", "подозрительный хвост потерян на завершении потока");
  });

  await test("stripThinking целиком: теги вырезаны, рассуждения не в ответе", () => {
    const out = core.stripThinking("до <think>секрет</think> после");
    assert.strictEqual(out, "до  после", "текст с тегом разобран неверно: " + JSON.stringify(out));
    assert.strictEqual(out.indexOf("секрет"), -1, "рассуждения попали в ответ");
  });

  await test("оба исправления на месте, а жёсткого хвоста больше нет", () => {
    const transport = require("fs").readFileSync(path.join(ROOT, "src", "renderer", "provider-transport.js"), "utf8");
    const coreSrc = require("fs").readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
    assert.ok(/choice\.finish_reason === "length" && onTruncated/.test(transport), "пометка обрыва для облака потерялась");
    assert.ok(/obj\.delta\.stop_reason === "max_tokens" && onTruncated/.test(transport), "пометка обрыва для Claude потерялась");
    assert.ok(!/const hold = 16;/.test(coreSrc), "жёсткий хвост в 16 символов вернулся");
    assert.ok(/function tagHold\(text, head\)/.test(coreSrc), "точный хвост под тег потерялся");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

function callAt(index, id, name, args) {
  return { index: index, id: id, type: "function", function: { name: name, arguments: JSON.stringify(args) } };
}

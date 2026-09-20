"use strict";

/* ── Буфер обмена после перехода на Electron 44 (src/agent-tools.js) ──────────
   Запуск: node test/clipboard-tools.test.js   (входит в общий `npm test`)

   Зачем. В Electron 44 модуль clipboard переделали под W3C: readText и writeText
   теперь возвращают Promise, а read/write заменены на ClipboardItem. Инструменты
   агента звали их синхронно, и поломка была двойная и ТИХАЯ:

     • clipboardRead отдавал модели "[object Promise]" вместо текста — агент
       уверен, что прочитал буфер, а прочитал заглушку. В чате это неотличимо от
       обычного ответа инструмента, поэтому живёт долго;
     • отказ доступа к буферу (нет прав, занят другим процессом) улетал в
       необработанный reject, а инструмент докладывал «OK — текст скопирован».

   Набор водит НАСТОЯЩИЕ обработчики из agent-tools.js с буфером ДВУХ видов —
   синхронным (как Electron 33; на нём стоит smoke.test.js) и асинхронным (как 44)
   — и требует, чтобы обе ветки вели себя одинаково. Отдельная проверка держит
   «ждать результат»: инструмент обязан ответить ПОСЛЕ записи, а не до неё.

   Текстовая часть закрывает вторую половину: в src/ не должно остаться
   синхронных вызовов буфера и API, вырезанного в 44, а окно не имеет права
   тянуть clipboard из electron (в 44 его там нет — только navigator.clipboard). */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const { createAgentTools } = require(path.join(SRC, "agent-tools.js"));
const AGENT_TOOLS_SRC = fs.readFileSync(path.join(SRC, "agent-tools.js"), "utf8");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

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

// Сборка НАСТОЯЩИХ обработчиков с подставленным буфером: кроме буфера этим двум
// инструментам ничего не нужно, остальные зависимости берутся в момент вызова
// других инструментов.
function toolsWith(clipboard) {
  return createAgentTools({
    clipboard,
    truncateText: (t, n) => String(t == null ? "" : t).slice(0, n || 4000),
  });
}

const sync33 = { readText: () => "текст-33", writeText: () => {} };
const async44 = { readText: () => Promise.resolve("текст-44"), writeText: () => Promise.resolve() };

function jsFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) out.push(...jsFiles(abs));
    else if (name.endsWith(".js")) out.push(abs);
  }
  return out;
}

(async () => {
  console.log("Буфер обмена под Electron 44: инструменты агента и вырезанные API");

  await test("буфер 44: чтение ждёт Promise и отдаёт текст, а не «[object Promise]»", async () => {
    const r = await toolsWith(async44).clipboardRead({}, {});
    assert.match(r, /текст-44/, "текст из буфера не доехал: " + r);
    assert.ok(r.indexOf("[object Promise]") === -1, "инструмент отдал модели Promise вместо текста: " + r);
  });

  await test("буфер 44: запись ждёт результат, а не стреляет и забывает", async () => {
    let release = null;
    const tools = toolsWith({
      readText: () => "",
      writeText: () => new Promise((res) => { release = res; }),
    });
    let settled = false;
    const running = tools.clipboardWrite({ text: "проверка" }, {}).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(settled, false, "инструмент ответил «OK», не дождавшись окончания записи");
    release();
    assert.match(await running, /OK — текст скопирован/, "после завершения записи инструмент не отчитался");
  });

  await test("буфер 44: отказ чтения объясняется человеку, а не роняет инструмент", async () => {
    const tools = toolsWith({
      readText: () => Promise.reject(new Error("нет доступа")),
      writeText: () => Promise.resolve(),
    });
    const r = await tools.clipboardRead({}, {});
    assert.match(r, /Ошибка: не удалось прочитать буфер обмена: нет доступа/, "отказ чтения не объяснён: " + r);
  });

  await test("буфер 44: отказ записи не выдаётся за успех", async () => {
    const tools = toolsWith({
      readText: () => "",
      writeText: () => Promise.reject(new Error("занят")),
    });
    const r = await tools.clipboardWrite({ text: "п" }, {});
    assert.match(r, /Ошибка: не удалось записать в буфер обмена: занят/, "отказ записи выдан за успех: " + r);
  });

  await test("буфер 33: синхронный вызов работает по-прежнему (им живёт smoke.test.js)", async () => {
    const tools = toolsWith(sync33);
    assert.match(await tools.clipboardRead({}, {}), /текст-33/, "синхронный буфер перестал читаться");
    assert.match(await tools.clipboardWrite({ text: "п" }, {}), /OK — текст скопирован/, "синхронный буфер перестал писаться");
  });

  await test("буфер 44: пустой буфер назван пустым, а не пустой строкой", async () => {
    const r = await toolsWith({ readText: () => Promise.resolve("   "), writeText: () => Promise.resolve() }).clipboardRead({}, {});
    assert.match(r, /Буфер обмена пуст/, "пустой буфер не назван пустым: " + r);
  });

  await test("в agent-tools.js не осталось синхронных вызовов буфера", () => {
    const bare = [];
    AGENT_TOOLS_SRC.split("\n").forEach((line, i) => {
      if (!/clipboard\.(readText|writeText)\(/.test(line)) return;
      if (/await\s+clipboard\.(readText|writeText)\(/.test(line)) return;
      bare.push(i + 1 + ": " + line.trim());
    });
    assert.deepStrictEqual(bare, [], "синхронный вызов вернёт Promise вместо текста:\n    " + bare.join("\n    "));
  });

  await test("вырезанные в Electron 44 API буфера нигде не зовутся", () => {
    // read()/write() в 44 переделаны под ClipboardItem (старый вызов вернёт не
    // текст), остальных методов в модуле больше нет вовсе.
    const removed = [
      "read", "write", "availableFormats", "readBookmark", "writeBookmark", "readBuffer",
      "writeBuffer", "readFindText", "writeFindText", "readHTML", "writeHTML", "readRTF",
      "writeRTF", "readImage", "writeImage",
    ];
    const found = [];
    for (const file of jsFiles(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const name of removed) {
        if (text.indexOf("clipboard." + name + "(") >= 0) found.push(path.relative(ROOT, file) + " → clipboard." + name + "()");
      }
    }
    assert.deepStrictEqual(found, [], "этих API в Electron 44 нет: " + found.join(", "));
  });

  await test("окно не тянет clipboard из electron (в 44 его там нет)", () => {
    const bad = jsFiles(path.join(SRC, "renderer"))
      .filter((f) => /require\(\s*["']electron["']\s*\)/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    assert.deepStrictEqual(bad, [], "рендерер требует electron напрямую: " + bad.join(", "));
    assert.ok(/contextBridge/.test(fs.readFileSync(path.join(SRC, "preload.js"), "utf8")), "мост contextBridge потерян");
  });

  await test("набор стоит в цепочке npm test — иначе это не набор", () => {
    const chain = String((PKG.scripts && PKG.scripts.test) || "");
    assert.ok(
      chain.indexOf("test/clipboard-tools.test.js") >= 0,
      "набор не попал в цепочку npm test (правило проекта: набор вне цепочки — это не набор)"
    );
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

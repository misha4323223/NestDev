"use strict";

/* ── Реестр агентских инструментов и вызов инструмента (src/tool-registry.js) ──
   Запуск: node test/tool-registry.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 35). Проверки бьют по местам, где ошибка
   ТИХАЯ и всплывает у пользователя:

     • потерянное имя в списке из ~120 имён — инструмент отвечает «X is not defined»
       ровно в момент вызова, в одной задаче, и выглядит как «модель тупит». Поэтому
       здесь стоит отдельная проверка: ВСЕ имена, которые распаковывает
       src/agent-tools.js, обязаны быть в объекте, который оболочка передаёт реестру;
     • забытый возврат назначения (capability) — после инструмента агент остался бы с
       чужим окружением до конца прогона, а видно это только по «не найдено» в командах;
     • исключение из обработчика, ушедшее наружу, рвёт весь прогон вместо возврата
       модели текста ошибки — модель не может исправиться;
     • «Стоп» проверяется ДО вызова обработчика: иначе остановка ждала бы конца
       инструмента (иногда это минуты).

   Стенд: настоящий модуль, настоящая политика (tool-policy.js — лист без состояния),
   поддельные только соседи: сборщик обработчиков, обёртка ошибки и живое назначение. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createToolRegistry, describeToolArgs } = require(path.join(ROOT, "src", "tool-registry.js"));
const toolPolicy = require(path.join(ROOT, "src", "tool-policy.js"));

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
const MODULE_SRC = read("src", "tool-registry.js");
const MAIN_SRC = read("src", "main.js");
// Обработчики инструментов разошлись по своим модулям (часть 40: облачные — в
// agent-tools-cloud.js, git и GitHub — в agent-tools-git.js, файлы — в
// agent-tools-files.js). Обратная проверка ниже спрашивает распаковку у ВСЕХ
// модулей дома: иначе забытое в main.js значение опять перестало бы быть видно.
const TOOLS_HOME = ["agent-tools.js", "agent-tools-cloud.js", "agent-tools-git.js", "agent-tools-files.js", "agent-tools-write.js", "agent-tools-run.js", "agent-tools-system.js", "agent-tools-net.js", "agent-tools-memory.js", "agent-tools-mission.js", "agent-tools-app.js", "agent-tools-devtools.js", "agent-tools-media.js"].map((f) => read("src", f));
const TOOLS_SRC = TOOLS_HOME[0];

/* Стенд: настоящий реестр, поддельные соседи. Назначение — коробка, по ней и видно,
   что модуль берёт ЖИВОЕ значение (экземпляр agent-env), а не своё. */
function mkRegistry(over) {
  const o = over || {};
  const box = { capability: o.capability || "desktop" };
  const calls = { builds: [], deps: null, sets: [], formats: [] };
  const handlers = Object.assign(
    {
      readFile: async (args, settings) => "прочитал " + String(args && args.path) + " в " + String(settings && settings.model),
      runCommand: async () => "команда выполнена",
      boom: async () => {
        throw new Error("обработчик упал");
      },
    },
    o.handlers || {}
  );
  const registry = createToolRegistry({
    createAgentTools: (deps) => {
      calls.builds.push(deps);
      calls.deps = deps;
      return handlers;
    },
    fmtError: (e) => {
      calls.formats.push(e);
      return "понятный текст: " + ((e && e.message) || e);
    },
    getCapability: () => box.capability,
    setCapability: (v) => {
      calls.sets.push(v);
      box.capability = v;
    },
    readFile: handlers.readFile, // имя и из «своего» списка, и из списка инструментов
  });
  return { registry, box, calls, handlers };
}

/* Разбор блока `const { … } = deps;` из модуля инструментов — так же, как это делает
   страж связи (test/backend-wiring.js): комментарии вырезаем, имя берём до двоеточия. */
function destructured(src) {
  const at = src.indexOf("} = deps;");
  assert.ok(at > 0, "в agent-tools.js нет распаковки deps");
  const open = src.lastIndexOf("const {", at);
  const block = src.slice(open + "const {".length, at);
  return block
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n")
    .split(",")
    .map((s) => s.trim().split(":").pop().trim().replace(/=.*$/, "").trim())
    .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s));
}

/* Имена, переданные реестру в проводке main.js. */
function providedToRegistry() {
  const head = MAIN_SRC.indexOf("= createToolRegistry({");
  assert.ok(head > 0, "в main.js нет проводки реестра");
  const end = MAIN_SRC.indexOf("\n});", head);
  assert.ok(end > head, "не нашёл конец проводки реестра");
  const block = MAIN_SRC.slice(MAIN_SRC.indexOf("{", head) + 1, end);
  return block
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .map((l) => l.split(":")[0].replace(/,.*$/, "").replace(/\.\.\./, "").trim())
    .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s));
}

(async () => {
  console.log("Реестр агентских инструментов и вызов инструмента");

  await test("describeToolArgs: текст берётся из политики, а не из своей копии", () => {
    assert.strictEqual(describeToolArgs("killProcess", { pid: 42, force: true }), toolPolicy.describe("killProcess", { pid: 42, force: true }), "описание аргументов разошлось с политикой");
    assert.ok(/завершить процесс/.test(describeToolArgs("killProcess", { pid: 42 })), "описание опасного действия потеряло смысл: " + describeToolArgs("killProcess", { pid: 42 }));
    // Незнакомый инструмент: политика отдаёт общее описание, и падения быть не должно —
    // этим текстом пользуется подтверждение действия в окне.
    const odd = describeToolArgs("нетТакого", { a: 1 });
    assert.strictEqual(typeof odd, "string", "незнакомый инструмент вернул не текст: " + JSON.stringify(odd));
    assert.strictEqual(odd, toolPolicy.describe("нетТакого", { a: 1 }), "для незнакомого инструмента описание собрано в обход политики");
    assert.strictEqual(typeof describeToolArgs("readFile"), "string", "описание без аргументов падает");
  });

  await test("реестр собирает обработчики один раз и получает ВЕСЬ плоский список имён", () => {
    const h = mkRegistry();
    assert.strictEqual(h.calls.builds.length, 1, "обработчики собраны не один раз: " + h.calls.builds.length);
    assert.strictEqual(h.calls.deps.createAgentTools, h.calls.deps.createAgentTools, "список потерял сборщик обработчиков");
    assert.strictEqual(typeof h.calls.deps.createAgentTools, "function", "сборщик обработчиков не дошёл до инструментов");
    assert.strictEqual(typeof h.calls.deps.fmtError, "function", "обёртка ошибки не дошла до инструментов");
    assert.strictEqual(typeof h.calls.deps.getCapability, "function", "живое назначение не дошло до реестра");
    assert.strictEqual(typeof h.calls.deps.setCapability, "function", "запись назначения не дошла до реестра");
    assert.strictEqual(typeof h.calls.deps.readFile, "function", "имя инструмента не дошло до реестра");
    // Вложенный объект не заводится: имена уходят тем же плоским объектом, что и раньше.
    assert.strictEqual(h.calls.deps.tools, undefined, "список имён завернули в отдельный объект — проводка поедет");
    assert.strictEqual(typeof h.registry.executeTool, "function", "реестр не отдал вызов инструмента");
  });

  await test("executeTool: выбирает обработчик, отдаёт ответ и пропускает настройки", async () => {
    const h = mkRegistry();
    const r = await h.registry.executeTool("readFile", { path: "/tmp/a.txt" }, { model: "test-model" });
    assert.strictEqual(r, "прочитал /tmp/a.txt в test-model", "ответ обработчика не дошёл: " + r);
    const r2 = await h.registry.executeTool("runCommand", undefined, undefined);
    assert.strictEqual(r2, "команда выполнена", "вызов без аргументов сломался: " + r2);
    // Без аргументов обработчик обязан получить пустой объект, а не undefined:
    // на этом стоит весь разбор args внутри инструментов.
    const seen = [];
    const h2 = mkRegistry({ handlers: { probe: async (args) => (seen.push(args), "ок") } });
    await h2.registry.executeTool("probe");
    assert.deepStrictEqual(seen[0], {}, "обработчик получил undefined вместо пустых аргументов");
  });

  await test("незнакомый инструмент: понятный текст, а не падение прогона", async () => {
    const h = mkRegistry();
    const r = await h.registry.executeTool("такого-нет", {}, {});
    assert.strictEqual(r, "Ошибка: неизвестный инструмент такого-нет", "текст про неизвестный инструмент изменился: " + r);
    assert.strictEqual(h.box.capability, "desktop", "после неизвестного инструмента назначение сбилось: " + h.box.capability);
    assert.deepStrictEqual(h.calls.sets, [toolPolicy.capabilityOf("такого-нет"), "desktop"], "назначение не вернулось после неизвестного инструмента: " + JSON.stringify(h.calls.sets));
  });

  await test("назначение объявляется на время вызова и возвращается в finally", async () => {
    const h = mkRegistry();
    await h.registry.executeTool("readFile", { path: "x" }, {});
    assert.deepStrictEqual(h.calls.sets, [toolPolicy.capabilityOf("readFile"), "desktop"], "назначение инструмента не объявлено или не возвращено: " + JSON.stringify(h.calls.sets));
    assert.strictEqual(toolPolicy.capabilityOf("readFile"), "files.read", "политика перестала давать назначение чтению файлов");

    // Вложенный вызов возвращает СВОЁ: после внутреннего инструмента агент снова с
    // назначением внешнего, а после внешнего — с тем, что было до него. Имена берём
    // НАСТОЯЩИЕ и с разными назначениями — иначе проверка ничего не измеряет.
    const trace = [];
    const h2 = mkRegistry({
      capability: "terminal.execute",
      handlers: {
        writeFile: async () => {
          trace.push(h2.box.capability);
          const inner = await h2.registry.executeTool("readFile", {}, {});
          trace.push(h2.box.capability);
          return "внутри: " + inner;
        },
      },
    });
    assert.strictEqual(toolPolicy.capabilityOf("writeFile"), "files.write", "политика перестала давать назначение записи файлов");
    assert.strictEqual(toolPolicy.capabilityOf("runCommand"), "terminal.execute", "назначение команд оболочки изменилось");
    await h2.registry.executeTool("writeFile", {}, {});
    assert.deepStrictEqual(trace, ["files.write", "files.write"], "вложенный вызов не вернул назначение внешнего инструмента: " + JSON.stringify(trace));
    assert.strictEqual(h2.box.capability, "terminal.execute", "после внешнего инструмента назначение не вернулось к прежнему: " + h2.box.capability);
  });

  await test("сбой обработчика: модель получает текст ошибки, назначение возвращается", async () => {
    const h = mkRegistry();
    const r = await h.registry.executeTool("boom", {}, {});
    assert.strictEqual(r, "Ошибка: понятный текст: обработчик упал", "сбой обработчика не превращён в текст для модели: " + r);
    assert.strictEqual(h.calls.formats.length, 1, "ошибка не прошла через общую обёртку: " + h.calls.formats.length);
    assert.ok(h.calls.formats[0] instanceof Error, "в обёртку ушло не исключение: " + JSON.stringify(h.calls.formats[0]));
    assert.strictEqual(h.box.capability, "desktop", "после сбоя назначение осталось чужим: " + h.box.capability);
    // Именно порядок «сначала сбой, потом возврат»: верни модуль назначение до вызова
    // обработчика — и инструмент работал бы с окружением предыдущего.
    assert.deepStrictEqual(h.calls.sets, [toolPolicy.capabilityOf("boom"), "desktop"], "порядок объявления и возврата назначения не тот: " + JSON.stringify(h.calls.sets));
  });

  await test("«Стоп»: до вызова обработчика, с понятным текстом и наведённым порядком", async () => {
    const h = mkRegistry();
    let called = 0;
    const h2 = mkRegistry({ handlers: { runCommand: async () => (called++, "выполнено") } });
    global.__agentStopRequested = true;
    try {
      const r = await h2.registry.executeTool("runCommand", {}, {});
      assert.ok(/Остановлено пользователем/.test(r), "остановка не объяснена модели: " + r);
      assert.ok(/прекрати вызовы инструментов/.test(r), "текст остановки не просит прекратить работу: " + r);
      assert.strictEqual(called, 0, "обработчик всё-таки выполнился после «Стоп»");
      assert.strictEqual(h2.box.capability, "desktop", "после остановки назначение осталось чужим");
    } finally {
      global.__agentStopRequested = false;
    }
    // Флаг снят — инструмент работает снова (остановка не «залипает»).
    const r2 = await h2.registry.executeTool("runCommand", {}, {});
    assert.strictEqual(r2, "выполнено", "после снятия флага инструмент не выполнился: " + r2);
    assert.strictEqual(called, 1, "вызовов обработчика: " + called);
    void h;
  });

  await test("проводка: все имена инструментов переданы реестру (обратная проверка стража)", () => {
    const needed = [...new Set(TOOLS_HOME.flatMap((src) => destructured(src)))];
    assert.ok(needed.length > 100, "распаковка дома инструментов разобрана подозрительно мало: " + needed.length);
    const provided = new Set(providedToRegistry());
    const missing = needed.filter((n) => !provided.has(n));
    assert.deepStrictEqual(missing, [], "инструменты не получили имён (инструмент ответит «is not defined»): " + missing.join(", "));
    for (const own of ["createAgentTools", "fmtError", "getCapability", "setCapability"]) {
      assert.ok(provided.has(own), "реестр не получил своё: " + own);
    }
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте и вовремя", () => {
    for (const gone of ["async function executeTool(", "const agentToolHandlers =", "function describeToolArgs(", "toolPolicy.describe("]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(MAIN_SRC.includes('require("./tool-registry.js")'), "модуль не подключён");
    assert.ok(MAIN_SRC.includes("= createToolRegistry({"), "реестр не собирается в оболочке");
    // Описание аргументов нужно прогону — значит, модуль взят ВЫШЕ прогона;
    // сам реестр собирается НИЖЕ, после всего, чем живут инструменты.
    const req = MAIN_SRC.indexOf('require("./tool-registry.js")');
    const run = MAIN_SRC.indexOf("const { runAi } = createRunAi({");
    const build = MAIN_SRC.indexOf("= createToolRegistry({");
    assert.ok(req < run, "модуль взят ниже прогона — описание аргументов не дошло бы");
    assert.ok(run < build, "реестр собран выше прогона — вызов инструмента ушёл бы пустым");
    for (const before of ["const agentEnvState = createAgentEnv({", "const { createRunMission } = require(\"./run-mission.js\")", "const { createYcService } = require(\"./yc-service.js\")"]) {
      assert.ok(MAIN_SRC.indexOf(before) < build, "реестр собран раньше своего: " + before);
    }
    // Вызов инструмента уходит прогону отложенной стрелкой: реестр собирается ниже.
    assert.ok(MAIN_SRC.includes("executeTool: (...toolArgs) => executeTool(...toolArgs)"), "executeTool передан значением до сборки реестра");
    // Модуль не держит состояния уровня файла и не достаёт ничего сам, кроме политики.
    assert.ok(!/^let |^var /m.test(MODULE_SRC), "в модуле завелось состояние уровня файла");
    assert.ok(!/app\.getPath|__dirname|require\("\.\/agent-tools/.test(MODULE_SRC), "модуль сам достаёт состояние вместо внедрения");
    assert.ok(MODULE_SRC.includes('require("./tool-policy.js")'), "модуль перестал брать политику (тексты подтверждений живут там)");
  });

  console.log("\nРеестр агентских инструментов: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

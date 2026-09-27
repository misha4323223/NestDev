"use strict";

/* ── Терминал от администратора (openAdminTerminal, src/system-stack.js) ──────
   Запуск: node test/admin-terminal.test.js   (входит в общий `npm test`)

   Зачем набор. runCommandAsAdmin выполняет РАЗОВУЮ команду и ждёт её конца, но
   человеку иногда нужен именно ЖИВОЙ администраторский терминал — поработать в нём
   руками. Новый инструмент openAdminTerminal открывает окно PowerShell от админа.

   Запрос UAC в тесте не нажать, поэтому проверяется ПЛАН запуска (чистая функция
   adminTerminalPlan): какой процесс открывается и с какими аргументами, что команда
   уезжает ЗАКОДИРОВАННОЙ (кавычки и пробелы её не ломают) и что на не-Windows
   инструмент честно указывает на runCommandAsAdmin, а не делает вид, что окно
   открылось. Плюс — сквозная проводка: политика, схема, ядро, промпт, реестр и дом
   инструментов, как устроено у остальных инструментов. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

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
const { createSystemStack } = require(path.join(ROOT, "src", "system-stack.js"));
const toolPolicy = require(path.join(ROOT, "src", "tool-policy.js"));
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

const UI_FILE = read("src", "agent-tools-run.js");
const AGENT_TOOLS = read("src", "agent-tools.js");
const MAIN_SRC = read("src", "main.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const SCHEMA_SRC = read("src", "renderer", "tool-schemas.js");
const LIVE_SRC = read("scripts", "live-tools-run.js");
const PKG = JSON.parse(read("package.json"));

// Стек собираем ЧИСТЫМИ заглушками: до вызова openAdminTerminal ни одна из них не
// нужна, а запускать админский процесс в наборе нельзя.
function makeStack(spawn) {
  return createSystemStack({
    fs,
    path,
    os,
    spawn: spawn || (() => ({ on() {}, once() {}, kill() {}, stdio: [], unref() {} })),
    winPs: null,
    probeEnv: () => ({}),
    stripAnsi: (s) => String(s == null ? "" : s),
    runTerminalCommand: async () => "",
    live: { envFor: () => ({}) },
  });
}

const decode = (b64) => Buffer.from(String(b64), "base64").toString("utf16le");

(async () => {
  console.log("\n[1] План запуска: что именно открывается");

  await test("openAdminTerminal: Windows открывает PowerShell от админа через Start-Process -Verb RunAs", () => {
    const plan = makeStack().adminTerminalPlan("win32", {});
    assert.strictEqual(plan.ok, true, "план для Windows не собрался: " + JSON.stringify(plan));
    assert.strictEqual(plan.argv[0], "powershell.exe", "запускается не powershell.exe: " + plan.argv[0]);
    assert.ok(plan.argv.indexOf("-NonInteractive") >= 0, "запускатель не в неинтерактивном режиме");
    const outer = decode(plan.argv[plan.argv.length - 1]);
    assert.ok(/Start-Process -FilePath 'powershell\.exe' -Verb RunAs/.test(outer),
      "нет запроса прав (Verb RunAs): " + outer);
    assert.ok(/-NoExit/.test(outer), "окно закроется сразу — нет -NoExit");
    assert.ok(/-NoProfile/.test(outer), "нет -NoProfile (профиль может мешать)");
    assert.ok(!/-EncodedCommand/.test(outer), "команды нет, а внутренняя команда почему-то есть");
    assert.ok(/администратор/i.test(plan.note), "в ответе не сказано, что окно от администратора: " + plan.note);
    assert.ok(/UAC/i.test(plan.note), "в ответе нет подсказки про запрос прав (UAC): " + plan.note);
  });

  await test("openAdminTerminal: команда уезжает закодированной — кавычки и пробелы её не ломают", () => {
    const cmd = 'echo "привет мир" > C:\\temp\\a b.txt';
    const plan = makeStack().adminTerminalPlan("win32", { command: cmd });
    const outer = decode(plan.argv[plan.argv.length - 1]);
    const m = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer);
    assert.ok(m, "команда не уехала закодированной: " + outer);
    assert.strictEqual(decode(m[1]), cmd, "команда не совпала с исходной");
    assert.ok(/-NoExit/.test(outer), "окно с командой закроется сразу");
  });

  await test("openAdminTerminal: на не-Windows — честный отказ со ссылкой на рабочую команду", () => {
    const stack = makeStack();
    for (const [plat, word] of [["darwin", "macOS"], ["linux", "Linux"]]) {
      const plan = stack.adminTerminalPlan(plat, {});
      assert.strictEqual(plan.ok, false, plat + ": окно обещано, хотя его нет");
      assert.ok(/runCommandAsAdmin/.test(plan.reason), plat + ": нет ссылки на рабочий механизм: " + plan.reason);
      assert.ok(plan.reason.indexOf(word) >= 0, plat + ": не названа ОС: " + plan.reason);
    }
  });

  await test("openAdminTerminal: на не-Windows окно НЕ открывается (ни одного запуска)", async () => {
    if (process.platform === "win32") {
      console.log("    (пропуск: мы на Windows — вызов открыл бы настоящий UAC)");
      return;
    }
    let spawned = 0;
    const stack = makeStack(() => {
      spawned++;
      return { on() {}, once() {}, kill() {}, stdio: [], unref() {} };
    });
    const out = await stack.openAdminTerminal({ command: "echo x" });
    assert.strictEqual(spawned, 0, "на не-Windows запускатель всё-таки побежал");
    assert.ok(/runCommandAsAdmin/.test(out), "нет честного ответа: " + out);
    assert.strictEqual(typeof stack.openAdminTerminal, "function", "openAdminTerminal не отдан наружу");
    assert.strictEqual(typeof stack.adminTerminalPlan, "function", "adminTerminalPlan не отдан наружу");
  });

  console.log("\n[2] Проводка инструмента (как у остальных)");

  await test("openAdminTerminal: обработчик, дом и реестр на месте", () => {
    assert.ok(/runAsAdmin,\s*\n\s*openAdminTerminal,/.test(UI_FILE), "дома нет зависимости openAdminTerminal");
    assert.ok(/"openAdminTerminal": async \(args, settings\) =>/.test(UI_FILE), "в доме нет обработчика");
    assert.ok(/await openAdminTerminal\(\{ command: args\.command \}\)/.test(UI_FILE), "обработчик не зовёт помощник");
    assert.ok(/"openAdminTerminal": run\.openAdminTerminal,/.test(AGENT_TOOLS), "инструмент не в реестре");
  });

  await test("openAdminTerminal: имя дошло до сборки из main.js (иначе «is not defined»)", () => {
    assert.ok(/openAdminTerminal,\s*\n\} = systemStack;/.test(MAIN_SRC), "имя не взято из system-stack в main.js");
    // В блоке сборки инструментов имя должно стоять (два места, как у runAsAdmin).
    assert.ok(MAIN_SRC.split("openAdminTerminal").length - 1 >= 2, "имя не передано в сборку инструментов");
  });

  await test("openAdminTerminal: политика — высокий риск и обязательное подтверждение", () => {
    assert.strictEqual(toolPolicy.capabilityOf("openAdminTerminal"), "terminal.admin",
      "назначение инструмента не terminal.admin");
    assert.strictEqual(toolPolicy.riskOf("openAdminTerminal"), "high", "риск не высокий");
    assert.strictEqual(toolPolicy.needsConfirm("openAdminTerminal"), true, "окно от админа открывается без подтверждения");
    assert.ok(/открыть окно PowerShell от администратора/.test(toolPolicy.describe("openAdminTerminal", { command: "whoami" })),
      "подтверждение не описывает действие: " + toolPolicy.describe("openAdminTerminal", { command: "whoami" }));
  });

  await test("openAdminTerminal: схема, алиасы и группа у ядра согласованы", () => {
    const defs = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    assert.ok(defs.includes("openAdminTerminal"), "нет описания инструмента для модели");
    assert.strictEqual(core.groupOfTool("openAdminTerminal"), "system",
      "инструмент не попал в группу «система» — при малом окне модель его не увидит");
    // Алиасы: модель может позвать под своим именем — имя подменяется на настоящее.
    for (const a of ["open_admin_terminal", "openadminterminal", "admin_terminal"]) {
      assert.strictEqual(core.normalizeToolName(a), "openAdminTerminal", "нет алиаса " + a);
    }
  });

  await test("openAdminTerminal: назван в промпте и в схеме, живой прогон его ждёт", () => {
    const list = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/openAdminTerminal/.test(list), "инструмента нет в списке для модели");
    assert.ok(/живое окно PowerShell/.test(PROMPTS_SRC), "правило про админа не объясняет живое окно");
    assert.ok(/name: "openAdminTerminal"/.test(SCHEMA_SRC), "нет схемы инструмента");
    assert.ok(/"openAdminTerminal"/.test(LIVE_SRC), "живой прогон не ждёт этот инструмент в доме");
  });

  await test("openAdminTerminal: набор стоит в цепочке npm test", () => {
    const chain = String((PKG.scripts && PKG.scripts.test) || "");
    assert.ok(chain.indexOf("test/admin-terminal.test.js") >= 0,
      "набор не попал в цепочку npm test (правило проекта: набор вне цепочки — это не набор)");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ── Просьба не по роли: агент предлагает переключиться (agent-core + прогон) ──
   Запуск: node test/role-mismatch.test.js   (входит в общий `npm test`)

   Роль — РЕЖИМ ЧАТА (Разработчик / Ассистент / Менеджер / Исследователь), и меняет её
   только человек: агент лишь предлагает инструментом suggestRole, а окно показывает
   кнопку. Правило «предложи переключить роль» есть в промпте (пункт 36), но слабые
   модели его пропускают: человек просит код в роли Ассистента — и окна с кнопкой нет.
   Поэтому признак «просьба про код, а роль другая» считается в ЯДРЕ (не по памяти
   модели), уходит в системный промпт прямой командой и один раз подтверждается
   призывом в src/run-nudge.js.

   Здесь проверяется:

     • признак просьбы о коде: глагол+существительное, имена файлов, слова разработки;
     • «напиши письмо» и «собери отчёт» кодом НЕ считаются — иначе подсказка шумела бы;
     • в роли «Разработчик» подсказки нет никогда, в чужих ролях — есть и называет dev;
     • смотрим ТОЛЬКО последнюю просьбу человека: старая переписка про код не тянет
       подсказку вечно;
     • подсказка и призыв реально подключены: в промпте run-ai.js и в createRunNudge. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
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

const user = (content) => ({ role: "user", content: content });
const codeAsk = [user("Напиши мне функцию на Python: разбор csv")];

(async () => {
  await test("признак просьбы о коде: глагол и предмет, имена файлов, слова разработки", () => {
    assert.strictEqual(AgentCore.looksLikeCodeRequest("напиши функцию разбора csv"), true, "«напиши функцию» не распознано");
    assert.strictEqual(AgentCore.looksLikeCodeRequest("почини баг в приложении"), true, "баг не распознан");
    assert.strictEqual(AgentCore.looksLikeCodeRequest("исправь ошибку в src/app.js"), true, "имя файла не распознано");
    assert.strictEqual(AgentCore.looksLikeCodeRequest("сделай рефакторинг модуля"), true, "рефакторинг не распознан");
    assert.strictEqual(AgentCore.looksLikeCodeRequest("добавь endpoint /users"), true, "endpoint не распознан");
    assert.strictEqual(AgentCore.looksLikeCodeRequest("собери проект и запусти тесты"), true, "сборка проекта не распознана");
    assert.strictEqual(AgentCore.looksLikeCodeRequest(""), false, "пустая строка — не код");
    assert.strictEqual(AgentCore.looksLikeCodeRequest("продолжай"), false, "«продолжай» — не код");
  });

  await test("обычные дела НЕ считаются кодом — иначе подсказка шумела бы", () => {
    for (const t of [
      "Напиши письмо клиенту про перенос встречи",
      "Собери отчёт за неделю по делам",
      "Спланируй мой день",
      "Разбери входящие и занеси сроки",
      "Найди и разбери: чем отличается X от Y",
      "Сделай выжимку из файла отчёта",
      "Что у меня на сегодня?",
    ]) {
      assert.strictEqual(AgentCore.looksLikeCodeRequest(t), false, "ложное срабатывание: " + t);
    }
  });

  await test("подсказка: в роли «Разработчик» её нет никогда", () => {
    assert.strictEqual(AgentCore.roleMismatchNote(codeAsk, "dev"), "", "подсказка в роли Разработчика");
    assert.strictEqual(AgentCore.roleMismatchNote(codeAsk, ""), "", "мусорная роль должна стать dev");
  });

  await test("подсказка: в чужой роли она называет dev, suggestRole и запрещает молчать", () => {
    for (const role of ["assistant", "manager", "researcher"]) {
      const note = AgentCore.roleMismatchNote(codeAsk, role);
      assert.ok(note.length > 0, "нет подсказки для роли " + role);
      assert.ok(/suggestRole/.test(note), "в подсказке нет suggestRole: " + role);
      assert.ok(/role: "dev"/.test(note), "подсказка не называет роль dev: " + role);
      assert.ok(/ПРОСЬБА НЕ ПО РОЛИ/.test(note), "нет пометки о смене роли: " + role);
      assert.ok(/не пиши код молча/.test(note), "подсказка не запрещает молча писать код: " + role);
    }
  });

  await test("подсказка: смотрим только ПОСЛЕДНЮЮ просьбу — старая просьба про код не тянет её вечно", () => {
    const history = [user("напиши функцию на js"), { role: "assistant", content: "готово" }, user("а теперь спланируй мой день")];
    assert.strictEqual(AgentCore.roleMismatchNote(history, "assistant"), "", "старая просьба про код не должна тянуть подсказку");
    const back = [user("спланируй день"), { role: "assistant", content: "ок" }, user("теперь исправь баг в app.js")];
    assert.ok(AgentCore.roleMismatchNote(back, "assistant").length > 0, "последняя просьба про код не распознана");
  });

  await test("подсказка: просьба без кода в чужой роли — пустая строка, промпт не меняется", () => {
    assert.strictEqual(AgentCore.roleMismatchNote([user("разбери входящие")], "manager"), "", "подсказка без кода");
    assert.strictEqual(AgentCore.roleMismatchNote([], "assistant"), "", "пустая история — подсказки нет");
    assert.strictEqual(AgentCore.roleMismatchNote(null, "assistant"), "", "null вместо истории не должен падать");
  });

  await test("подсказка умеет читать части контента (картинка + текст), как в настоящем прогоне", () => {
    const msg = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:" } }, { type: "text", text: "исправь баг в этом коде" }] }];
    assert.ok(AgentCore.roleMismatchNote(msg, "assistant").length > 0, "текстовая часть просьбы не прочитана");
  });

  await test("подсказка подключена к промпту прогона и к призыву", () => {
    const runSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    const nudgeSrc = fs.readFileSync(path.join(ROOT, "src", "run-nudge.js"), "utf8");
    const webSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "web-chat.js"), "utf8");
    assert.ok(/roleMismatchNote\(messages, role\.id\)/.test(runSrc), "подсказка не считается в прогоне");
    // Между текстом роли и подсказкой стоит блок папки роли (часть 61) — он пуст,
    // когда папка не задана, поэтому порядок здесь проверяется с ним.
    assert.ok(/SYSTEM_PROMPT \+ roleNote \+ (roleFolderNote \+ )?mismatchNote/.test(runSrc), "подсказка не уходит в системный промпт");
    assert.ok(/getRoleMismatch: \(\) => mismatchNote/.test(runSrc), "прогон не отдаёт подсказку призыву");
    assert.ok(/getRoleMismatch/.test(nudgeSrc), "призыв не читает подсказку");
    assert.ok(/suggestRole/.test(nudgeSrc), "призыв не просит предложить роль");
    assert.ok(/roleNudges < 1/.test(nudgeSrc), "призыв по роли не ограничен одним разом");
    // Веб-режим (телефон): там роль раньше вообще не ехала в промпт.
    assert.ok(/webRole\.prompt/.test(webSrc), "веб-режим не отправляет текст роли");
    assert.ok(/AgentCore\.roleMismatchNote\(messages, webRole\.id\)/.test(webSrc), "веб-режим не отправляет подсказку");
    // Оболочка прокидывает то же имя в прогон (иначе функция пришла бы undefined).
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(/roleMismatchNote,/.test(mainSrc), "main.js не прокидывает roleMismatchNote в прогон");
  });

  await test("роли по-прежнему полный список, и suggestion-варианты не предлагают ту же роль", () => {
    const ids = AgentCore.AGENT_ROLES.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ["assistant", "dev", "manager", "researcher"], "состав ролей изменился: " + ids);
    for (const r of AgentCore.AGENT_ROLES) {
      const opts = AgentCore.roleSuggestOptions(r.id);
      assert.strictEqual(opts.length, AgentCore.AGENT_ROLES.length - 1, "вариантов предложения не N-1: " + r.id);
      assert.ok(!opts.some((o) => o.id === r.id), "роль предлагается сама себе: " + r.id);
      assert.ok(opts.every((o) => o.reason && o.reason.length > 0), "у варианта нет причины: " + r.id);
    }
  });

  await test("Ассистент заточен под дела ПК: есть текст режима, чипы и группы инструментов", () => {
    const plan = AgentCore.rolePlan("assistant");
    assert.ok(plan.prompt && /РЕЖИМ «АССИСТЕНТ»/.test(plan.prompt), "потерян текст режима Ассистента");
    assert.ok(/Разработчик/.test(plan.prompt) && /код/i.test(plan.prompt), "в режиме Ассистента нет правила про код");
    for (const g of ["notes", "mail", "system", "browser", "files", "terminal", "vault", "sheets"]) {
      assert.ok(plan.groups.indexOf(g) >= 0, "Ассистенту не хватает группы инструментов: " + g);
    }
    assert.ok(plan.chips.length >= 4, "у Ассистента нет подсказок-чипов");
    // Менеджер тоже получает таблицы: отчёты — его работа.
    assert.ok(AgentCore.rolePlan("manager").groups.indexOf("sheets") >= 0, "Менеджеру не хватает группы таблиц");
    // «Разработчик» — обычный режим приложения: у него нет своего текста роли, и это
    // намеренно (базовый промпт уже про код). Появление текста здесь сузило бы режим.
    assert.strictEqual(AgentCore.rolePlan("dev").prompt, "", "у Разработчика появился текст режима");
    assert.deepStrictEqual(AgentCore.rolePlan("dev").groups, [], "Разработчику назначены группы — режим сузился");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

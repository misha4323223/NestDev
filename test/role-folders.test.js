"use strict";

/* ── Папки ролей: промт роли из файла (src/role-folders.js) ───────────────────
   Запуск: node test/role-folders.test.js   (входит в общий `npm test`)

   Зачем набор. В настройках у КАЖДОЙ роли (Разработчик / Ассистент / Менеджер /
   Исследователь) — и у КАЖДОГО проекта своя — задаётся папка; когда чат работает
   в этой роли, приложение читает из папки файл PROMPT.md и дописывает его в
   системный промпт рядом с «САММАРИ ПРОЕКТА». Так у роли появляется свой тон,
   правила и знание о бренде, и человеку не надо напоминать о них руками.

   Ошибки здесь тихие и дорогие, поэтому проверяется поведение, а не «строка на
   месте»: пустая настройка ОБЯЗАНА оставить промпт без изменений (иначе поедут
   все замеры бюджета), недоступная папка — не уронить прогон, длинный файл —
   не съесть контекст, а мусор в настройке — не доехать до модели.

   Файлы настоящие (временная папка), ядро ролей — настоящее (agent-core.js):
   список ролей здесь и в ядре обязан совпадать. */

const assert = require("assert");
const fs = require("fs");
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
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const { createRoleFolders } = require(path.join(ROOT, "src", "role-folders.js"));
const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const rf = createRoleFolders({ fs, path });

const MAIN_SRC = read("src", "main.js");
const RUN_AI_SRC = read("src", "run-ai.js");
const STORE_SRC = read("src", "settings-store.js");
const HTML_SRC = read("src", "renderer", "index.html");
const PANEL_SRC = read("src", "renderer", "settings-panel.js");
const PKG_SRC = read("package.json");

// Папка с файлом промта: пишем тем же именем, что и человек.
function roleFolderWith(name, text) {
  const dir = tmp("role-folder-");
  fs.writeFileSync(path.join(dir, name), text, "utf8");
  return dir;
}

(async () => {
  console.log("\n[1] Раскладка папок: мусор не доезжает до модели");

  await test("чистка раскладки: чужие роли, не-строки и массивы отбрасываются", () => {
    const dirty = {
      "p1": { dev: "  D:\\Роли\\dev\\  ", assistant: 42, manager: null, researcher: ["x"], чужое: "/tmp/x" },
      "p2": { dev: "", assistant: "", manager: "", researcher: "   " },
      "": { dev: "/tmp/ничей" },
      "p3": "не объект",
      "p4": null,
    };
    const clean = rf.normalizeRoleDirs(dirty);
    assert.deepStrictEqual(clean.p1, { dev: "D:\\Роли\\dev", assistant: "", manager: "", researcher: "" },
      "мусор не вычищен: " + JSON.stringify(clean.p1));
    assert.strictEqual(clean.p2, undefined, "пустая запись проекта осталась");
    assert.strictEqual(clean[""], undefined, "запись без id проекта осталась");
    assert.strictEqual(clean.p3, undefined, "строка на месте карты прошла");
    assert.strictEqual(clean.p4, undefined, "null на месте карты прошёл");
    assert.strictEqual(clean.p1.чужое, undefined, "чужая роль прошла в раскладку");
  });

  await test("мусор вместо раскладки целиком — пустая карта, а не падение", () => {
    for (const bad of [null, undefined, "строка", 42, [], true]) {
      assert.deepStrictEqual(rf.normalizeRoleDirs(bad), {}, "из " + JSON.stringify(bad) + " вышла не пустая карта");
    }
  });

  console.log("\n[2] Папка активного проекта и роли");

  await test("папка роли берётся у АКТИВНОГО проекта", () => {
    const settings = {
      activeProjectId: "p2",
      roleDirs: { p1: { manager: "D:\\Роли\\один" }, p2: { manager: "D:\\Роли\\два" } },
    };
    assert.strictEqual(rf.roleDir(settings, "manager"), "D:\\Роли\\два", "взята папка не того проекта");
    settings.activeProjectId = "p1";
    assert.strictEqual(rf.roleDir(settings, "manager"), "D:\\Роли\\один", "папка не сменилась с проектом");
  });

  await test("нет активного проекта или роль неизвестна — путь пустой", () => {
    assert.strictEqual(rf.roleDir({ roleDirs: { p1: { dev: "/tmp/a" } } }, "dev"), "", "путь без активного проекта");
    assert.strictEqual(rf.roleDir({ activeProjectId: "p1", roleDirs: { p1: { dev: "/tmp/a" } } }, "чужероль"), "", "чужая роль");
    assert.strictEqual(rf.roleDir({ activeProjectId: "p9", roleDirs: { p1: { dev: "/tmp/a" } } }, "dev"), "", "чужой проект");
    assert.strictEqual(rf.dirsForSettings({ activeProjectId: "p1", roleDirs: { p1: { dev: "/tmp/a" } } }).dev, "/tmp/a");
  });

  console.log("\n[3] Чтение PROMPT.md");

  await test("файл находится по имени, BOM и CRLF чистятся", () => {
    const dir = tmp("role-bom-");
    fs.writeFileSync(path.join(dir, "PROMPT.md"), "\uFEFFМенеджер: тон дружелюбный\r\nВ КП — цена и срок\r\n", "utf8");
    const r = rf.readRolePrompt(dir);
    assert.strictEqual(r.ok, true, "файл не нашёлся: " + r.error);
    assert.strictEqual(r.name, "PROMPT.md", "имя файла потеряно");
    assert.ok(r.text.indexOf("\uFEFF") < 0, "BOM остался в тексте");
    assert.ok(r.text.indexOf("\r") < 0, "CRLF остался в тексте");
    assert.ok(/^Менеджер: тон дружелюбный/.test(r.text), "текст не тот: " + r.text.slice(0, 40));
  });

  await test("пустой файл, папка без файла, отсутствующая папка — честный отказ", () => {
    const empty = roleFolderWith("PROMPT.md", "   \n  ");
    const r1 = rf.readRolePrompt(empty);
    assert.strictEqual(r1.ok, false, "пустой файл принят за промт");
    const bare = tmp("role-bare-");
    const r2 = rf.readRolePrompt(bare);
    assert.strictEqual(r2.ok, false, "папка без PROMPT.md принята за промт");
    assert.ok(/PROMPT\.md/.test(r2.error), "в отказе не сказано про PROMPT.md: " + r2.error);
    const r3 = rf.readRolePrompt(path.join(bare, "нет-такой-папки"));
    assert.strictEqual(r3.ok, false, "несуществующая папка принята за промт");
    const r4 = rf.readRolePrompt("");
    assert.strictEqual(r4.ok, false, "пустой путь принят за промт");
    // Папку подменили файлом: чтение каталога падать не должно.
    const notDir = path.join(tmp("role-file-"), "файл.txt");
    fs.writeFileSync(notDir, "я файл, а не папка", "utf8");
    assert.strictEqual(rf.readRolePrompt(notDir).ok, false, "файл вместо папки не отвергнут");
  });

  await test("длинный файл обрезается с ДВУХ концов и честно об этом говорит", () => {
    const text = "НАЧАЛО-" + "я".repeat(rf.PROMPT_MAX_CHARS * 2) + "-КОНЕЦ";
    const dir = roleFolderWith("prompt.md", text);
    const r = rf.readRolePrompt(dir);
    assert.strictEqual(r.ok, true, "длинный файл не прочитан");
    assert.ok(r.text.length < text.length, "файл не обрезан вовсе");
    assert.ok(r.text.indexOf("НАЧАЛО-") === 0, "потеряно начало файла");
    assert.ok(/-КОНЕЦ$/.test(r.text), "потерян конец файла (правила бывают и в хвосте)");
    assert.ok(/не целиком/.test(r.text), "нет пометки про обрезку");
  });

  console.log("\n[4] Блок в системный промпт");

  await test("папка не задана — блока нет (промпт не меняется)", () => {
    assert.strictEqual(rf.blockFor({}, "manager", "Менеджер"), "", "блок появился без настройки");
    assert.strictEqual(rf.blockFor({ activeProjectId: "p1", roleDirs: {} }, "manager", "Менеджер"), "", "блок без папки проекта");
    const emptyDir = tmp("role-empty-");
    const s = { activeProjectId: "p1", roleDirs: { p1: { manager: emptyDir } } };
    assert.strictEqual(rf.blockFor(s, "manager", "Менеджер"), "", "блок из папки без PROMPT.md");
    const gone = { activeProjectId: "p1", roleDirs: { p1: { manager: path.join(emptyDir, "нет") } } };
    assert.strictEqual(rf.blockFor(gone, "manager", "Менеджер"), "", "блок из несуществующей папки");
  });

  await test("блок несёт титул роли, путь папки и текст файла", () => {
    const dir = roleFolderWith("PROMPT.md", "Ты пишешь КП в тоне «дружелюбно, без канцелярита».");
    const s = { activeProjectId: "p1", roleDirs: { p1: { manager: dir } } };
    const block = rf.blockFor(s, "manager", "Менеджер");
    assert.ok(/ПАПКА РОЛИ «Менеджер»/.test(block), "в блоке нет названия роли");
    assert.ok(block.indexOf(dir) > 0, "в блоке нет пути папки (агент не знает, где искать)");
    assert.ok(/PROMPT\.md/.test(block), "в блоке не сказано, откуда текст");
    assert.ok(block.indexOf("«дружелюбно, без канцелярита»") > block.indexOf(dir), "текст промта уехал выше пути");
    assert.ok(/listDirectory|readFile/.test(block), "агенту не сказано, как читать остальные файлы роли");
  });

  console.log("\n[5] Согласованность ролей и проводка");

  await test("список ролей совпадает с ядром", () => {
    const core = AgentCore.AGENT_ROLES.map((r) => r.id);
    assert.deepStrictEqual(rf.ROLE_IDS, core, "роли в модуле разошлись с ядром: " + JSON.stringify(core));
  });

  await test("папки ролей есть в схеме настроек и переживают запись/чтение", () => {
    assert.ok(STORE_SRC.indexOf("roleDirs: {}") >= 0, "в схеме настроек нет roleDirs");
    assert.ok(/s\.roleDirs = \{\}/.test(STORE_SRC), "форма roleDirs не чистится в normalizeSettings");
    // Живая проверка: собираем НАСТОЯЩЕЕ хранилище (как это делает main.js) и
    // прогоняем запись/чтение — карта обязана вернуться без потерь.
    const secrets = require(path.join(ROOT, "src", "secrets.js"));
    const toolPolicy = require(path.join(ROOT, "src", "tool-policy.js"));
    const vault = require(path.join(ROOT, "src", "vault.js"));
    const dir = tmp("role-store-");
    const appDir = path.join(dir, "userData");
    fs.mkdirSync(appDir, { recursive: true });
    secrets.init(path.join(appDir, "secrets.json"));
    const { createSettingsStore } = require(path.join(ROOT, "src", "settings-store.js"));
    const store = createSettingsStore({
      fs, path, os,
      app: { getPath: (what) => path.join(dir, String(what || "userData")) },
      secrets,
      audit: { setEnabled: () => {} },
      toolPolicy,
      vault,
      applyAgentEnv: () => {},
      applyBrowserSettings: () => {},
    });
    assert.deepStrictEqual(store.loadSettings().roleDirs, {}, "по умолчанию роль-папок нет");
    const s = store.loadSettings();
    s.roleDirs = { "p-main": { dev: "D:\\Роли\\dev", assistant: "", manager: "D:\\Роли\\менеджер", researcher: "" } };
    store.saveSettings(s);
    const back = store.loadSettings();
    assert.strictEqual(back.roleDirs["p-main"].manager, "D:\\Роли\\менеджер", "папка роли потерялась при записи");
    assert.strictEqual(back.roleDirs["p-main"].dev, "D:\\Роли\\dev", "папка роли Разработчика потерялась");
    const junk = store.loadSettings();
    junk.roleDirs = "мусор";
    store.saveSettings(junk);
    assert.deepStrictEqual(store.loadSettings().roleDirs, {}, "мусор вместо карты не вычищен");
  });

  await test("проводка: модуль собран в main.js и передан прогону", () => {
    assert.ok(/const \{ createRoleFolders \} = require\("\.\/role-folders\.js"\)/.test(MAIN_SRC), "модуль не подключён в main.js");
    assert.ok(/createRoleFolders\(\{ fs, path \}\)/.test(MAIN_SRC), "модуль собран не с живыми fs/path");
    const wiring = /const \{ createRunAi \} = require\("\.\/run-ai\.js"\)[\s\S]*?\n\}\);/.exec(MAIN_SRC);
    assert.ok(wiring, "не нашёл проводку прогона");
    assert.ok(/\n  roleFolders,/.test(wiring[0]), "папки ролей не переданы прогону");
  });

  await test("прогон вставляет блок роли сразу после текста роли", () => {
    assert.ok(/roleFolders/.test(RUN_AI_SRC), "прогон не знает про папки ролей");
    const at = RUN_AI_SRC.indexOf("content: SYSTEM_PROMPT +");
    assert.ok(at > 0, "не нашёл сборку системного промпта");
    const line = RUN_AI_SRC.slice(at, RUN_AI_SRC.indexOf("\n", at));
    assert.ok(/SYSTEM_PROMPT \+ roleNote \+ roleFolderNote \+ mismatchNote/.test(line),
      "порядок промпта не тот: " + line.slice(0, 120));
  });

  await test("интерфейс: вкладка «Роли» и её поля на месте", () => {
    assert.ok(HTML_SRC.indexOf('data-tab="roles"') >= 0, "нет кнопки вкладки «Роли»");
    assert.ok(HTML_SRC.indexOf('data-tab-body="roles"') >= 0, "нет тела вкладки «Роли»");
    assert.ok(HTML_SRC.indexOf('id="roles-list"') >= 0, "нет списка ролей");
    assert.ok(HTML_SRC.indexOf('id="roles-project"') >= 0, "нет строки с активным проектом");
    assert.ok(/function renderRolesUI\(\)/.test(PANEL_SRC), "нет отрисовки полей ролей");
    assert.ok(/input\.id = "role-dir-" \+ r\.id/.test(PANEL_SRC), "поля ролей не создаются из ядра ролей");
    assert.ok(/api\.pickDirectory\("role"\)/.test(PANEL_SRC), "нет выбора папки у поля роли");
    assert.ok(/one\[r\.id\] = el\.value\.trim\(\)/.test(PANEL_SRC), "папки ролей не сохраняются из полей");
    assert.ok(PANEL_SRC.indexOf('!$("role-dir-" + list[0].id)') >= 0, "нет защиты от пустой записи проекта в roleDirs");
    // Телефону системный диалог закрыт — кнопка обязана быть тихой, а не падать.
    assert.ok(/window\.mobileApi \|\| !isElectron/.test(PANEL_SRC), "нет защиты выбора папки для телефона");
    // Заполнение полей обязано вызываться при открытии настроек.
    assert.ok(/renderOtaStatus\(\);\n    renderRolesUI\(\);/.test(PANEL_SRC), "поля ролей не заполняются при открытии настроек");
  });

  await test("набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(PKG_SRC.indexOf("node test/role-folders.test.js") >= 0, "набора нет в цепочке npm test");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

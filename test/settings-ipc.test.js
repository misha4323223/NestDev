"use strict";

/* ── Каналы настроек и групп выдачи (src/settings-ipc.js) ─────────────────────
   Запуск: node test/settings-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 30). Здесь лежит то, что ошибается
   ТИХО: settings:set — не «сохранить присланный объект», а защита от устаревшего
   или обрезанного объекта интерфейса. Ошибка не видна сразу: настройки
   сохраняются, окно довольно, а поле молча потеряно. Так уже было дважды —
   с паролями сайтов и паролем почты, и отдельно с каталогом Yandex Cloud
   (агент снова видел «каталог не выбран», хотя он выбран).

   Второе место — «активный репозиторий» (lastAgentRepoDir): при смене рабочей
   папки его надо сбросить, иначе агент остался бы в папке прошлой локации.
   Переменная принадлежит оболочке, поэтому модуль получает сеттер мостом live;
   проверка следит и за тем, что вызов идёт через мост, и за тем, что он идёт
   ТОЛЬКО при смене папки.

   Имена каналов сверяются с src/preload.js и src/renderer/mobile-api.js:
   разъехавшееся имя ломает сохранение настроек молча и только на одном из
   клиентов. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerSettingsIpc } = require(path.join(ROOT, "src", "settings-ipc.js"));

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

/* Стенд: настоящий модуль, поддельные только «соседи» (ipcMain, хранилище
   настроек, подсистемы). Настройки живут в переменной стенда — так видно, что
   модуль читает их в МОМЕНТ ВЫЗОВА, а не держит копию времени сборки. */
function mk(over) {
  const o = over || {};
  const handlers = new Map();
  const listeners = new Map();
  let current = o.current ? { ...o.current } : {
    workingDir: "/proj",
    model: "qwen3:8b",
    sitePasswords: [{ id: "a", name: "сайт" }],
    mailPassword: "secret",
    ycFolderId: "b1g2folder",
    ycFolderName: "prod",
    ycCloudId: "b1g2cloud",
    projects: [{ id: "p1", name: "проект", dir: "/proj", lastOpened: 1 }],
    activeProjectId: "p1",
    githubRepoDir: "/proj/clone",
  };

  const saved = [];
  const envApplied = [];
  const browserApplied = [];
  const bridgeApplied = [];
  const repoDirResets = [];
  const groups = { terminal: ["PATH"], git: ["GITHUB_TOKEN"] };

  const deps = {
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => listeners.set(ch, fn),
    },
    loadSettings: () => ({ ...current }),
    saveSettings: (s) => {
      if (o.saveThrows) throw new Error("диск недоступен");
      saved.push(s);
      current = s;
    },
    normalizeSettings: (x) => ({ ...x }),
    applyAgentEnv: (s) => envApplied.push(s),
    applyBrowserSettings: (s) => browserApplied.push(s),
    mobileBridge: {
      applied: bridgeApplied,
      applySettings: (s) => bridgeApplied.push(s),
      status: () => ({ pin: current.mobilePin || "" }),
    },
    toolPolicy: { scopeGroups: () => groups },
    live: {
      // Мост: значение принадлежит оболочке, поэтому пишем именно вызовом.
      setLastAgentRepoDir: (v) => repoDirResets.push(v),
    },
  };
  registerSettingsIpc(deps);
  return {
    handlers,
    listeners,
    saved,
    envApplied,
    browserApplied,
    bridgeApplied,
    repoDirResets,
    groups,
    get current() {
      return current;
    },
    patch: (s) => handlers.get("settings:set")(null, s),
  };
}

const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const MOBILE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "settings-ipc.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

(async () => {
  console.log("Каналы настроек и групп выдачи");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mk();
    assert.deepStrictEqual([...h.handlers.keys()].sort(), ["policy:groups", "settings:get", "settings:set"]);
    assert.deepStrictEqual([...h.listeners.keys()], [], "модуль завёл лишние слушатели");
    for (const ch of ["settings:get", "settings:set", "policy:groups"]) {
      assert.ok(PRELOAD.includes(`"${ch}"`), "preload.js не знает канал " + ch);
      assert.ok(MOBILE.includes(`"${ch}"`), "mobile-api.js не знает канал " + ch);
    }
  });

  await test("settings:get отдаёт свежие настройки, а не снимок времени сборки", () => {
    const h = mk();
    assert.strictEqual(h.handlers.get("settings:get")().model, "qwen3:8b");
    h.patch({ model: "llama3" });
    assert.strictEqual(h.handlers.get("settings:get")().model, "llama3", "канал помнит старые настройки");
  });

  await test("settings:set сохраняет через хранилище и применяет к живым подсистемам", () => {
    const h = mk();
    const merged = h.patch({ model: "llama3" });
    assert.strictEqual(merged.model, "llama3");
    assert.deepStrictEqual(h.saved, [merged], "сохранено не то, что вернулось окну");
    assert.deepStrictEqual(h.envApplied, [merged], "окружение агента не пересобрано");
    assert.deepStrictEqual(h.browserApplied, [merged], "профиль браузера не применён");
    assert.deepStrictEqual(h.bridgeApplied, [merged], "мобильный мост не получил настройки");
  });

  await test("пароли сайтов и пароль почты не затираются обрезанным объектом", () => {
    // Ровно та болезнь, от которой стоит защита: мобильный клиент (или окно
    // старой версии) присылает объект, где этих полей нет или они не того типа.
    // Важно: одного «поля нет» мало — при сборке { ...prev, ...s } значение prev
    // осталось бы и без защиты. Ломает именно КЛЮЧ со негодным значением
    // (ключ есть, значение undefined/null) либо не-массив вместо списка паролей,
    // поэтому проверяются все три случая.
    const h = mk();
    const cases = [
      { name: "поля нет", patch: { model: "llama3" } },
      { name: "ключ со значением undefined", patch: { model: "llama3", sitePasswords: undefined, mailPassword: undefined } },
      { name: "вместо списка паролей не массив", patch: { model: "llama3", sitePasswords: null } },
    ];
    for (const c of cases) {
      const merged = h.patch(c.patch);
      assert.deepStrictEqual(merged.sitePasswords, [{ id: "a", name: "сайт" }], "sitePasswords затёрты («" + c.name + "»)");
      assert.strictEqual(merged.mailPassword, "secret", "mailPassword затёрт («" + c.name + "»)");
      assert.strictEqual(h.current.sitePasswords.length, 1, "пароли потеряны и на диске («" + c.name + "»)");
    }
  });

  await test("осознанная очистка списка паролей проходит", () => {
    // Пустой массив — это «удалить все записи», а не «поле не прислали»:
    // защита не должна мешать человеку очищать список.
    const h = mk();
    const merged = h.patch({ sitePasswords: [] });
    assert.deepStrictEqual(merged.sitePasswords, [], "очистка списка паролей не проходит");
    assert.deepStrictEqual(h.current.sitePasswords, [], "очистка не сохранена");
  });

  await test("каталог Yandex Cloud не стирается устаревшим объектом интерфейса", () => {
    const h = mk();
    const merged = h.patch({ ycFolderId: "", ycFolderName: "", ycCloudId: "", ycAllowAgentCreate: true });
    assert.strictEqual(merged.ycFolderId, "b1g2folder", "каталог стёрт сохранением настроек");
    assert.strictEqual(merged.ycFolderName, "prod", "имя каталога стёрто");
    assert.strictEqual(merged.ycCloudId, "b1g2cloud", "облако стёрто");
    assert.strictEqual(merged.ycAllowAgentCreate, true, "разрешение агента не применилось");
    // Устаревший, но НЕпустой каталог тоже не перебивает актуальный.
    const merged2 = h.patch({ ycFolderId: "old-folder" });
    assert.strictEqual(merged2.ycFolderId, "b1g2folder", "устаревший каталог перебил актуальный");
  });

  await test("смена рабочей папки сбрасывает «активный репозиторий» через мост", () => {
    const h = mk();
    h.patch({ workingDir: "/other" });
    assert.deepStrictEqual(h.repoDirResets, [null], "папка агента не сброшена при смене рабочей папки");
    h.patch({ workingDir: "/other", model: "llama3" });
    assert.strictEqual(h.repoDirResets.length, 1, "папка агента сбрасывается без смены рабочей папки");
  });

  await test("смена рабочей папки чистит папку GitHub-репозитория и правит папку проекта", () => {
    const h = mk();
    const merged = h.patch({ workingDir: "/other" });
    assert.strictEqual(merged.githubRepoDir, "", "локальная папка выбранного репозитория не сброшена");
    assert.strictEqual(merged.workingDir, "/other");
    assert.strictEqual(merged.projects[0].dir, "/other", "папка активного проекта разошлась с рабочей");
  });

  await test("включённый мобильный доступ без PIN получает PIN, и его видит мост", () => {
    const h = mk();
    const merged = h.patch({ mobileEnabled: true });
    assert.ok(/^\d{6}$/.test(String(merged.mobilePin)), "PIN не сгенерирован: " + merged.mobilePin);
    assert.strictEqual(h.bridgeApplied[0].mobilePin, merged.mobilePin, "мост не получил новый PIN");
    assert.strictEqual(h.current.mobilePin, merged.mobilePin, "PIN не сохранён на диск");
  });

  await test("сгенерированный PIN уходит и в хранилище, и в мост одним объектом", () => {
    const h = mk();
    h.patch({ mobileEnabled: true });
    assert.strictEqual(h.saved[0], h.bridgeApplied[0], "мосту отдан не тот объект, что сохранён");
  });

  await test("существующий PIN не переписывается при обычном сохранении", () => {
    const h = mk({ current: { mobileEnabled: true, mobilePin: "4821" } });
    const merged = h.patch({ model: "llama3" });
    assert.strictEqual(merged.mobilePin, "4821", "рабочий PIN подменён при сохранении настроек");
  });

  await test("policy:groups спрашивает таблицу прав каждый раз, а не берёт копию", () => {
    const h = mk();
    assert.strictEqual(h.handlers.get("policy:groups")(), h.groups, "группы пришли не из политики");
    h.groups.cloud = ["YC_TOKEN"];
    assert.deepStrictEqual(h.handlers.get("policy:groups")().cloud, ["YC_TOKEN"], "группы взяты копией");
  });

  await test("модуль без состояния: нет своей копии папки агента и нет чтения main.js", () => {
    assert.ok(/live\.setLastAgentRepoDir\(null\)/.test(MODULE_SRC), "сброс папки идёт не через мост");
    assert.ok(!/^\s*lastAgentRepoDir\s*=/m.test(MODULE_SRC), "модуль присваивает чужому имени сам");
    assert.ok(MODULE_SRC.indexOf("require(") === -1, "модуль что-то подтягивает из оболочки");
  });

  await test("проводка в main.js: имена те же, папка агента идёт сеттером, каналов в оболочке нет", () => {
    assert.ok(MAIN_SRC.includes('require("./settings-ipc.js")'), "main.js не собирает модуль настроек");
    const at = MAIN_SRC.indexOf('require("./settings-ipc.js")');
    const wiring = MAIN_SRC.slice(at, MAIN_SRC.indexOf("\n});", at));
    for (const dep of ["ipcMain,", "loadSettings,", "saveSettings,", "normalizeSettings,",
      "applyAgentEnv,", "applyBrowserSettings,", "mobileBridge,", "toolPolicy,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
    assert.ok(wiring.includes("setLastAgentRepoDir:"), "папка агента не передана мостом");
    assert.ok(wiring.includes("lastAgentRepoDir = v;"), "мост не пишет в переменную оболочки");
    assert.ok(!/ipcMain\.(handle|on)\("settings:/.test(MAIN_SRC), "в main.js остались каналы настроек");
    assert.ok(!/ipcMain\.(handle|on)\("policy:/.test(MAIN_SRC), "в main.js остался канал policy:groups");
  });

  console.log("\nНастройки и группы выдачи: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ── Проекты: каналы списка и переключения (src/projects-ipc.js) ──────────────
   Запуск: node test/projects-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 31). Ошибается он тихо и дорого:
   переключение проекта меняет рабочую папку, а вместе с ней в оболочке должны
   сброситься ТРИ живых значения —

     • «активный репозиторий» (lastAgentRepoDir) — иначе агент работает в папке
       прошлого проекта и коммитит не туда;
     • флаг «только что склонирован» (clonedRepoPending) — иначе первый же ответ
       нового проекта начнётся с толчка про чужой клон;
     • снимки отката (activeRunUndo) — иначе человеку предложат «вернуть правки»
       из проекта, который он уже закрыл.

   Значения принадлежат оболочке, поэтому модуль получает сеттеры мостом live.
   Проверки следят за двумя сторонами: что вызов идёт через мост и что он идёт
   ровно там, где нужно (например, удаление НЕактивного проекта ничего сбрасывать
   не должно).

   Имена каналов сверяются с src/preload.js и src/renderer/mobile-api.js. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerProjectsIpc } = require(path.join(ROOT, "src", "projects-ipc.js"));

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

const HOME = path.join(path.sep, "home", "user");
const P1 = path.join(HOME, "projects", "one");
const P2 = path.join(HOME, "projects", "two");
const P3 = path.join(HOME, "projects", "three");

/* Стенд: настоящий модуль, поддельные соседи. Файловая система — карта
   существующих папок (проверяется только наличие), хранилище — объект в памяти. */
function mk(over) {
  const o = over || {};
  const handlers = new Map();
  const listeners = new Map();
  const existing = new Set(o.existing || [P1, P2]);
  let current = {
    workingDir: HOME,
    githubRepoDir: "/tmp/old-clone",
    projects: [
      { id: "p1", name: "один", dir: P1, lastOpened: 100 },
      { id: "p2", name: "два", dir: P2, lastOpened: 200 },
    ],
    activeProjectId: "p2",
    ...(o.current || {}),
  };
  const saved = [];
  const made = [];
  const resets = { repoDir: [], clonedRepoPending: [], activeRunUndo: [] };

  registerProjectsIpc({
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => listeners.set(ch, fn),
    },
    fs: {
      existsSync: (p) => existing.has(p),
      mkdirSync: () => {},
    },
    path,
    os: { homedir: () => HOME },
    // Копия настроек: настоящий loadSettings тоже отдаёт объект, а не ссылку на файл.
    // Мусор в поле projects передаём как есть — каналы обязаны его пережить.
    loadSettings: () => ({
      ...current,
      projects: Array.isArray(current.projects) ? current.projects.map((p) => ({ ...p })) : current.projects,
    }),
    saveSettings: (s) => {
      saved.push(s);
      current = s;
    },
    ensureWritableDir: (dir) => {
      if (o.notWritable) return { ok: false, error: "Нет прав на запись в папку: " + dir };
      made.push(dir);
      existing.add(dir);
      return { ok: true, dir };
    },
    live: {
      setLastAgentRepoDir: (v) => resets.repoDir.push(v),
      setClonedRepoPending: (v) => resets.clonedRepoPending.push(v),
      setActiveRunUndo: (v) => resets.activeRunUndo.push(v),
    },
  });
  return {
    handlers,
    listeners,
    saved,
    made,
    resets,
    existing,
    get current() {
      return current;
    },
    call: (ch, ...args) => handlers.get(ch)(null, ...args),
  };
}

const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const MOBILE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "projects-ipc.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

(async () => {
  console.log("Проекты: каналы списка и переключения");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mk();
    assert.deepStrictEqual(
      [...h.handlers.keys()].sort(),
      ["projects:activate", "projects:create", "projects:list", "projects:remove"]
    );
    assert.deepStrictEqual([...h.listeners.keys()], [], "модуль завёл лишние слушатели");
    for (const ch of ["projects:list", "projects:create", "projects:activate", "projects:remove"]) {
      assert.ok(PRELOAD.includes(`"${ch}"`), "preload.js не знает канал " + ch);
      assert.ok(MOBILE.includes(`"${ch}"`), "mobile-api.js не знает канал " + ch);
    }
  });

  await test("projects:list: свежие сверху, отсутствующая папка помечена, активный назван", async () => {
    const h = mk({ existing: [P1] }); // второй проект — папки нет
    const r = await h.call("projects:list");
    assert.deepStrictEqual(r.projects.map((p) => p.id), ["p2", "p1"], "порядок не по свежести");
    assert.strictEqual(r.projects[0].exists, false, "отсутствующая папка не помечена");
    assert.strictEqual(r.projects[1].exists, true, "существующая папка помечена отсутствующей");
    assert.strictEqual(r.activeId, "p2", "активный проект не назван");
    // Мусор в настройках не должен ронять список: это же состояние видят телефон и окно.
    const broken = mk({ current: { projects: "не список" } });
    const rb = await broken.call("projects:list");
    assert.deepStrictEqual(rb.projects, [], "мусор вместо списка проектов сломал канал");
  });

  await test("projects:create: лимит десять проектов — понятный отказ", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: "x" + i, name: "п" + i, dir: path.join(HOME, "p" + i), lastOpened: i }));
    const h = mk({ current: { projects: many } });
    const r = await h.call("projects:create", "новый", P3);
    assert.strictEqual(r.ok, false, "одиннадцатый проект создан");
    assert.ok(/максимум 10/.test(r.error), "отказ не объясняет лимит: " + r.error);
    assert.deepStrictEqual(h.saved, [], "отказ всё равно записал настройки");
  });

  await test("projects:create: пустое и слишком длинное имя отклоняются", async () => {
    const h = mk();
    assert.ok(/Введи название/.test((await h.call("projects:create", "   ", P3)).error), "пустое имя принято");
    assert.ok(/слишком длинное/.test((await h.call("projects:create", "я".repeat(61), P3)).error), "имя из 61 знака принято");
    assert.deepStrictEqual(h.made, [], "папка создавалась при отклонённом имени");
  });

  await test("projects:create: папка по умолчанию — домашняя, имя очищено от запрещённых знаков", async () => {
    const h = mk();
    const r = await h.call("projects:create", 'мой:проект/второй*', "");
    assert.strictEqual(r.ok, true, "проект не создан: " + JSON.stringify(r));
    assert.deepStrictEqual(h.made, [path.join(HOME, "мой_проект_второй_")], "папка посчитана не от домашней");
  });

  await test("projects:create: отказали права на запись — отказ передаётся как есть", async () => {
    const h = mk({ notWritable: true });
    const r = await h.call("projects:create", "проект", P3);
    assert.strictEqual(r.ok, false, "проект создан в папке без прав");
    assert.ok(/Нет прав на запись/.test(r.error), "причина отказа потеряна: " + r.error);
    assert.deepStrictEqual(h.saved, [], "проект сохранён, хотя папки нет");
    assert.deepStrictEqual(h.resets.repoDir, [], "сброс папки агента случился без переключения");
  });

  await test("projects:create: та же папка дважды — отказ с именем занявшего проекта", async () => {
    const h = mk();
    const r = await h.call("projects:create", "дубль", P1);
    assert.strictEqual(r.ok, false, "создан второй проект на той же папке");
    assert.ok(/уже используется проектом «один»/.test(r.error), "отказ не называет проект: " + r.error);
  });

  await test("projects:create: новый проект становится активным, папка агента сброшена через мост", async () => {
    const h = mk();
    const r = await h.call("projects:create", "третий", P3);
    assert.strictEqual(r.ok, true, "проект не создан");
    assert.strictEqual(r.project.name, "третий");
    const st = h.current;
    assert.strictEqual(st.activeProjectId, r.project.id, "новый проект не стал активным");
    assert.strictEqual(st.workingDir, P3, "рабочая папка не переехала в новый проект");
    assert.strictEqual(st.githubRepoDir, "", "локальная папка репозитория не сброшена");
    assert.deepStrictEqual(h.resets.repoDir, [null], "«активный репозиторий» не сброшен через мост");
  });

  await test("projects:activate: чужой id и пропавшая папка — понятные отказы без переключения", async () => {
    const h = mk({ existing: [] }); // обеих папок нет
    const noId = await h.call("projects:activate", "нет-такого");
    assert.ok(/Проект не найден/.test(noId.error), "чужой id принят");
    const gone = await h.call("projects:activate", "p1");
    assert.ok(/Папка проекта больше не существует/.test(gone.error), "переключение в пропавшую папку прошло");
    assert.deepStrictEqual(h.saved, [], "отказ всё равно записал настройки");
    assert.deepStrictEqual(h.resets.repoDir, [], "отказ всё равно сбросил папку агента");
  });

  await test("projects:activate: переключает папку и сбрасывает три живых значения", async () => {
    const h = mk();
    const r = await h.call("projects:activate", "p1");
    assert.strictEqual(r.ok, true, "проект не переключился");
    assert.strictEqual(h.current.workingDir, P1, "рабочая папка не переехала");
    assert.strictEqual(h.current.activeProjectId, "p1", "активный проект не сменился");
    assert.strictEqual(h.current.githubRepoDir, "", "локальная папка репозитория не сброшена");
    assert.ok(h.current.projects.find((p) => p.id === "p1").lastOpened > 100, "отметка «когда открыт» не обновилась");
    assert.deepStrictEqual(h.resets.repoDir, [null], "«активный репозиторий» не сброшен");
    assert.deepStrictEqual(h.resets.clonedRepoPending, [false], "флаг «только что склонирован» не сброшен");
    assert.deepStrictEqual(h.resets.activeRunUndo, [[]], "снимки отката прошлого проекта не очищены");
  });

  await test("projects:remove: удаление активного — активным становится самый свежий, сбросы как при переключении", async () => {
    const h = mk();
    const r = await h.call("projects:remove", "p2");
    assert.deepStrictEqual(r, { ok: true, activeId: "p1" }, "активным стал не самый свежий: " + JSON.stringify(r));
    assert.strictEqual(h.current.workingDir, P1, "рабочая папка не переехала к новому активному");
    assert.strictEqual(h.current.projects.length, 1, "проект остался в списке");
    assert.strictEqual(h.current.githubRepoDir, "", "локальная папка репозитория не сброшена при смене проекта");
    assert.deepStrictEqual(h.resets.repoDir, [null], "папка агента должна сброситься при смене проекта");
    assert.deepStrictEqual(h.resets.clonedRepoPending, [false], "флаг «только что склонирован» уехал в новый проект");
    assert.deepStrictEqual(h.resets.activeRunUndo, [[]], "снимки отката удалённого проекта остались");
  });

  await test("projects:remove: удаление активного не оставляет агента в папке удалённого проекта", async () => {
    // Найдено при выносе: раньше сбросы шли только при ОПУСТЕВШЕМ списке, и после
    // удаления активного проекта агент продолжал работать в его папке (чужой клон).
    const h = mk();
    await h.call("projects:remove", "p2");
    assert.deepStrictEqual(h.resets.repoDir, [null], "агент остался в папке удалённого проекта");
    assert.strictEqual(h.current.activeProjectId, "p1", "активный проект не переключился");
    assert.strictEqual(
      h.current.workingDir,
      h.current.projects[0].dir,
      "рабочая папка разошлась с папкой активного проекта"
    );
  });

  await test("projects:remove: удаление неактивного ничего не сбрасывает", async () => {
    const h = mk();
    const r = await h.call("projects:remove", "p1");
    assert.deepStrictEqual(r, { ok: true, activeId: "p2" }, "активный проект изменился");
    assert.strictEqual(h.current.workingDir, HOME, "рабочая папка тронута без смены проекта");
    assert.deepStrictEqual(h.resets.repoDir, [], "папка агента сброшена без смены проекта");
  });

  await test("projects:remove: последний проект — список пуст, рабочая папка не выдёргивается", async () => {
    const h = mk({ current: { projects: [{ id: "p2", name: "два", dir: P2, lastOpened: 200 }], activeProjectId: "p2", workingDir: P2 } });
    const r = await h.call("projects:remove", "p2");
    assert.deepStrictEqual(r, { ok: true, activeId: "" }, "активный проект не снят");
    assert.strictEqual(h.current.workingDir, P2, "рабочая папка выдернута вместе с последним проектом");
    assert.strictEqual(h.current.githubRepoDir, "", "локальная папка репозитория не сброшена");
    assert.deepStrictEqual(h.resets.repoDir, [null], "папка агента не сброшена при опустевшем списке");
    // Чужой id — отказ, а не молчаливое «удалил, чего не было».
    assert.ok(/Проект не найден/.test((await h.call("projects:remove", "нет-такого")).error), "чужой id принят за удаление");
  });

  await test("модуль без состояния: своей копии живых значений и чтения main.js нет", () => {
    assert.ok(MODULE_SRC.indexOf("require(") === -1, "модуль что-то подтягивает из оболочки");
    assert.ok(!/^let /m.test(MODULE_SRC), "модуль завёл изменяемое состояние модуля");
    for (const call of ["live.setLastAgentRepoDir(", "live.setClonedRepoPending(", "live.setActiveRunUndo("]) {
      assert.ok(MODULE_SRC.includes(call), "сброс идёт не через мост: " + call);
    }
    assert.ok(!/^\s*lastAgentRepoDir\s*=/m.test(MODULE_SRC), "модуль присваивает чужому имени сам");
  });

  await test("проводка в main.js: зависимости и сеттеры на месте, каналов в оболочке нет", () => {
    assert.ok(MAIN_SRC.includes('require("./projects-ipc.js")'), "main.js не собирает модуль проектов");
    const at = MAIN_SRC.indexOf('require("./projects-ipc.js")');
    const wiring = MAIN_SRC.slice(at, MAIN_SRC.indexOf("\n});", at));
    for (const dep of ["ipcMain,", "fs,", "path,", "os,", "loadSettings,", "saveSettings,", "ensureWritableDir,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
    for (const setter of ["setLastAgentRepoDir:", "setClonedRepoPending:", "setActiveRunUndo:"]) {
      assert.ok(wiring.includes(setter), "в проводке нет сеттера " + setter);
    }
    assert.ok(wiring.includes("lastAgentRepoDir = v;"), "сеттер не пишет в переменную оболочки");
    assert.ok(!/ipcMain\.(handle|on)\("projects:/.test(MAIN_SRC), "в main.js остались каналы проектов");
    assert.ok(
      MAIN_SRC.indexOf("createSettingsStore({") < at,
      "модуль проектов собран раньше хранилища настроек — упадёт на загрузке"
    );
  });

  console.log("\nПроекты: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

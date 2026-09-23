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

  const win = o.win === undefined ? { isDestroyed: () => false, webContents: { id: 11, send() {} } } : o.win;
  const saved = [];
  const opened = [];
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
    // Системный диалог выбора папки: без родителя окно теряется за главным окном,
    // а на закрытом окне Electron вообще бросает ошибку — поэтому запоминаем, что
    // именно пришло родителем.
    dialog: {
      showOpenDialog: (parent, opts) => {
        opened.push({ parent, opts });
        return o.canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [o.pick || "/picked/dir"] };
      },
    },
    // Живое окно: у настоящего есть webContents — по нему и отличают вызов из
    // окна от вызова с телефона и от чужого рендерера (src/ipc-guard.js).
    getWindow: () => win,
    // Проверки, которые модуль получает собранными (как в main.js).
    ipcGuard: require(path.join(ROOT, "src", "ipc-guard.js")),
    secretMask: require(path.join(ROOT, "src", "secret-mask.js")),
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
    opened,
    envApplied,
    browserApplied,
    bridgeApplied,
    repoDirResets,
    groups,
    win,
    get current() {
      return current;
    },
    patch: (s) => handlers.get("settings:set")(null, s),
    // Вызов от конкретного клиента: окно, телефон или чужой рендерер.
    get: (ev) => handlers.get("settings:get")(ev),
    set: (ev, s) => handlers.get("settings:set")(ev, s),
  };
}

// События клиентов. У вызова из окна Electron сам подставляет и отправителя
// (webContents живого окна), и кадр — подделка обязана быть такой же.
const fromWindow = (h) => ({ sender: h.win.webContents, senderFrame: { parent: null } });
// Мост телефона собирает событие сам: sender.id = 0 (см. src/mobile-bridge.js).
const fromPhone = () => ({ sender: { send() {}, id: 0 } });
// Чужой рендерер внутри приложения: свой webContents, своё окно.
const fromAlien = () => ({ sender: { send() {}, id: 99 }, senderFrame: { parent: null } });

// Секреты, которые лежат в настройках: ключи, токены, PIN, переменные агента,
// пароли сайтов и ключи внутри сохранённых подключений.
const SECRETS = {
  workingDir: "/proj",
  model: "qwen3:8b",
  openaiApiKey: "sk-очень-секретный",
  anthropicApiKey: "sk-ant-секрет",
  githubToken: "ghp-секрет",
  mobilePin: "482913",
  mailPassword: "пароль-почты",
  agentEnv: { TOKEN: "секрет-переменной", CITY: "Москва" },
  openaiProfiles: [{ id: "p1", name: "своё", url: "http://localhost:1/v1", apiKey: "ключ-профиля" }],
  sitePasswords: [{ id: "v1", name: "банк", login: "я", password: "пароль-сайта" }],
};

const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const MOBILE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "settings-ipc.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

(async () => {
  console.log("Каналы настроек и групп выдачи");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mk();
    assert.deepStrictEqual([...h.handlers.keys()].sort(), [
      "dialog:pickDir", "policy:groups", "settings:get", "settings:set", "setup:save", "setup:state",
    ]);
    assert.deepStrictEqual([...h.listeners.keys()], [], "модуль завёл лишние слушатели");
    for (const ch of ["settings:get", "settings:set", "policy:groups", "dialog:pickDir", "setup:state", "setup:save"]) {
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

  await test("dialog:pickDir: отмена — null, выбор — путь, родитель — ЖИВОЕ окно", async () => {
    const h = mk();
    assert.strictEqual(await h.handlers.get("dialog:pickDir")(), "/picked/dir", "выбранная папка не отдана окну");
    assert.strictEqual(h.opened.length, 1, "системный диалог не открывали");
    assert.ok(h.opened[0].opts && h.opened[0].opts.properties.includes("openDirectory"), "диалог спрашивает не папку: " + JSON.stringify(h.opened[0].opts));
    assert.ok(h.opened[0].parent && typeof h.opened[0].parent.isDestroyed === "function", "родителем диалога не передано окно");

    const cancelled = mk({ canceled: true });
    assert.strictEqual(await cancelled.handlers.get("dialog:pickDir")(), null, "отмена диалога выдана за выбор папки");

    // Окно могло быть закрыто: диалог всё равно обязан открыться, без родителя —
    // иначе на закрытом окне выбор папки упал бы с ошибкой Electron.
    const noWin = mk({ win: null });
    assert.strictEqual(await noWin.handlers.get("dialog:pickDir")(), "/picked/dir", "без живого окна выбор папки перестал работать");
    assert.strictEqual(noWin.opened[0].parent, undefined, "закрытое окно ушло родителем диалога");
  });

  // ── Куда класть работу агента: миссии, прогоны и дела (часть 45) ────────────
  // Выбор папок идёт своим каналом и живёт в настройках, но НЕ в форме настроек:
  // объект интерфейса, загруженный до выбора, принёс бы прежние пустые значения и
  // стёр бы выбор (та же болезнь, что у каталога Yandex Cloud).

  await test("setup:state отдаёт текущий выбор, а не снимок времени сборки", () => {
    const h = mk({ current: { missionsDir: "D:/work", tasksDir: "D:/tasks", firstRunSetup: "done" } });
    const st = h.handlers.get("setup:state")();
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.setupDone, true, "ответ человека не доехал до окна");
    assert.strictEqual(st.missionsDir, "D:/work");
    assert.strictEqual(st.tasksDir, "D:/tasks");

    h.patch({ model: "llama3" });
    assert.strictEqual(h.handlers.get("setup:state")().missionsDir, "D:/work", "канал помнит старые настройки");

    const fresh = mk();
    const none = fresh.handlers.get("setup:state")();
    assert.strictEqual(none.setupDone, false, "приглашение первого запуска выдано за отвеченное: " + JSON.stringify(none));
    assert.strictEqual(none.missionsDir, "", "пустое значение выдано за выбранную папку");
  });

  await test("setup:save сохраняет папки, чистит путь и закрывает вопрос навсегда", async () => {
    const h = mk();
    const r = await h.handlers.get("setup:save")(null, { missionsDir: "  D:/work/missions/ ", tasksDir: "D:/tasks" });
    assert.strictEqual(r.ok, true, "выбор не сохранён: " + JSON.stringify(r));
    assert.strictEqual(r.missionsDir, "D:/work/missions", "пробелы и хвостовой разделитель остались в пути: " + r.missionsDir);
    assert.strictEqual(h.current.missionsDir, "D:/work/missions", "выбор не дошёл до хранилища");
    assert.strictEqual(h.current.tasksDir, "D:/tasks");
    assert.strictEqual(h.current.firstRunSetup, "done", "вопрос остался открытым — приглашение вернётся");
    assert.strictEqual(h.saved.length, 1, "сохранение прошло мимо хранилища");
  });

  await test("setup:save без полей — «оставить как было»: папки не стираются", async () => {
    // Пустой выбор — это тоже ответ. Он не имеет права превратиться в «стереть папки»:
    // тогда миссии и дела молча вернулись бы в прежние места.
    const h = mk({ current: { missionsDir: "D:/work", tasksDir: "D:/tasks", firstRunSetup: "ask" } });
    const r = await h.handlers.get("setup:save")(null, {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(h.current.missionsDir, "D:/work", "папка миссий стёрта пустым выбором");
    assert.strictEqual(h.current.tasksDir, "D:/tasks", "папка дел стёрта пустым выбором");
    assert.strictEqual(h.current.firstRunSetup, "done", "вопрос не закрылся");
    // А осознанная очистка (человек стёр поле) проходит: пусто — прежнее место.
    const clear = await h.handlers.get("setup:save")(null, { missionsDir: "", tasksDir: "D:/tasks" });
    assert.strictEqual(clear.missionsDir, "", "очистка поля не сработала");
    assert.strictEqual(h.current.missionsDir, "");
  });

  await test("setup:state/setup:save: чужому рендереру — отказ, хранилище не тронуто", async () => {
    const h = mk();
    const st = h.handlers.get("setup:state")(fromAlien());
    assert.strictEqual(st.ok, false, "чужому рендереру отдано состояние папок: " + JSON.stringify(st));
    const save = await h.handlers.get("setup:save")(fromAlien(), { missionsDir: "/чужое" });
    assert.strictEqual(save.ok, false, "чужой рендерер сохранил папки: " + JSON.stringify(save));
    assert.deepStrictEqual(h.saved, [], "чужое сохранение дошло до хранилища");
    assert.strictEqual(h.current.missionsDir, undefined, "настройки всё-таки изменились");
  });

  await test("обычное сохранение настроек НЕ стирает папки и не возвращает приглашение", async () => {
    // Устаревший объект окна (или телефона), загруженный ДО выбора папок, приносит
    // прежние пустые значения — и без защиты миссии с делами уехали бы обратно.
    const h = mk({ current: { missionsDir: "D:/work", tasksDir: "D:/tasks", firstRunSetup: "done" } });
    const merged = h.patch({ missionsDir: "", tasksDir: "", firstRunSetup: "ask", model: "llama3" });
    assert.strictEqual(merged.missionsDir, "D:/work", "папка миссий стёрта обычным сохранением");
    assert.strictEqual(merged.tasksDir, "D:/tasks", "папка дел стёрта обычным сохранением");
    assert.strictEqual(merged.firstRunSetup, "done", "приглашение первого запуска вернулось");
    assert.strictEqual(merged.model, "llama3", "обычное поле не сохранилось");
    assert.strictEqual(h.current.firstRunSetup, "done", "на диске вопрос снова открыт");
  });

  await test("dialog:pickDir: вид папки задаёт подпись окна и папку начала выбора", async () => {
    const h = mk({ current: { workingDir: "/proj", missionsDir: "D:/work" } });
    await h.handlers.get("dialog:pickDir")(null, "missions");
    assert.ok(/миссий/.test(h.opened[0].opts.title), "подпись диалога не про миссии: " + h.opened[0].opts.title);
    assert.strictEqual(h.opened[0].opts.defaultPath, "D:/work", "выбор начался не с выбранной папки миссий");
    await h.handlers.get("dialog:pickDir")(null, "tasks");
    assert.ok(/дел/.test(h.opened[1].opts.title), "подпись диалога не про дела: " + h.opened[1].opts.title);
    assert.strictEqual(h.opened[1].opts.defaultPath, "/proj", "без своей папки дел выбор начался не с рабочей");
    // Прежний вызов без вида — рабочая директория, как было.
    await h.handlers.get("dialog:pickDir")(null, "мусор");
    assert.ok(/рабочую/.test(h.opened[2].opts.title), "незнакомый вид сломал прежний выбор папки: " + h.opened[2].opts.title);
  });

  // ── Секреты в настройках: окну — значения, телефону — заглушки ──────────────
  // До этой проверки settings:get отдавал ключи, токены, PIN и переменные агента
  // любому, кто мог позвать канал. Каналы подняты по LAN, поэтому телефон должен
  // получать то же меню, но без значений.

  await test("settings:get: телефону — заглушки вместо секретов, окну — настоящие значения", () => {
    const h = mk({ current: { ...SECRETS } });
    const mask = require(path.join(ROOT, "src", "secret-mask.js"));

    const phone = h.get(fromPhone());
    for (const k of ["openaiApiKey", "anthropicApiKey", "githubToken", "mobilePin", "mailPassword"]) {
      assert.strictEqual(phone[k], mask.MASK, "телефону ушёл секрет " + k + ": " + JSON.stringify(phone[k]));
    }
    assert.strictEqual(phone.agentEnv.TOKEN, mask.MASK, "телефону ушли значения переменных агента");
    assert.strictEqual(phone.sitePasswords[0].password, mask.MASK, "телефону ушёл пароль сайта");
    assert.strictEqual(phone.openaiProfiles[0].apiKey, mask.MASK, "телефону ушёл ключ подключения");
    // А то, чем интерфейс живёт, остаётся: иначе на телефоне ничего не нарисуется.
    assert.strictEqual(phone.workingDir, "/proj", "телефону не отдана рабочая папка");
    assert.strictEqual(phone.model, "qwen3:8b", "телефону не отдана модель");
    assert.deepStrictEqual(Object.keys(phone.agentEnv).sort(), ["CITY", "TOKEN"], "пропали имена переменных агента");
    assert.strictEqual(phone.sitePasswords[0].name, "банк", "пропали подписи записей паролей");
    assert.strictEqual(phone.openaiProfiles[0].url, "http://localhost:1/v1", "пропал адрес подключения");

    // Окно на ПК — доверенный клиент: оно само ходит к провайдеру, ему ключи нужны.
    const win = h.get(fromWindow(h));
    assert.strictEqual(win.openaiApiKey, "sk-очень-секретный");
    assert.strictEqual(win.agentEnv.TOKEN, "секрет-переменной");
    assert.strictEqual(win.sitePasswords[0].password, "пароль-сайта");
    // И внутренний вызов (наборы, живые прогоны) — тоже не телефон.
    assert.strictEqual(h.get(null).openaiApiKey, "sk-очень-секретный");
  });

  await test("settings:set: сохранение с телефона не стирает секреты заглушками", () => {
    const h = mk({ current: { ...SECRETS } });
    // Телефон присылает ровно то, что сам получил (с заглушками), плюс свои правки.
    const patch = h.get(fromPhone());
    patch.model = "llama3";
    patch.agentEnv.CITY = "Казань"; // одну переменную человек поменял, вторую нет
    const answer = h.set(fromPhone(), patch);

    assert.strictEqual(h.current.openaiApiKey, "sk-очень-секретный", "ключ стёрт сохранением с телефона");
    assert.strictEqual(h.current.githubToken, "ghp-секрет", "токен GitHub стёрт");
    assert.strictEqual(h.current.mobilePin, "482913", "PIN стёрт");
    assert.strictEqual(h.current.sitePasswords[0].password, "пароль-сайта", "пароль сайта стёрт");
    assert.strictEqual(h.current.openaiProfiles[0].apiKey, "ключ-профиля", "ключ подключения стёрт");
    assert.strictEqual(h.current.agentEnv.TOKEN, "секрет-переменной", "значение нетронутой переменной стёрто");
    assert.strictEqual(h.current.agentEnv.CITY, "Казань", "новая правка переменной не сохранилась");
    assert.strictEqual(h.current.model, "llama3", "обычное поле не сохранилось");
    // Ответ телефону — снова без секретов: иначе они вернулись бы тем же путём.
    assert.strictEqual(answer.openaiApiKey, require(path.join(ROOT, "src", "secret-mask.js")).MASK, "в ответе телефону ушли ключи");
  });

  await test("чужой рендерер внутри приложения не получает ни ключей, ни сохранения", async () => {
    const h = mk({ current: { ...SECRETS } });
    const got = h.get(fromAlien());
    assert.strictEqual(got.ok, false, "чужому рендереру отданы настройки: " + JSON.stringify(got));
    assert.ok(/не из окна/.test(got.error), "отказ не объяснён: " + got.error);
    assert.strictEqual(got.openaiApiKey, undefined, "в отказе всё равно уехал ключ");

    const put = h.set(fromAlien(), { model: "чужое" });
    assert.strictEqual(put.ok, false, "чужой рендерер сохранил настройки: " + JSON.stringify(put));
    assert.deepStrictEqual(h.saved, [], "чужое сохранение дошло до хранилища");
    assert.strictEqual(h.current.model, "qwen3:8b", "настройки всё-таки изменились");

    assert.deepStrictEqual(h.handlers.get("policy:groups")(fromAlien()), [], "чужому рендереру отданы группы выдачи");
    assert.strictEqual(await h.handlers.get("dialog:pickDir")(fromAlien()), null, "чужой рендерер открыл системный диалог");
    assert.strictEqual(h.opened.length, 0, "диалог всё-таки открылся");
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
      "applyAgentEnv,", "applyBrowserSettings,", "mobileBridge,", "toolPolicy,",
      "dialog,", "getWindow: () => mainWindow,", "ipcGuard,", "secretMask,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
    assert.ok(wiring.includes("setLastAgentRepoDir:"), "папка агента не передана мостом");
    assert.ok(wiring.includes("lastAgentRepoDir = v;"), "мост не пишет в переменную оболочки");
    assert.ok(!/ipcMain\.(handle|on)\("settings:/.test(MAIN_SRC), "в main.js остались каналы настроек");
    assert.ok(!/ipcMain\.(handle|on)\("policy:/.test(MAIN_SRC), "в main.js остался канал policy:groups");
    assert.ok(!/ipcMain\.(handle|on)\("dialog:/.test(MAIN_SRC), "в main.js остался канал выбора папки");
    assert.ok(MAIN_SRC.includes('require("./settings-ipc.js")'), "выбор папки остался без модуля настроек");
  });

  console.log("\nНастройки и группы выдачи: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

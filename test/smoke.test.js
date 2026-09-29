"use strict";

/* ── Smoke-тесты (plain node, без фреймворков и без сети) ───────────────────
   Запуск: bun run test  (node test/smoke.test.js)
   Покрывают самые хрупкие узлы, чтобы «хирургические» правки не ломали их молча:
   - agent-core: состав инструментов (в т.ч. browser-*), системный промпт,
     нормализация имён, извлечение tool_calls, тримминг контекста;
   - secrets: разделение настроек, roundtrip записи/чтения, миграция legacy;
   - ota: сравнение версий, применение бандла, защита хеша, отказ без файлов;
   - browser-tools: состояние «браузер не запущен», карта страницы (browserSnapshot),
     клик/ввод по ref и имени вместо перебора селекторов, пароли из полей не собираются;
   - server.js: защита /api/llm (только Yandex), валидация /api/fetch.
   - highlight: подсветка кода не теряет и не искажает исходный текст.
   - chats: атомарная запись истории, .bak-восстановление, автосейв при закрытии.
   - сессия: постоянный профиль браузера, индикатор контекста, «Дописать ответ».
   - vault: менеджер паролей (поиск, отсутствие утечек паролей, подстановка входа, интерфейс).
   - yandex: логи внутренним API (REST+gRPC), автоматические YC_TOKEN/YC_CLOUD_ID/YC_FOLDER_ID, встроенный yc CLI;
     адреса сервисов (postbox/logging), повторы и пачечный опрос дашборда, свежие настройки у инструментов.
   - tasks: дела со сроками (разбор «завтра 14:00», CRUD, панель по срокам, напоминания),
     повторы («каждый день», «по будням») и автозадачи — планировщик будит агента по сроку.
   - app-ui: стабильные ref вместо номеров [N] (клик не уезжает после перерисовки окна).
   - стрим/печать: DOM и автопрокрутка обновляются не чаще кадра, фон под стеклянными
     панелями статичен (иначе блюры пересчитываются в каждом кадре и интерфейс «жуёт»).
*/

/* ── Карта файла: что здесь лежит ────────────────────────────────────────────
   КАРТА:START
   | файл                         | строка | набор                   | что проверяет |
   |------------------------------|-------:|-------------------------|----------------|
   | test/smoke.test.js           |    394 | testSelfIndex           | карта файла: каждый номер строки указывает на своё объявление |
   | test/smoke/01-chat.js        |     35 | testChatActions         | Удобство чата (src/renderer/chat-actions.js) |
   | test/smoke/01-chat.js        |    187 | testWebChat             | Веб-режим (src/renderer/web-chat.js) |
   | test/smoke/01-chat.js        |    393 | testChatThinking        | Блок размышлений модели (src/renderer/chat-thinking.js, этап 3.7) |
   | test/smoke/01-chat.js        |    552 | testChatEvents          | Сегменты ответа: лог «текст → действия → текст» (этап 3.7, часть 2) |
   | test/smoke/01-chat.js        |    912 | testChatSegments        | сегменты ответа: текст после действия открывает новое сообщение |
   | test/smoke/01-chat.js        |   1052 | testChatRender          | Отрисовка сообщения: текст, вложения, кнопки (этап 3.7, часть 3) |
   | test/smoke/01-chat.js        |   1210 | testChatPersistence     | 11. Хранение чатов: атомарная запись, .bak-восстановление, автосейв |
   | test/smoke/01-chat.js        |   1408 | testChatFeed            | Лента: умная прокрутка и очередь кадра (этап 3.7, часть 4) |
   | test/smoke/01-chat.js        |   1597 | testChatWork            | строки действий: строка, ссылка на файл и группа работ работают, как раньше |
   | test/smoke/01-chat.js        |   1759 | testStreamThrottle      | Стрим и печать: работа не чаще одного кадра |
   | test/smoke/01-chat.js        |   1854 | testChatContextTransfer | Контекст длинного чата и кнопка «Продолжить контекст» |
   | test/smoke/01-chat.js        |   1902 | testLongChatRecovery    | Выросший чат: агент не должен «писать что-то и отключаться» |
   | test/smoke/02-browser.js     |     41 | testBrowserTools        | 4. browser-tools (без браузера) |
   | test/smoke/02-browser.js     |    134 | testBrowserBrain        | 4c. Браузерная карта страницы (browserSnapshot) и умные действия |
   | test/smoke/02-browser.js     |    443 | testShellAndCdp         | 5. Оболочка (shell), коды ошибок, установщики и свой Chrome по CDP |
   | test/smoke/02-browser.js     |   1099 | testBrowserOverlays     | 1d. Слои поверх страницы: диалоги, force-клик, JS на странице |
   | test/smoke/02-browser.js     |   1527 | testBrowserReplayData   | Ускорение агента: батчинг, скриншоты JPEG, порог компакции |
   | test/smoke/02-browser.js     |   1826 | testBrowserSpeed        | Скорость работы в браузере: ожидание, фреймы, submit, browserAct |
   | test/smoke/02-browser.js     |   2015 | testBrowserSenses       | 1e. «Чувства» агента: прокрутка, наведение, сеть, ожидание покоя |
   | test/smoke/03-cloud.js       |     34 | testYcDiagnosis         | Yandex Cloud по отчёту песочницы: адреса, повторы, пачки, UX |
   | test/smoke/03-cloud.js       |    194 | testYandexCloud         | Yandex Cloud: логи внутренним API + встроенный yc CLI |
   | test/smoke/03-cloud.js       |   1158 | testYcFolderPersistence | Каталог Yandex Cloud: сохранение настроек не должно его стирать |
   | test/smoke/03-cloud.js       |   1268 | testYcConsole           | 1.66 консоль Yandex Cloud: карточка ресурса и связанные объекты |
   | test/smoke/03-cloud.js       |   1366 | testYcCosts             | стоимость: формула контейнера совпадает с примерами из документации |
   | test/smoke/03-cloud.js       |   1456 | testYcSplit             | Вынесенный Yandex Cloud: служебный слой и IPC-мост |
   | test/smoke/04-deploy.js      |     34 | testDeploy              | Деплой: рецепты, состояние, движок |
   | test/smoke/04-deploy.js      |    842 | testDeployIpc           | Вынесенный мост деплоя |
   | test/smoke/04-deploy.js      |    950 | testRealE2E             | E2E настоящего облака (scripts/live-yc-real.js, 1.5.97) |
   | test/smoke/04-deploy.js      |   1114 | testProductionGate      | Приёмка production: сломанное не уезжает в прод (1.5.97) |
   | test/smoke/05-mobile.js      |     36 | testMobilePanel         | Мобильный доступ: панель подключения телефона (этап 3.6) |
   | test/smoke/05-mobile.js      |    267 | testMobileBridge        | 4b. mobile-bridge: rate-limit PIN |
   | test/smoke/05-mobile.js      |    536 | testMobileGate          | 4c. mobile-api: страница входа с телефона |
   | test/smoke/06-agent.js       |     35 | testAgentCore           | 1. agent-core |
   | test/smoke/06-agent.js       |    625 | testAppUiTools          | 1b. app-ui-tools |
   | test/smoke/06-agent.js       |    653 | testAgentStore          | 1.5 agent-store: память проекта и точки отката |
   | test/smoke/06-agent.js       |    754 | testUnifiedPatch        | 1.6 unified-patch: применение diff |
   | test/smoke/06-agent.js       |    818 | testCodeIndex           | 1.7 code-index: семантический поиск |
   | test/smoke/06-agent.js       |    885 | testAgentSpeedups       | батчинг: правило 35 в промпте + параллельный набор read-only инструментов |
   | test/smoke/06-agent.js       |   1008 | testPromptCacheAndUsage | Кэш промпта: статичный префикс и метрики токенов |
   | test/smoke/06-agent.js       |   1436 | testToolRouter          | Роутер инструментов: реестр групп и чистая функция выбора |
   | test/smoke/06-agent.js       |   1683 | testToolPolicy          | Политика инструментов и журнал действий |
   | test/smoke/07-agent-tools.js |     28 | testAgentTools          | Реестр инструментов: обработчики получают окружение main.js |
   | test/smoke/07-agent-tools.js |    877 | testContextWindow       | Разрез ядра: контекст и компакция |
   | test/smoke/07-agent-tools.js |   1082 | testWebTools            | Разрез ядра: веб-модуль |
   | test/smoke/07-agent-tools.js |   1190 | testImageTools          | Разрез ядра: вспомогательная модель (зрение + генерация изображений) |
   | test/smoke/07-agent-tools.js |   1286 | testCoreSplit           | Разрез ядра: связность |
   | test/smoke/08-providers.js   |     29 | testOllamaWindow        | Ollama: реальное окно модели, num_ctx и удержание модели в памяти |
   | test/smoke/08-providers.js   |    398 | testOpenaiProfiles      | Сохранённые OpenAI-подключения (этап 3.8, часть 2) |
   | test/smoke/08-providers.js   |    537 | testProviderConfig      | Разрез транспорта, часть 1: подключение к провайдеру |
   | test/smoke/08-providers.js   |    664 | testProviderTransport   | Разрез транспорта, часть 2: сообщения, запрос, стрим, окно модели |
   | test/smoke/08-providers.js   |    827 | testG4fPanel            | Выбор провайдера G4F в настройках (src/renderer/g4f-panel.js, этап A, часть 2) |
   | test/smoke/09-ui.js          |     37 | testUiSearch            | поиск кусков интерфейса: uiFind находит код в модуле, в app.js и не угадывает |
   | test/smoke/09-ui.js          |     54 | testAppUiRefs           | 1c. app-инструменты: стабильные ref вместо номеров [N] |
   | test/smoke/09-ui.js          |    365 | testVaultUi             | 4e. Интерфейс паролей: реальный код app.js + мини-DOM |
   | test/smoke/09-ui.js          |    482 | testSecretsPanel        | 4f. Секреты: панель (src/renderer/secrets-panel.js) |
   | test/smoke/09-ui.js          |    706 | testPlanPanel           | план: модуль на месте, оболочка только собирает его |
   | test/smoke/09-ui.js          |   1364 | testBootGuard           | дозор запуска: решения — имя файла, место падения, чего не хватает |
   | test/smoke/10-settings.js    |     35 | testCommandPalette      | Палитра команд: свой модуль (этап 8) |
   | test/smoke/10-settings.js    |    245 | testSidePanel           | Правая панель, рельса, консоль и превью: свой модуль (этап 9) |
   | test/smoke/10-settings.js    |    514 | testOneNavigation       | Одна навигация: рельса слева, шапка — действия чата (1.5.90) |
   | test/smoke/10-settings.js    |    648 | testSettingsRedesign    | Настройки: вертикальная навигация, поиск, липкий футер |
   | test/smoke/10-settings.js    |    706 | testProjectPanel        | Панель проекта (этап 7) |
   | test/smoke/10-settings.js    |    855 | testSettingsPanel       | панель настроек: модуль на месте, оболочка только собирает его |
   | test/smoke/10-settings.js    |   1078 | testSettingsSearchLogic | поиск настроек: фильтрует по всем вкладкам, включая карточки провайдеров |
   | test/smoke/10-settings.js    |   1205 | testLeftRail            | 4d. Левая рельса (как в Replit): разметка + живая логика |
   | test/smoke/10-settings.js    |   1358 | testSandboxObstacles    | 4e. Преграды из отчёта песочницы: лимит 429, ленивые списки, формат шагов |
   | test/smoke/11-ipc.js         |     33 | testServer              | 5. server.js (API-защита) |
   | test/smoke/11-ipc.js         |     79 | testMail                | 6.5 mail: почта (SMTP/IMAP) |
   | test/smoke/11-ipc.js         |    184 | testMailIpc             | Вынесенный почтовый мост |
   | test/smoke/11-ipc.js         |    266 | testFsGitIpc            | Вынесенные модули: стражи, файловая панель и git |
   | test/smoke/12-misc.js        |     43 | testDevRun              | Быстрый запуск превью (src/renderer/dev-run.js) |
   | test/smoke/12-misc.js        |    128 | testSecrets             | 2. secrets |
   | test/smoke/12-misc.js        |    180 | testOta                 | 3. ota |
   | test/smoke/12-misc.js        |    265 | testVault               | 4d. Менеджер паролей (vault) |
   | test/smoke/12-misc.js        |    436 | testSessionExtras       | 4c. Сессия и контекст: индикатор, профиль браузера, «Дописать ответ» |
   | test/smoke/12-misc.js        |    564 | testSelfDev             | 10. self-dev: защита критичной инфраструктуры самообновления |
   | test/smoke/12-misc.js        |    599 | testHighlight           | 10. self-dev: защита критичной инфраструктуры самообновления |
   | test/smoke/12-misc.js        |    669 | testContextMemory       | Память диалогов: сжатые памятки контекста по датам |
   | test/smoke/12-misc.js        |    857 | testOtaCodeVersion      | Строки действий агента и группа работ (этап 3.7, часть 5) |
   | test/smoke/12-misc.js        |    932 | testPowerShellSession   | Живая сессия PowerShell: один процесс на все системные справки |
   | test/smoke/12-misc.js        |   1070 | testSecretScopes        | Выдача секретов по назначению (1.5.84) |
   | test/smoke/12-misc.js        |   1292 | testVkFieldFixes        | 4f. Отчёт песочницы по ВК: честные ответы инструментов |
   | test/smoke/13-missions.js    |     38 | testTasksMission        | Роли, дела и миссия (src/renderer/tasks-mission.js) |
   | test/smoke/13-missions.js    |    312 | testTasks               | 1.65 дела: сроки, CRUD, панель по срокам, напоминания |
   | test/smoke/13-missions.js    |    640 | testMissionGuard        | Сторож миссий: петля «продолжай — нет, ты продолжай» (1.5.114) |
   | test/smoke/13-missions.js    |    822 | testMissions            | миссии: цель, план и журнал ложатся файлами рядом с проектом |
   КАРТА:END

   Колонка «файл» — где набор лежит (точка входа или файл-группа), «строка» —
   начало его объявления. Руками карту не правят: её пересобирает
   `npm run smoke:map` (scripts/smoke-map.js), а сверяет сторож в конце файла
   (testSelfIndex): дописал новый набор — пересобери карту, иначе прогон
   покраснеет и скажет, чего не хватает. Карта без сторожа врёт молча, а это
   хуже, чем её отсутствие.

   Все наборы идут ОДНИМ процессом: они делят подмену require, временные папки
   и счётчики, а часть проверок пишет файл и читает его следующей проверкой.
   Поэтому бегунок один и стоит в КОНЦЕ файла (раньше был в середине, из-за
   чего файл нельзя было читать сверху вниз); порядок вызовов в нём — часть
   логики, а не украшение.
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Точка входа набора (часть 81): здесь карта файла, подключения групп, сторож
// карты и бегунок. Сами наборы лежат в test/smoke/*.js — по темам, а общая
// основа (проверка, счётчики, помощники) — в test/smoke/harness.js.
const H = require(path.join(__dirname, "smoke", "harness.js"));
const {
  test,
  finish,
  mapRows,
  runnerCalls,
  mapProblems,
  setSources,
  declaredAll,
  lineAt,
  lastNonEmpty,
} = H;

// Группа «Приложение: превью, секреты, OTA, память диалогов, PowerShell» — в своём файле (часть 81): test/smoke/12-misc.js
const {
  testDevRun,
  testSecrets,
  testOta,
  testOtaCodeVersion,
  testVault,
  testSelfDev,
  testHighlight,
  testPowerShellSession,
  testSessionExtras,
  testContextMemory,
  testSecretScopes,
  testVkFieldFixes,
} = require(path.join(__dirname, "smoke", "12-misc.js"));

// Группа «Дела и миссии: сторож, прогресс, журнал» — в своём файле (часть 81): test/smoke/13-missions.js
const {
  testTasksMission,
  testMissionGuard,
  testMissions,
  testTasks,
} = require(path.join(__dirname, "smoke", "13-missions.js"));

// Группа «Настройки и навигация: панели, палитра, рельса, песочница» — в своём файле (часть 81): test/smoke/10-settings.js
const {
  testSettingsRedesign,
  testProjectPanel,
  testCommandPalette,
  testSidePanel,
  testSettingsPanel,
  testSettingsSearchLogic,
  testLeftRail,
  testSandboxObstacles,
  testOneNavigation,
} = require(path.join(__dirname, "smoke", "10-settings.js"));

// Группа «Интерфейс: поиск кусков, ref, панели паролей и плана, страж загрузки» — в своём файле (часть 81): test/smoke/09-ui.js
const {
  testUiSearch,
  testAppUiRefs,
  testVaultUi,
  testSecretsPanel,
  testPlanPanel,
  testBootGuard,
} = require(path.join(__dirname, "smoke", "09-ui.js"));

// Группа «Провайдеры: разрез транспорта, окно модели, G4F» — в своём файле (часть 81): test/smoke/08-providers.js
const {
  testProviderConfig,
  testProviderTransport,
  testOllamaWindow,
  testOpenaiProfiles,
  testG4fPanel,
} = require(path.join(__dirname, "smoke", "08-providers.js"));

// Группа «Дом инструментов агента и разрезы ядра» — в своём файле (часть 81): test/smoke/07-agent-tools.js
const {
  testAgentTools,
  testWebTools,
  testImageTools,
  testCoreSplit,
  testContextWindow,
} = require(path.join(__dirname, "smoke", "07-agent-tools.js"));

// Группа «Агент: ядро, память, правки, поиск кода, политика и кэш подсказок» — в своём файле (часть 81): test/smoke/06-agent.js
const {
  testAgentCore,
  testAppUiTools,
  testAgentStore,
  testUnifiedPatch,
  testCodeIndex,
  testAgentSpeedups,
  testToolRouter,
  testToolPolicy,
  testPromptCacheAndUsage,
} = require(path.join(__dirname, "smoke", "06-agent.js"));

// Группа «Телефон: панель, мост и страница входа» — в своём файле (часть 81): test/smoke/05-mobile.js
const {
  testMobilePanel,
  testMobileBridge,
  testMobileGate,
} = require(path.join(__dirname, "smoke", "05-mobile.js"));

// Группа «Выкат: движок, мост, приёмка production и настоящий E2E» — в своём файле (часть 81): test/smoke/04-deploy.js
const {
  testDeploy,
  testDeployIpc,
  testProductionGate,
  testRealE2E,
} = require(path.join(__dirname, "smoke", "04-deploy.js"));

// Группа «Yandex Cloud: журналы, папки, реестр, деньги» — в своём файле (часть 81): test/smoke/03-cloud.js
const {
  testYandexCloud,
  testYcDiagnosis,
  testYcFolderPersistence,
  testYcConsole,
  testYcCosts,
  testYcSplit,
} = require(path.join(__dirname, "smoke", "03-cloud.js"));

// Группа «Браузер: инструменты, карта страницы, оболочка и CDP» — в своём файле (часть 81): test/smoke/02-browser.js
const {
  testBrowserTools,
  testBrowserBrain,
  testShellAndCdp,
  testBrowserOverlays,
  testBrowserReplayData,
  testBrowserSpeed,
  testBrowserSenses,
} = require(path.join(__dirname, "smoke", "02-browser.js"));

// Группа «Чат: действия, лента, размышления, сегменты» — в своём файле (часть 81): test/smoke/01-chat.js
const {
  testChatActions,
  testWebChat,
  testChatThinking,
  testChatEvents,
  testChatSegments,
  testChatRender,
  testChatFeed,
  testChatWork,
  testChatPersistence,
  testChatContextTransfer,
  testLongChatRecovery,
  testStreamThrottle,
} = require(path.join(__dirname, "smoke", "01-chat.js"));

// Группа «Мосты IPC, сервер и почта» — в своём файле (часть 81): test/smoke/11-ipc.js
const {
  testServer,
  testMailIpc,
  testFsGitIpc,
  testMail,
} = require(path.join(__dirname, "smoke", "11-ipc.js"));








































































































async function testSelfIndex() {
  const src = fs.readFileSync(__filename, "utf8");
  const set = setSources(); // весь набор: точка входа и файлы-группы

  await test("карта файла: каждый номер строки указывает на своё объявление", () => {
    const rows = mapRows(src);
    assert.ok(rows.length >= 80, "в карте подозрительно мало строк: " + rows.length);
    for (const r of rows) {
      const one = set.filter((s) => s.file === r.file)[0];
      assert.ok(one, "в карте файл, которого нет в наборе: " + r.file);
      const head = lineAt(one.text, r.line).replace("async ", "");
      assert.ok(
        head.startsWith("function " + r.name + "("),
        r.file + ":" + r.line + " — это не " + r.name + ": " + head.slice(0, 60)
      );
    }
  });

  await test("карта файла: в ней есть каждый набор набора и нет лишних", () => {
    const rows = mapRows(src).map((r) => r.file + " :: " + r.name).sort();
    const declared = declaredAll(set).map((d) => d.file + " :: " + d.name).sort();
    assert.deepStrictEqual(rows, declared, "состав карты и набора разошёлся");
  });

  await test("карта файла: бегунок в конце зовёт каждый набор ровно раз", () => {
    const calls = runnerCalls(src);
    const declared = declaredAll(set).map((d) => d.name);
    assert.strictEqual(calls.length, new Set(calls).size, "набор вызван дважды");
    assert.deepStrictEqual(calls.slice().sort(), declared.slice().sort(), "список вызовов и наборы разошлись");
    assert.strictEqual(lastNonEmpty(src), "})();", "бегунок не последний в файле");
  });

  await test("карта файла: подложная карта обязана падать (негативный контроль)", () => {
    const body = [
      "/* КАРТА:START",
      "   | test/smoke.test.js | @@ | testOne | что-то |",
      "   КАРТА:END */",
      "",
      "function testOne() {",
      "}",
      "",
      "(async () => {",
      "  await testOne();",
      "})();",
    ];
    const at = body.indexOf("function testOne() {") + 1;
    const file = "test/smoke.test.js";
    const withNumber = (n) => body.map((l) => l.replace("@@", String(n))).join("\n");
    const good = [{ file, text: withNumber(at) }];
    assert.deepStrictEqual(mapProblems(good[0].text, good), [], "верная карта признана плохой");
    const shifted = [{ file, text: withNumber(at + 2) }];
    const problems = mapProblems(shifted[0].text, shifted);
    assert.ok(
      problems.join("; ").indexOf(String(at + 2)) >= 0,
      "неверный номер строки не замечен: " + problems.join("; ")
    );
    const absent = [{ file, text: withNumber(at).split(file).join("test/smoke/other.js") }];
    const unknown = mapProblems(absent[0].text, absent);
    assert.ok(
      unknown.join("; ").indexOf("нет в наборе") >= 0,
      "файл, которого нет в наборе, не заметен: " + unknown.join("; ")
    );
  });
}










// ── Запуск: все наборы по порядку, одним процессом ─────────────────────────
// Порядок вызовов — часть логики: часть проверок пишет файл и читает его
// следующей проверкой. Новый набор дописывается концом, а строка о нём — в
// карту файла (шапка); за расхождением следит testSelfIndex.
(async () => {
  console.log("Smoke-тесты: " + path.basename(__filename));
  await testAgentCore();
  await testAppUiTools();
  await testAppUiRefs();
  await testAgentStore();
  await testContextMemory();
  await testUnifiedPatch();
  await testCodeIndex();
  await testSecrets();
  await testOta();
  await testBrowserTools();
  await testBrowserBrain();
  await testBrowserOverlays();
  await testHighlight();
  await testMobileBridge();
  await testMobileGate();
  await testChatPersistence();
  await testSessionExtras();
  await testVault();
  await testVaultUi();
  await testSecretsPanel();
  await testMobilePanel();
  await testMail();
  await testYandexCloud();
  await testYcDiagnosis();
  await testYcFolderPersistence();
  await testShellAndCdp();
  await testServer();
  await testSelfDev();
  await testPlanPanel();
  await testStreamThrottle();
  await testBrowserSpeed();
  await testBrowserSenses();
  await testBrowserReplayData();
  await testAgentSpeedups();
  await testPowerShellSession();
  await testPromptCacheAndUsage();
  await testToolRouter();
  await testOllamaWindow();
  await testChatContextTransfer();
  await testSettingsRedesign();
  await testSettingsSearchLogic();
  await testOpenaiProfiles();
  await testProjectPanel();
  await testSettingsPanel();
  await testG4fPanel();
  await testLeftRail();
  await testSandboxObstacles();
  await testVkFieldFixes();
  await testLongChatRecovery();
  await testTasks();
  await testMissions();
  await testMissionGuard();
  await testYcConsole();
  await testDeploy();
  await testToolPolicy();
  await testYcCosts();
  await testYcSplit();
  await testDeployIpc();
  await testMailIpc();
  await testFsGitIpc();
  await testAgentTools();
  await testWebTools();
  await testImageTools();
  await testCoreSplit();
  await testUiSearch();
  await testDevRun();
  await testChatActions();
  await testWebChat();
  await testChatThinking();
  await testChatSegments();
  await testChatEvents();
  await testChatRender();
  await testChatFeed();
  await testChatWork();
  await testBootGuard();
  await testOtaCodeVersion();
  await testTasksMission();
  await testProviderConfig();
  await testProviderTransport();
  await testContextWindow();
  await testSecretScopes();
  await testOneNavigation();
  await testSidePanel();
  await testCommandPalette();
  await testRealE2E();
  await testProductionGate();
  await testSelfIndex();

  process.exit(H.finish() ? 1 : 0);
})();
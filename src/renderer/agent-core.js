"use strict";

/* Общее ядро агента: системный промпт, определения инструментов, стриппер думающих блоков,
   а также унифицированный транспорт к трём семействам провайдеров:
     - "ollama"    — локальная Ollama (нативный /api/chat, NDJSON-стрим)
     - "openai"    — OpenAI-совместимые API (OpenAI, Groq, OpenRouter, DeepSeek, Yandex AI Studio, свой) — /chat/completions
     - "anthropic" — Claude (Anthropic Messages API /v1/messages, SSE-стрим)
   Работает и в Electron main (CommonJS), и в браузере (window.AgentCore). */
(function (root, factory) {
  // Ядро собирается из вынесенных модулей: подключение к провайдеру, транспорт
  // (сообщения и стрим), контекст (бюджет и компакция), веб (поиск/чтение страниц)
  // и вспомогательная модель (зрение + изображения). В Electron main они приходят
  // через require, в окне — как одноимённые объекты в window (теги <script> ПЕРЕД
  // agent-core.js, в порядке зависимостей: config → transport → context → agent).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(
      require("./provider-config.js"),
      require("./provider-transport.js"),
      require("./context-window.js"),
      require("./web-tools.js"),
      require("./image-tools.js")
    );
  } else {
    root.AgentCore = factory(root.ProviderConfig, root.ProviderTransport, root.ContextWindow, root.WebTools, root.ImageTools);
  }
})(typeof self !== "undefined" ? self : this, function (ProviderConfig, ProviderTransport, ContextWindow, WebTools, ImageTools) {
  // ── Подключение к провайдеру ───────────────────────────────────────────────
  // Адреса, ключи, заголовки, лимиты и чтение ошибок живут в отдельном модуле
  // src/renderer/provider-config.js. Он не знает ни о сообщениях агента, ни о
  // настройках: каждое значение приходит ему аргументом. Объявления стоят в начале
  // файла, чтобы код ниже — в том числе контекст и окно модели — видел их всегда.
  const {
    G4F_PROVIDERS,
    splitG4fRoute,
    baseFor,
    isLocalBase,
    proxiedBase,
    apiKeyFor,
    apiHeaders,
    projectHeader,
    jsonArgs,
    genCallId,
    readApiError,
    friendlyRateLimitError,
    classifyKeyError,
    rateLimitInfo,
    createRateLimiter,
    fmtError,
  } = ProviderConfig;

  // ── Локальный ли сервер ────────────────────────────────────────────────
  // Признак — АДРЕС, а не имя семейства. LM Studio, vLLM, llama.cpp и LocalAI
  // говорят на OpenAI-совместимом API, но живут на своём ПК: токены там бесплатны,
  // окно может быть маленьким, а ответ на CPU — долгим. Раньше всё это было
  // привязано к provider === "ollama", и локальный сервер получал облачные лимиты
  // (бюджет от денег, таймаут 90 с, схемы всегда). Ollama остаётся локальной всегда:
  // даже на удалённом хосте её num_ctx/keep_alive — часть своего протокола.
  function isLocalEndpoint(settings) {
    const s = settings || {};
    const provider = s.provider || "openai";
    if (provider === "ollama") return true;
    try {
      return isLocalBase(baseFor(provider, s));
    } catch {
      return false;
    }
  }

  const SYSTEM_PROMPT = `Ты — «Ассистент», AI-разработчик-агент, встроенный в приложение AI Developer Agent. Ты помогаешь пользователю с разработкой: создаёшь папки и файлы, читаешь их, работаешь с git-репозиториями. В начале диалога к твоему системному промпту приложение автоматически добавляет блок «САММАРИ ПРОЕКТА» — краткую визитку рабочей папки (имя проекта, скрипты package.json, структура, начало README). Используй её как отправную точку, не переспрашивай очевидное; детали смотри через listFiles / fileOutline / readFileLines, а актуальность проверяй поиском (searchProject / searchFile).

Правила:
1. ВСЕГДА отвечай ТОЛЬКО на русском языке. Никаких английских слов в ответе, даже если пользователь пишет по-английски.
2. Отвечай коротко и по делу.
3. Если пользователь просит что-то сделать (создать файл или папку, прочитать/изменить файл, выполнить git-операцию, запустить команду) — СРАЗУ вызывай нужный инструмент через механизм вызова инструментов (tool_calls). Не отказывайся, не говори «не могу» и не переспрашивай: явная просьба пользователя уже есть.
4. НЕ выводи JSON-код инструментов в текстовый ответ — никаких {"name": "...", "arguments": {...}} и блоков кода с ними. Вызов инструмента происходит автоматически отдельным механизмом: просто опиши действие словами, приложение само выполнит его и вернёт результат.
5. Не выдумывай результаты — сначала выполни инструмент, потом сообщи реальный результат.
6. Инструменты: создание файла — writeFile (path, content), папок — createFolder (path). Чтение — readFile (path); для больших файлов — readFileLines (path, start, count), поиск по содержимому — searchFile (path, pattern), поиск по всему проекту — searchProject (pattern), обзор структуры проекта — listFiles (path). Точечные правки — editFile (path, oldText, newText), для этого сначала прочитай нужный фрагмент файла. Выполнение команд — runCommand (command). Поиск в интернете — webSearch (query); чтобы прочитать найденную страницу целиком — webFetch (url). Если нужен ответ пользователя перед действием — askUser (question). Не выдумывай других названий инструментов.
6a. Перед изменениями в чужом/большом проекте сначала осмотрись: listFiles (корень), затем searchProject или searchFile — найди, где что лежит, и только потом правь. Это экономит токены и не ломает чужой код.
7. Создание файлов и папок безопасно и разрешено — выполняй без колебаний. ПУШ НА GITHUB ЗАПРЕЩЁН: никогда не выполняй git push (ни инструментом gitPush, ни gitPublish — созданием нового репозитория и публикацией кода, — ни командой через runCommand), пока пользователь ЯВНО не разрешит — включит настройку «Разрешить агенту git push» (Настройки → GitHub) или сам попросит запушить. Если gitPush вернул блокировку — сообщи, как её снять (включить настройку или нажать Push в панели проекта → Изменения), и НЕ пытайся обойти блокировку. Другие опасные действия (удаление данных, очистка истории) — тоже только по явной просьбе. Если программа не установлена или команда не найдена: проверь checkInstalledProgram / canExecute, установи installSystemPackage, обнови PATH через refreshEnv; репозиторий без git можно скачать downloadAndExtract; непонятный код ошибки объяснит explainError; команда с правами администратора — runCommandAsAdmin.
8. Если пользователь просто здоровается — поприветствуй и спроси, чем помочь.
9. Не выводи блоки рассуждений вроде <think>...</think> в ответе — только итоговый текст.
10. Когда задача неоднозначна (куда писать, какой вариант выбрать, делать ли необратимое действие) — сначала спроси пользователя через askUser.

11. Длительные процессы (серверы, базы данных, watcher) запускай через startBackground — он не блокирует выполнение и возвращает id. Проверяй готовность сервера через checkUrl/checkPort, читай логи через backgroundOutput, отправляй ввод через sendInput, останавливай через stopBackground. Для серии команд с сохранением состояния терминала (переменные, текущая папка) используй shellStart/shellSend. Docker — через dockerBuild/dockerRun/dockerExec. Изображения показывай через showImage.
12. Оформляй ответы красиво и наглядно: используй markdown — заголовки, списки (в т.ч. чек-листы вида \`- [ ]\` / \`- [x]\`), таблицы, жирный текст, блоки кода с указанием языка (\`\`\`js, \`\`\`bash, \`\`\`json и т.п.). Для схем и диаграмм выводи блок \`\`\`mermaid с диаграммой одного из поддерживаемых типов: flowchart (направление TD или LR; узлы A[текст], A(текст), A{текст}, A((текст)); стрелки -->, ---, -.->, ==>; подписи вида B -->|да| C) или sequenceDiagram (participant X as Имя, A->>B: сообщение, A-->>B: ответ, Note over A,B: текст). Не рисуй схемы символами ASCII — только через mermaid.
13. Управление окружением: для установки пакетов используй installPackage (определяет менеджер сам), для проверки кода — lintProject (tsc/eslint), для тестов — runTests. Сравнение файлов — diffView (показывает визуальный дифф), встроенный предпросмотр сайта — previewUI, скриншот страницы — screenshotCapture (показывается во встроенном просмотрщике). Переменные окружения задавай через envSet (по умолчанию значение подмешивается во все команды агента; параметр scopes ограничивает выдачу — например scopes: [\"git\"] отдаст переменную только git-инструментам, scopes: [\"terminal\", \"project\"] — терминалу и сборке; [\"*\"] — всем), просматривай через envList (он показывает выдачу каждой переменной), удаляй через envUnset.
14. Большие файлы: не читай файл целиком через readFile, если он больше ~800 строк — readFile сам вернёт краткий обзор (число строк, структура, начало и конец). Для больших файлов сначала вызови fileOutline (карта структуры с номерами строк), затем читай нужные участки через readFileLines (диапазон 100–500 строк). Чтобы найти код в большом файле, используй searchFile: context N — строки вокруг совпадения, а blocks: true — показ ЦЕЛИКОМ функции/класса, внутри которых нашлись совпадения (экономит контекст: не надо читать файл ради одного места). Правь большие файлы через editFile в режиме startLine/endLine (замена по номерам строк) — поиск точного текста в 10 000+ строках часто не срабатывает.
15. После завершения любой работы (создание/правка файлов, выполнение команд, git-операции, запуск серверов, поиск в интернете и т.п.) ВСЕГДА пиши финальный итоговый ответ-отчёт, который полноценно отвечает на вопрос пользователя. Отчёт должен быть структурированным и включать: что именно сделано; какие файлы созданы/изменены (пути); какие команды выполнялись и с каким результатом; как проверить результат самому пользователю (что запустить, какой URL открыть, какие порты слушать); известные ограничения или что осталось на усмотрение пользователя. Оформляй отчёт красиво — заголовками и списками, при необходимости таблицей и mermaid-схемой. Не заканчивай ответ фразой «задача выполнена» без отчёта о том, что конкретно сделано.
16. Анализ проекта и рефакторинг: чтобы понять файл без чтения целиком — readFileStructure (импорты/экспорты/объявления верхнего уровня) или fileOutline (функции/классы). Откат своей правки — undoEdit. Переименование идентификатора — refactorRename (сначала dryRun: true). Проверка API — apiRequest. Проверка зависимостей — getDependencies (audit: true для уязвимостей). Форматирование — formatCode. SQL-запросы — dbQuery (нужен psql/mysql в системе). Запуск скриптов из package.json — runScript. Команда с повторными попытками или ожиданием текста в выводе (например «listening») — runCommandOutput. Полная проверка проекта (tsc + eslint + тесты) — validateProject. Ветки git — gitBranch (текущая + список), сравнение веток — gitDiff, отмена последнего коммита без потери изменений — gitUndoLastCommit (soft reset).
17. Запуск проекта: запускай проект ТОЛЬКО через встроенный терминал приложения (инструменты runCommand / startBackground / shellStart) — не проси пользователя запускать проект вручную и не открывай внешние терминалы. Dev-сервер по умолчанию запускай на порту 5000 (http://localhost:5000), если в конфиге проекта явно не задан другой порт (проверь package.json / .env / конфиги). После запуска проверь готовность через проверь через checkUrl/checkPort и сообщи пользователю адрес.
18. Изображения (вспомогательная модель, отдельный ключ): для разбора картинки/скриншота используй analyzeImage (path, question) — вспомогательная vision-модель вернёт подробное текстовое описание. Для создания картинок (баннер для главной, иконка, иллюстрация) используй generateImage (prompt, filename, aspect_ratio) — файл сохранится в рабочую директорию, пользователю покажется превью, а ты встраивай путь в проект (например <img src="...">). Если пользователь прислал скриншот — он уже автоматически разобран vision-моделью и описание подставлено в контекст; можешь дополнительно вызвать analyzeImage для деталей.
19. Самосовершенствование: ты можешь улучшать собственный код этого приложения (src/, assets/) — это нормально и приветствуется. После правок обязательно прогони проверку синтаксиса (node --check по изменённым файлам), затем собери локальное OTA-обновление: node scripts/make-ota.js — приложение подхватит его в течение минуты и перезапустится с новым кодом. Это локальный self-update: пересборка EXE и GitHub не нужны. НЕ трогай src/bootstrap.js и src/ota.js — это критичная инфраструктура загрузки и обновления; их сломанный код выведет приложение из строя.
20. Windows и системные операции: для задач про саму ОС — специальные инструменты, а не голые команды: процессы (listProcesses → killProcess), буфер (clipboardRead/clipboardWrite), screenshotDesktop, реестр (registryRead/registryWrite), openPath, установка программ (installSystemPackage/wingetSearch/installExe/checkInstalledProgram). Оболочки: shell: "powershell" и shell: "bash" у runCommand/startBackground, список доступных — shellsStatus (не выясняй пробами). Подробности и ограничения: agentGuide { name: "system" }.
21. Браузер (видимое окно Chromium): browserOpen → СРАЗУ browserSnapshot (карта: ref, роль, видимое имя), дальше действуй по ref или по видимому тексту — селекторы не перебирай. Известную последовательность шагов делай ОДНОЙ командой browserAct. После действия, меняющего страницу, — waitForIdle; результат проверяй browserText или browserNetwork, а не по памяти. Пароли — только через vaultFill (НИКОГДА не проси пароль в чате). Капча/2FA — попроси пользователя дожать её в открытом окне. ПОДРОБНЫЙ СПРАВОЧНИК (читай перед работой с сайтом): agentGuide { name: "browser" } — маршруты, шаблоны интерфейсов, слои, прокрутка, грабли.
22. СВОЁ окно приложения (app-инструменты): appRead — карта окна со СТАБИЛЬНЫМ ref, дальше appClick/appFill/appSelect/appPress/appWait/appScreenshot. Номер [N] устаревает при перерисовке — всегда бери ref из appRead. Не кликай по разрушительным кнопкам («Удалить», «Очистить чат», «Сбросить») без askUser. После действия проверяй appRead. Полный справочник: agentGuide { name: "app" }.
23. Остановка: если пользователь нажал Esc или кнопку «Стоп» (или ты получил результат «⏹ Остановлено пользователем») — немедленно прекрати вызывать инструменты, не начинай новых действий и заверши ответ КРАТКИМ итогом: что успел сделать и что осталось. Не продолжай «на всякий случай» — остановка означает остановку.
25. Проверка после правок: после серии изменений файлов запусти validateProject (типчек + линт + тесты, если они есть) — не рапортуй «готово», пока проверка не зелёная. Если что-то упало — исправь ошибки и перепроверь. Когда тесты медленные — можно ограничиться точечной проверкой через runCommand (например tsc --noEmit), но типчек при наличии tsconfig.json обязателен.
26. Семантический поиск: semanticSearch(query) ищет по коду проекта по смыслу (стебли слов, camelCase/snake_case, BM25-ранжирование) и показывает сниппеты с номерами строк. Используй его для поиска «где находится X» и «как устроен Y» — быстрее и точнее, чем читать файлы подряд. Точный регулярный поиск — searchFile/searchProject.
24. Память проекта и точки отката: заметки (noteSave/noteRead/noteList/noteDelete) — твоя долговременная память о проекте, она переживает перезапуск приложения. Сохраняй решения, архитектуру, договорённости и важные выводы; в начале новой сессии прочитай их через noteRead. Перед серией рискованных правок или рефакторингом создавай точку отката checkpointSave(label); если что-то сломалось — верни всё разом через checkpointRollback(id) (список — checkpointList). Память диалогов: когда контекст переполняется, старые шаги сворачиваются в памятку — если в настройках включена галочка «Память диалогов», приложение сохраняет такие памятки локально по датам. memoryList показывает дни и памятки за конкретный день (date: ГГГГ-ММ-ДД), memorySearch ищет по ним слова и фразы. Это помогает вспомнить прошлые сессии: «посмотри, что мы делали 5-го числа».
27. Самоизменения и OTA: перед любой правкой собственного кода (src/, assets/) сначала создай точку отката checkpointSave(label — «перед самоизменением …»). Файлы src/bootstrap.js и src/ota.js и папка применённого OTA-бандла физически заблокированы: writeFile/editFile/applyPatch вернут ошибку — не пытайся их обойти. После сборки бандла (node scripts/make-ota.js) вызови otaStatus (видно ли обновление) и otaCheck (применить); после применения — validateProject; если после обновления что-то сломалось — otaRollback.
28. Yandex Cloud: ycStatus (начни отсюда — авторизация, каталог, разрешения агента) / ycList / ycContainer (обзор, редактор, ревизии, откат — action: overview/revisions/revision/deploy/rollback/update) / ycCreate / ycDelete / ycDeploy / ycLogs / ycInstall. Создание, удаление и правка контейнеров — только по явной просьбе пользователя и при включённых чекбоксах разрешений (ресурсы платные, удаление необратимо). Перед созданием посмотри цену (ycCosts) и назови ориентир пользователю: платное создаётся лишь с confirm: true после его согласия. Токен и каталог подставляются автоматически (YC_IAM_TOKEN, YC_CLOUD_ID, YC_FOLDER_ID), yc init не нужен. Порядок работы, ключи сервисов и детали деплоя: agentGuide { name: "yc" }.
29. ВКонтакте (vk.com/vk.ru — домены взаимозаменяемы): браузерные инструменты. Поле ввода — contenteditable, селектор [role=textbox]: browserClick по полю → browserFill(selector: [role=textbox], text: ...) → отправка browserPress(key: Enter) (Shift+Enter — перенос строки). Страницы грузятся лениво — после открытия жди 2–5 секунд и перечитывай browserText; проверка отправки — текст сообщения в конце переписки. Работай в СУЩЕСТВУЮЩЕЙ вкладке браузера (новые открываются без сессии); состояние читай через browserText, а не скриншоты (ВК их обрезает); текст приходит вместе с левым меню — фильтруй по именам/датам. Вход/сессия — только руками пользователя, не обходи. Маршруты, селекторы, сценарии и известные контакты — в гайде, прочитай перед работой: readFile(path: agent-guide:vk).
30. Анализ переписок (ВК, чаты, письма, файлы): определи КТО человек по уликам в тексте (работа/задачи → коллега; семейное/личное → родственник/друг; услуги/цены/заказы → клиент/поставщик; «Вы» и официальный тон → деловой контакт), выдели СУТЬ (2–4 предложения: о чём разговор, что решено, что ждёт ответа, срочность) и оформи ТАБЛИЦЕЙ: «Человек (профиль) | Кто он | Суть переписки | Важность | Следующий шаг». Для КЛИЕНТОВ дополнительно: профиль (потребность его словами, что обсуждали, бюджет/сроки если видно, возражения, тон) + фундамент для КП (2–4 пункта, что включить в предложение, и следующий логичный шаг). Не выдумывай: чего нет в тексте — «не определено». Длинную историю читай частями (PageUp + browserText). Полная методология — readFile(path: agent-guide:chat-analysis).
31. Почта (SMTP/IMAP, Настройки → «✉️ Почта»): mailList — прочитать последние письма (отправитель, тема, дата, найденный код), mailCode — вытащить код подтверждения (from — фильтр по отправителю, например «yandex»), mailSend — отправить письмо (КП клиенту, ответ на запрос). Начни с mailList: если почта не настроена или нет разрешения на отправку, инструмент вернёт подсказку — передай её пользователю. Письма уходят с его ящика, поэтому перед отправкой клиенту покажи готовый текст и спроси подтверждение, если пользователь не просил отправить сразу. Пароль приложения не показывай и не проси в чате. Если письмо с кодом ещё не пришло — повтори mailCode через 10–20 секунд (письмо доходит не мгновенно).
32. План работ (todoWrite) — ОБЯЗАТЕЛЬНЫЙ первый шаг многошаговой задачи. Если для задачи нужно ДВА и более действий (правка+проверка, диагностика, рефакторинг, «собери/починь/проверь», разбор нескольких файлов), то САМЫМ ПЕРВЫМ вызывай todoWrite и только потом остальные инструменты: план из 3–7 коротких пунктов. Не начинай с чтения файлов и команд — без плана пользователь не видит структуру задачи, а панель плана остаётся пустой. План показывается пользователю панелью-чеклистом с прогрессом, поэтому не дублируй его в тексте ответа. После КАЖДОГО выполненного пункта вызывай todoWrite снова, присылая ПОЛНЫЙ список: текущий пункт — in_progress, сделанные — done, сорвавшийся — failed с пометкой note (по какой причине). Работай строго по плану и не расширяй объём самовольно; если план оказался неверен — перепиши его тем же инструментом. Когда все пункты done — коротко подведи итог. План НЕ нужен только для одного короткого действия или ответа без инструментов (прочитать файл, ответить на вопрос, отправить письмо). В режиме плана («📋 План-режим») todoWrite обязателен ВСЕГДА: это единственный доступный там инструмент — составь план и жди команды пользователя.

33. Интерфейсы сайтов собраны из одних и тех же узоров — не изобретай их заново: Material/antd-«select» — это НЕ <select>, автокомплиты и подсказки, длинные списки, прозрачные чекбоксы, диалоги и слои поверх страницы. Точные шаблоны и обходы: agentGuide { name: "browser" }, раздел «Интерфейсы сайтов».
34. Справочники и память маршрутов: перед работой на незнакомом сайте — agentGuide {} (список), agentGuide { url: "адрес" } (есть ли гайд для сайта), agentGuide { name: "..." } (полный текст): маршруты, подписи кнопок и грабли экономят десятки шагов. ВАЖНО: когда сложный путь пройден УСПЕШНО (регистрация, включение API, публикация, покупка, многошаговая форма) — сохрани его одним вызовом: agentGuide { save: "имя", title: "...", sites: "домен", steps: "1) … 2) подпись кнопки … 3) что ждать" }. Пиши конкретно: подписи кнопок, порядок, что ждать после шага, где грабли. В следующий раз гайд подхватится сам (при browserOpen придёт подсказка).
35. БАТЧИНГ — не трать раунды на мелочи: несколько НЕЗАВИСИМЫХ операций чтения (2–5 файлов, список папок + поиск, git status + diff + log, несколько страниц) вызывай ВСЕ СРАЗУ в одном ответе — приложение выполнит их параллельно за время одного вызова. Не объединяй то, что зависит от результата предыдущего вызова, и НИКОГДА не объединяй инструменты, которые меняют файлы/состояние или требуют подтверждения: они выполняются строго по одному. Если нужного инструмента нет в списке ниже — вызови findTools { query: "что нужно сделать, словами" }: он найдёт его и включит на всю задачу.

36. Роли чата: у диалога есть роль — Разработчик (обычная работа с кодом), Ассистент (дела на этом ПК: файлы, письма, сайты, порядок), Менеджер (задачи и сроки), Исследователь (поиск и разбор источников). Текущая роль и её правила приходят блоком «РЕЖИМ» в системном промпте — следуй ему: он важнее привычки писать код. Если просьба явно не про твою роль (например просят чинить код в режиме Менеджера) — сделай что можешь и предложи переключить роль кнопкой «Роль» у поля ввода.
37. Дела и сроки (taskAdd / taskList / taskUpdate / taskDone / taskDelete): личный список задач пользователя со сроками — он живёт в приложении и виден в панели «Дела». Начинай с taskList, когда речь о планах, дедлайнах, «что сегодня» и отчётах. Любую задачу и договорённость превращай в дело с сроком; просроченное называй первым и прямо. Срок разбирается по-человечески («завтра 14:00», «в пятницу», «через 2 недели»). Закрывай дела только по словам пользователя.
38. Данные со страницы бери ЗАПРОСОМ, а не из DOM. Ленивые и виртуальные списки (диалоги ВК, длинные таблицы, ленты) в DOM неполные: строки не отрисованы либо переиспользуются, ref устаревают после перерисовки, а прокрутка «на глаз» проскакивает элементы. Порядок: дай клиенту САМОМУ сделать запрос (открой страницу, прокрути, нажми) → browserNetwork { since: false } (адрес, тело POST, ответ) → browserReplay { match: "часть адреса", cursorParam: "...", cursorPrefix: "...", maxSteps: 30 } — он повторяет тот же запрос ИЗ СТРАНИЦЫ (те же куки и CORS) и листает ответ курсором до конца. Версию API (v) и токен НИКОГДА не подставляй сам — они берутся из перехвата (чужая версия даёт ошибку 100 invalid v). Для ленивого списка по DOM указывай СЕЛЕКТОР СТРОКИ: browserScroll { loadAll: true, container: "...", item: ".convo-item" } — тогда рост считается по уникальным строкам, а последняя прокручивается в кадр (это и запускает подгрузку). Крупные данные складывай в ФАЙЛ (save: true у browserReplay и browserEval) и читай через readFile: window теряется при перезагрузке вкладки. Встроенные предохранители: потолок шагов, стоп по пустому ответу/тоталу/неподвижному курсору, дедуп по ключу (peer_id/href).
Доступные инструменты: createFolder, readFile, readFileLines, writeFile, editFile, searchFile, listDirectory, runCommand, webSearch, webFetch, gitClone, gitStatus, gitCommit, gitPush, gitPublish, gitPull, gitLog, gitRevert, askUser, startBackground, listBackground, backgroundOutput, sendInput, stopBackground, shellStart, shellSend, checkUrl, openUrl, showImage, checkPort, listPorts, dockerBuild, dockerRun, dockerExec, installPackage, lintProject, runTests, diffView, previewUI, screenshotCapture, envSet, envList, envUnset, fileOutline, readFileStructure, explainCode, undoEdit, refactorRename, runCommandOutput, retryCommand, timeoutCommand, shellsStatus, checkInstalledProgram, canExecute, installSystemPackage, runCommandAsAdmin, refreshEnv, getSystemInfo, explainError, downloadAndExtract, apiRequest, runScript, validateProject, gitBranch, gitDiff, gitUndoLastCommit, gitInit, getDependencies, formatCode, dbQuery, gitCheckout, findReferences, analyzeImage, generateImage, listProcesses, killProcess, clipboardRead, clipboardWrite, screenshotDesktop, registryRead, registryWrite, openPath, wingetSearch, installExe, browserConnect, browserOpen, browserSnapshot, browserFill, browserClick, browserSelect, browserPress, browserText, browserScreenshot, browserWait, browserEval, browserDOM, browserOverlays, browserAct, browserScroll, browserHover, browserNetwork, browserReplay, waitForIdle, agentGuide, browserClose, browserStatus, browserClearProfile, vaultList, vaultFill, mailSend, mailList, mailCode, appRead, appClick, appFill, appSelect, appPress, appWait, appScreenshot, noteSave, noteRead, noteList, noteDelete, memoryList, memorySearch, todoWrite, checkpointSave, checkpointList, checkpointRollback, applyPatch, waitUntil, gitStash, gitCherryPick, gitBlame, semanticSearch, otaStatus, otaCheck, otaRollback, ycStatus, ycList, ycContainer, ycCosts, ycCreate, ycDelete, ycDeploy, ycLogs, ycInstall, taskAdd, taskList, taskUpdate, taskDone, taskDelete.`;

  const TOOL_DEFINITIONS = [
    {
      type: "function",
      function: {
        name: "findTools",
        description:
          "Найти инструмент под задачу, если нужного нет в списке доступных возможностей. Передай query словами («отправить письмо», «скриншот экрана», «запуш в github»). Вернёт имена подходящих инструментов с описанием и СРАЗУ включит их на всю оставшуюся задачу — дальше вызывай их как обычно. Вызывай, когда собрался сделать что-то, а подходящего инструмента в списке не видно, вместо того чтобы гадать или сдаваться.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Что нужно сделать — словами, например «отправить письмо по SMTP»" },
            limit: { type: "number", description: "Сколько инструментов вернуть (по умолчанию 8)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "createFolder",
        description: "Создать папку (рекурсивно, вместе с родительскими). path — путь к папке; относительный путь резолвится относительно рабочей директории.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к создаваемой папке" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFile",
        description: "Прочитать содержимое текстового файла. path — путь к файлу (относительный путь — от рабочей директории). Для больших файлов (более ~800 строк) возвращает не всё содержимое, а краткий обзор: число строк, первые строки, структуру файла (fileOutline) и конец файла — чтобы не жечь токены. Читай нужные участки через readFileLines, ищи код через searchFile (с параметром context), структуру смотри через fileOutline.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к файлу" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "writeFile",
        description: "Записать или перезаписать текстовый файл. Родительские папки создаются автоматически. content — полное содержимое файла. После записи файл проверяется: у .js/.mjs/.cjs — синтаксис (node --check), у .json — разбор; результат виден в ответе, а для кода сказано ещё и что нужно для запуска (Node/bun, зависимости). Проверку можно отключить: check: false.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            content: { type: "string", description: "Содержимое файла" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listDirectory",
        description: "Показать список файлов и папок в директории.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к директории" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitClone",
        description: "Клонировать git-репозиторий в рабочую директорию (или в указанную папку directory).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL репозитория (https)" },
            directory: { type: "string", description: "Папка назначения (необязательно)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitStatus",
        description: "Показать статус git-репозитория в рабочей директории.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitCommit",
        description: "Сделать git add -A и git commit с указанным сообщением message.",
        parameters: {
          type: "object",
          properties: { message: { type: "string", description: "Сообщение коммита" } },
          required: ["message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitPush",
        description: "Отправить коммиты в удалённый репозиторий (git push).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitPublish",
        description: "Выгрузить папку проекта в удалённый репозиторий. По умолчанию создаёт НОВЫЙ репозиторий на GitHub (git init при необходимости, первый коммит и push). Для GitLab, Bitbucket или своего сервера передай remoteUrl (https://gitlab.com/you/repo.git или git@bitbucket.org:you/repo.git) — репозиторий создаётся на сайте хостинга, инструмент сам пропишет remote и отправит ветку. Требует включённой настройки «Разрешить агенту git push».",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Имя нового репозитория (буквы/цифры/точка/дефис/подчёркивание, без пробелов). По умолчанию — имя текущей папки." },
            description: { type: "string", description: "Краткое описание репозитория (необязательно)." },
            private: { type: "boolean", description: "Приватный репозиторий? По умолчанию true." },
            message: { type: "string", description: "Сообщение первого коммита (по умолчанию Initial commit)." },
            directory: { type: "string", description: "Папка проекта (по умолчанию — рабочая папка агента)." },
            remoteUrl: { type: "string", description: "git-адрес не-GitHub хостинга (GitLab, Bitbucket, свой сервер). Если задан — инструмент прописывает remote и отправляет ветку вместо создания репозитория на GitHub." },
            remoteName: { type: "string", description: "Имя remote (по умолчанию origin)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitInit",
        description: "Создать НОВЫЙ ЛОКАЛЬНЫЙ git-репозиторий в папке (git init, ветка main) — БЕЗ GitHub и без сети. Удобно для нового проекта: файлы уже созданы, теперь зафиксировать их в git локально. directory — (необязательно) папка проекта, по умолчанию рабочая директория; message — (необязательно) текст первого коммита: если задан, сразу делается первый коммит всех файлов. Для публикации позже есть gitPublish/gitPush.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Папка, где создать репозиторий (по умолчанию — рабочая директория)" },
            message: { type: "string", description: "Необязательно: сообщение первого коммита" },
          },
          required: [],
        },
        },
      },
      {
        type: "function",
        function: {
        name: "gitPull",
        description: "Забрать изменения из удалённого репозитория (git pull).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitLog",
        description: "Показать последние коммиты репозитория (git log --oneline, до 30 штук).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitRevert",
        description: "Отменить коммит, создав новый коммит с обратными изменениями (git revert --no-edit). Используй, когда пользователь просит откатить изменения назад.",
        parameters: {
          type: "object",
          properties: { commit: { type: "string", description: "Хэш коммита (например 4f2a1c9) или ссылка вроде HEAD~1" } },
          required: ["commit"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFileLines",
        description: "Прочитать только указанные строки файла (для больших файлов, чтобы не выходить из контекста). path — путь; start — номер первой строки (с 1); count — сколько строк прочитать (по умолчанию 100, максимум 500). Чтобы понять, какие строки читать, сначала вызови fileOutline (структура файла) или searchFile.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            start: { type: "integer", description: "Номер первой строки (1-based)" },
            count: { type: "integer", description: "Сколько строк прочитать (по умолчанию 100)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "editFile",
        description: "Точечно заменить фрагмент в существующем файле, не перезаписывая его целиком. Два режима: (1) oldText + newText — точная замена фрагмента (включая отступы); если oldText встречается несколько раз и replaceAll=true — заменяются все вхождения, иначе ошибка с числом вхождений. (2) startLine (+ необязательно endLine) + newText — заменить диапазон строк по номерам, не зная точного текста (надёжно для больших файлов): newText становится строками startLine..endLine вместо старых. Режимы взаимоисключающие: если передан startLine, oldText игнорируется.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            oldText: { type: "string", description: "Точный заменяемый фрагмент (режим 1)" },
            newText: { type: "string", description: "Новый фрагмент / новый текст строк" },
            replaceAll: { type: "boolean", description: "Заменить все вхождения (по умолчанию false)" },
            startLine: { type: "integer", description: "Режим 2: номер первой строки диапазона для замены (1-based)" },
            endLine: { type: "integer", description: "Режим 2: номер последней строки диапазона (по умолчанию = startLine)" },
          },
          required: ["path", "newText"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "runCommand",
        description: "Выполнить команду в терминале внутри рабочей директории приложения (например npm test, npm run build, node script.js, ls, git log). Вывод обрезается до 6000 символов. Команда не должна требовать интерактивного ввода; таймаут 120 секунд. Для длительных серверов и фоновых задач используй startBackground — процесс продолжит работать после завершения вызова. Если команда похожа на dev-сервер (expo start, npm run dev, vite) и не завершилась за таймаут — приложение вернёт подсказку: серверы запускай ТОЛЬКО через startBackground (+ checkUrl/checkPort/stopBackground), а не через runCommand. Для серии команд с сохранением состояния терминала используй shellStart/shellSend.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Команда для выполнения в терминале" },
            shell: { type: "string", description: "Оболочка: cmd (по умолчанию на Windows), powershell, pwsh, bash, sh. Выбирай powershell для командлетов и объектов PowerShell — кавычки, $ и 2>$null работают как в обычной консоли." },
            timeoutMs: { type: "integer", description: "Таймаут в миллисекундах (по умолчанию 120000, максимум 300000)" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shellsStatus",
        description: "Показать, какие оболочки реально доступны на машине: cmd, powershell, pwsh, bash, sh — с путями и подсказкой, что установить, если чего-то нет. Вызывай ПЕРЕД первым запуском команд с параметром shell (особенно bash/sh на Windows — они появляются только вместе с Git for Windows), чтобы не выяснять доступность пробами и ошибками.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "webSearch",
        description: "Поиск в интернете (DuckDuckGo, бесплатно, без ключа). Возвращает до 5 результатов: заголовок, URL, сниппет. Используй, когда нужны актуальные сведения, документация, ответы, которых нет в локальных файлах.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Поисковый запрос" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "webFetch",
        description: "Прочитать веб-страницу по URL и вернуть её текст без разметки (до 30000 символов). url — полный адрес страницы, например https://... Используй после webSearch, чтобы прочитать документацию или статью целиком, а не только сниппет.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL страницы для чтения" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserSnapshot",
        description: "Карта страницы: список интерактивных элементов (кнопки, ссылки, поля, чекбоксы) с коротким ref (e1, e2…), ролью и видимым именем. Элементы диалогов и слоёв поверх страницы помечены «в диалоге» и показаны ПЕРВЫМИ (они перекрывают страницу), а о помехах (окно перевода Google, cookie-баннеры) карта предупреждает отдельной строкой. ВЫЗЫВАЙ ПЕРЕД первым действием на странице — вместо угадывания селекторов возьми ref нужной кнопки: browserClick { ref: \"e2\" }, browserFill { ref: \"e4\", text: \"...\" }. filter — сузить список (часть имени или роли, например «войти»); limit — сколько строк показать (по умолчанию 60).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            filter: { type: "string", description: "Показать только элементы, где встречается этот текст (имя, роль, id)" },
            limit: { type: "integer", description: "Максимум строк (5–200, по умолчанию 60)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserConnect",
        description: "Подключиться к СВОЕМУ Chrome пользователя через порт отладки (CDP) — тогда все браузерные инструменты работают в его вкладках с его входами на сайты (ВК, почта, кабинеты), а не в отдельном окне агента. Если Chrome с портом отладки не запущен, приложение само запустит его со своим профилем (входы сохранятся). Уже открытые вкладки пользователя подхватываются — работай в них; агент их не закрывает. Отключиться: browserClose с tabId: \"all\" — Chrome пользователя продолжит работать.",
        parameters: {
          type: "object",
          properties: {
            port: { type: "integer", description: "Порт отладки Chrome (по умолчанию 9222)" },
            launch: { type: "boolean", description: "Запустить Chrome, если он не запущен с отладкой (по умолчанию да)" },
            browser: { type: "string", description: "Какой браузер запускать: chrome или edge" },
            url: { type: "string", description: "Сразу открыть этот адрес после подключения" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserOpen",
        description: "Открыть сайт в видимом окне Chromium агента (пользователь видит всё). url — полный адрес страницы; newTab — true, чтобы открыть новую вкладку вместо активной. Возвращает id вкладки (tabId). Если нужны входы пользователя — сначала browserConnect (свой Chrome по CDP).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL страницы, например https://..." },
            newTab: { type: "boolean", description: "Открыть в новой вкладке (по умолчанию переиспользуется активная)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserFill",
        description: "Заполнить текстовое поле. Поле указывай ОДНИМ способом: ref из browserSnapshot (ref: \"e4\" — самый надёжный), label/placeholder (видимая подпись или подсказка поля), name (то же, что label), role+name или selector (CSS #id/.class, text=..., xpath=...). Поддерживаются обычные поля и contenteditable (ВК). Поле ищется и во вложенных фреймах (iframe), появление ждётся само (timeout задаёт своё время). submit: true — сразу Enter, отдельный browserPress не нужен.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            ref: { type: "string", description: "ref элемента из browserSnapshot, например e4" },
            selector: { type: "string", description: "Селектор поля: #id, .class, input[name=...], text=..., xpath=..." },
            label: { type: "string", description: "Видимая подпись поля (label) или aria-label" },
            placeholder: { type: "string", description: "Подсказка внутри поля (placeholder)" },
            name: { type: "string", description: "Название поля или его id/name" },
            role: { type: "string", description: "Роль поля: textbox, searchbox, combobox" },
            text: { type: "string", description: "Значение для ввода" },
            submit: {
              type: "boolean",
              description: "Сразу отправить (Enter) — «ввёл и отправил» одним вызовом",
            },
            timeout: { type: "integer", description: "Сколько ждать появления поля, мс (по умолчанию 3000)" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserClick",
        description: "Кликнуть по элементу (кнопка, ссылка, чекбокс, пункт меню). Указывай ОДИН способ: ref из browserSnapshot (ref: \"e2\" — самый надёжный), name (видимый текст, например name: \"Войти\"), role+name (role: \"button\", name: \"Войти\"), text (то же, что name) или selector (CSS #id, text=Кнопка, xpath=...). Если элемент не найден — вернёт похожие элементы с ref (по ним и кликай, не перебирай селекторы). waitLoad: false — не ждать загрузки после клика. Появление элемента ждём сами (до 3 с, timeout задаёт своё), ищем и во вложенных фреймах (iframe); если ссылка открыла новую вкладку — она подхватывается и становится активной.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            ref: { type: "string", description: "ref элемента из browserSnapshot, например e2" },
            name: { type: "string", description: "Видимый текст кнопки/ссылки, например «Войти»" },
            role: { type: "string", description: "Роль элемента: button, link, checkbox, radio, tab, menuitem" },
            text: { type: "string", description: "Текст элемента (то же, что name)" },
            selector: { type: "string", description: "Селектор элемента: #id, .class, text=Кнопка, xpath=..." },
            waitLoad: { type: "boolean", description: "Ждать загрузку страницы после клика (по умолчанию true)" },
            timeout: { type: "integer", description: "Сколько ждать появления элемента, мс (по умолчанию 3000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserAct",
        description:
          "Сделать НЕСКОЛЬКО действий на странице ОДНОЙ командой — так не тратятся ходы на клик, ввод, Enter и проверку по отдельности. " +
          "steps — массив шагов, они выполняются по порядку; первый сбой останавливает цепочку и объясняет причину. " +
          "ИСПОЛЬЗУЙ ЭТО, когда последовательность известна. Шаг — любой из форм: " +
          '{"click":"Войти"} или {"ref":"e2"} — клик; {"fill":{"ref":"e4","text":"Москва"},"submit":true} или {"field":"Почта","text":"a@b.c"} — ввод (submit: true = сразу Enter); ' +
          '{"goto":"https://…"} — открыть адрес (можно начать цепочку с него); {"back":true} — вернуться назад; {"press":"Enter"} или {"key":"Escape"} — клавиша; {"wait":800} — пауза; {"waitFor":"Готово"} — ждать появление элемента; {"scroll":"down","times":3} — прокрутка (ленивые ленты и подгрузка); ' +
          '{"eval":"document.title"} — JS на странице; {"read":true} — текст страницы; {"snapshot":true} — карта страниц с ref. ' +
          "Элементы ищутся по ref/имени/подписи и во вложенных фреймах (iframe), появления ждём сами. stopOnError: false — не останавливаться на сбое; stepDelayMs — пауза между шагами.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            steps: {
              type: "array",
              description:
                'Шаги по порядку (до 20). Пример: [{"click":"Войти"},{"field":"Почта","text":"a@b.c"},{"fill":"пароль","ref":"e5","submit":true},{"read":true}]',
              items: {
                type: "object",
                description: "Шаг: goto / click / fill (+submit) / press / wait / waitFor / back / scroll / eval / read / snapshot",
              },
            },
            stopOnError: { type: "boolean", description: "Останавливаться на первом сбое (по умолчанию да)" },
            stepDelayMs: { type: "integer", description: "Пауза между шагами, мс (0–5000)" },
          },
          required: ["steps"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserSelect",
        description: "Выбрать вариант в выпадающем списке (<select>). Список указывай через ref из browserSnapshot, label (видимая подпись) или selector; value — значение варианта. Если варианта нет, вернёт реальные варианты списка.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            ref: { type: "string", description: "ref списка из browserSnapshot" },
            selector: { type: "string", description: "Селектор списка" },
            label: { type: "string", description: "Видимая подпись списка" },
            value: { type: "string", description: "Значение варианта (атрибут value)" },
          },
          required: ["value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserPress",
        description: "Нажать клавишу на открытой странице (Enter — отправка формы, Escape, Tab, стрелки). tabId — id вкладки; key — имя клавиши (Enter, Escape, Tab, ArrowDown...).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            key: { type: "string", description: "Клавиша: Enter, Escape, Tab, ArrowDown и т.п." },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserText",
        description: "Прочитать видимый текст открытой страницы (до max символов, по умолчанию 12000). Возвращает URL, заголовок и текст. Используй, чтобы понять, что на странице, после кликов/заполнения. tabId — id вкладки.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            max: { type: "integer", description: "Максимум символов (1000–30000, по умолчанию 12000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserScreenshot",
        description: "Скриншот открытой страницы: сохраняется В ФАЙЛ, путь возвращается (файл сразу показывается пользователю в чате). Если настроена вспомогательная модель — она автоматически описывает, что видно (analyze: false отключает разбор). Зрение может не ответить — это не блокер, работай по DOM (browserSnapshot / browserDOM / browserEval). fullPage — вся длина страницы.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            fullPage: { type: "boolean", description: "Скриншот всей страницы (по умолчанию только видимая часть)" },
            analyze: { type: "boolean", description: "Разобрать скриншот vision-моделью (по умолчанию да, если она настроена)" },
            question: { type: "string", description: "Что именно спросить у vision-модели (необязательно)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserEval",
        description:
          "Выполнить JavaScript на открытой странице и получить результат. Самый надёжный путь через любые слои: " +
          "нажать перекрытую кнопку (el.click()), отметить скрытую галочку (нужно сначала выставить checked, затем dispatchEvent change), " +
          "прочитать значение из JS-состояния, разобрать структуру. script — выражение ИЛИ набор операторов со своим return. " +
          "ЕСЛИ КОД НИЧЕГО НЕ ВЕРНУЛ — это не значит, что он не выполнился: набор операторов без return отрабатывает молча, инструмент скажет об этом прямо и сам подставит значение из window.__x, если ты в него писал. " +
          "DOM-узел целиком через мост не проходит: инструмент приводит узел к разметке сам, но надёжнее просить примитивы: .outerHTML, .textContent, .length, Array.from(...).map(...). " +
          "Накопленное НЕ держи только в window: перезагрузка вкладки его стирает — sessionStorage переживает перезагрузку вкладки, а save: true кладёт результат в файл и возвращает путь (читай через readFile): так ни один хвост не обрежется.",
        parameters: {
          type: "object",
          properties: {
            script: { type: "string", description: "JS-код или выражение, например: document.querySelector('input[type=checkbox]').click()" },
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            maxChars: { type: "integer", description: "Сколько символов результата вернуть (по умолчанию 2000)" },
            save: { type: "boolean", description: "Записать результат в файл и вернуть путь (большие данные: страница перезагрузится — накопленное в window пропадёт, файл останется)" },
          },
          required: ["script"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserDOM",
        description:
          "Показать HTML вокруг элемента (outerHTML, до 30000 символов) вместе с его текстом — чтобы понять структуру незнакомого окна/слоя: " +
          "классы, aria-атрибуты, вложенность. Ищет и внутри shadow DOM. Укажи selector (CSS) или ref из browserSnapshot.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS-селектор элемента или слоя (например .cdk-overlay-pane)" },
            ref: { type: "string", description: "ref элемента из browserSnapshot (альтернатива selector)" },
            limit: { type: "integer", description: "Максимум символов HTML (по умолчанию 3000)" },
            tabId: { type: "string", description: "id вкладки (необязательно)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserOverlays",
        description:
          "Что открыто ПОВЕРХ страницы: диалоги (Angular CDK, модальные окна), баннеры cookie, окно перевода Google — с элементами и ref. " +
          "dismiss: true — закрыть ПОМЕХИ (окно перевода, cookie-баннеры, «Понятно/Dismiss/✕»); юридические согласия сам не подтверждаю. " +
          "acceptTerms: true — осознанно отметить галочку согласия и нажать «Agree/Принять/Продолжить» (только если пользователь просил пройти этот экран). " +
          "Если диалог перекрывает кнопки на странице — сначала посмотри сюда.",
        parameters: {
          type: "object",
          properties: {
            dismiss: { type: "boolean", description: "Закрыть помехи: окно перевода Google, cookie-баннеры, «Понятно/Не сейчас/Dismiss»" },
            acceptTerms: { type: "boolean", description: "Отметить галочку и нажать кнопку согласия (terms of service) — только по просьбе пользователя" },
            tabId: { type: "string", description: "id вкладки (необязательно)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserWait",
        description: "Ждать появления элемента (загрузка после входа, капча, кнопка). Элемент можно описать словами: name/text (видимый текст), ref из browserSnapshot или selector. timeout — мс ожидания (по умолчанию 10000, максимум 60000).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            name: { type: "string", description: "Видимый текст ожидаемого элемента" },
            text: { type: "string", description: "То же, что name" },
            ref: { type: "string", description: "ref элемента из browserSnapshot" },
            role: { type: "string", description: "Роль: button, link, textbox, checkbox…" },
            selector: { type: "string", description: "Селектор ожидаемого элемента" },
            timeout: { type: "integer", description: "Таймаут в мс (по умолчанию 10000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserScroll",
        description:
          "Прокрутить страницу, ВНУТРЕННИЙ контейнер (список, таблица, выпадающее меню) или прокрутить ДО элемента. В ответе — что сейчас в кадре, с ref: можно кликать сразу. " +
          "ИСПОЛЬЗУЙ ЭТО вместо поиска «невидимых» элементов: половина кнопок, пунктов списков и хвостов диалогов не попадает в карту, пока они ниже видимой области. " +
          "how: down (по умолчанию) / up / top / bottom; by — пикселей за раз (по умолчанию ~0.8 экрана); times — сколько раз крутить; " +
          "to — к какому элементу прокрутить (имя, ref или селектор); container — что именно крутить (имя/ref/селектор блока со своим скроллом). " +
          "Крутит настоящим колесом мыши (ленивые ленты и SPA подгружаются), при необходимости программно; если страница не сдвинулась — скажет, что нужно указать container. " +
          "loadAll: true — ДОГРУЗИТЬ ленивый список или длинную историю: крутит, пока появляется новое содержимое, и сам останавливается (не надо вызывать прокрутку по кругу). " +
          "ДЛЯ ВИРТУАЛЬНЫХ СПИСКОВ добавь item — селектор строки (в ВК это \".ConvoListItem, .convo-item\"): рост считается по уникальным строкам, а не по тексту страницы, где смешаны меню и реклама. " +
          "Если список сам сообщает общее число строк (aria-setsize), инструмент НЕ объявит список законченным, пока в DOM строк меньше обещанного, и честно скажет, сколько видно из скольких. " +
          "Увидел «в DOM 16 строк из ~110» — прокрутка дальше не поможет (узлы переиспользуются): полный список забирай запросом через browserReplay. " +
          "read: true — вернуть текст страницы (для чтения истории переписки после догрузки).",
        parameters: {
          type: "object",
          properties: {
            how: { type: "string", description: "down / up / top / bottom (по умолчанию down)" },
            by: { type: "integer", description: "Пикселей за один раз (по умолчанию ~0.8 высоты экрана)" },
            times: { type: "integer", description: "Сколько раз прокрутить (1–20)" },
            to: { type: "string", description: "Элемент, до которого прокрутить: текст, ref (e5) или CSS-селектор" },
            container: { type: "string", description: "Прокручиваемый блок (список, таблица, меню): текст, ref или селектор" },
            loadAll: { type: "boolean", description: "Догрузить ленивый список/историю: крутит, пока появляется новое, и сам останавливается (до 40 шагов)" },
            read: { type: "boolean", description: "В ответ добавить текст страницы целиком (читать догруженную историю переписки)" },
            limit: { type: "integer", description: "Сколько элементов показать из кадра (по умолчанию 10)" },
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserHover",
        description:
          "Навести курсор на элемент — меню, подменю и подсказки, которые раскрываются только по наведению, кликом не открыть. " +
          "Элемент описывается как для клика: name/text (видимый текст), ref из browserSnapshot или selector. " +
          "В ответе — какие НОВЫЕ элементы появились (их можно кликать по имени). Если ничего не появилось — на этом сайте hover не нужен, работай browserClick.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            name: { type: "string", description: "Видимый текст элемента" },
            text: { type: "string", description: "То же, что name" },
            ref: { type: "string", description: "ref элемента из browserSnapshot" },
            selector: { type: "string", description: "CSS-селектор, text=… или xpath=…" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserNetwork",
        description:
          "Что страница РЕАЛЬНО отправила и что ответил сервер (XHR/fetch: метод, адрес, статус, тип, тело ответа). Спрашивай СРАЗУ после действия — тогда видно, ушла ли форма и что вернул сервер (ошибку, токен, пустой ответ), вместо догадок по DOM. " +
          "По умолчанию отдаёт новые запросы с прошлого вызова и очищает журнал; статика (картинки, скрипты, стили) отсеивается. filter — подстрока адреса; all: true — включая статику; bodies: false — без тел ответов; since: false — всё накопленное без очистки. Видно и ТЕЛО POST-запроса (секреты скрыты) — по нему browserReplay повторяет тот же запрос с пагинацией.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            filter: { type: "string", description: "Показывать только адреса с этой подстрокой" },
            all: { type: "boolean", description: "Включая картинки, скрипты и стили" },
            bodies: { type: "boolean", description: "false — не читать тела ответов" },
            since: { type: "boolean", description: "false — отдать всё накопленное и не очищать журнал" },
            clear: { type: "boolean", description: "Просто очистить журнал" },
            limit: { type: "integer", description: "Сколько последних запросов показать (по умолчанию 25)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserReplay",
        description:
          "Собрать данные тем же ЗАПРОСОМ, который делает сам сайт, — для ленивых и виртуальных списков (диалоги ВК, таблицы, ленты), где DOM показывает лишь часть строк. " +
          "Сначала дай клиенту сделать запрос (открой страницу/прокрути/кликни), посмотри browserNetwork { since: false } — а потом вызови browserReplay { match: \"часть адреса или тела\" }: он возьмёт из перехвата адрес, метод, версию API и токен, повторит запрос ИЗ САМОЙ страницы (куки и CORS как у клиента) и пролистает ответ курсором. " +
          "MATCH ИЩЕТСЯ И В АДРЕСЕ, И В ТЕЛЕ запроса: сайты часто шлют методы бандлом (POST .../method/batch.call, а имя метода — внутри тела), и по адресу такой запрос не найти. Тело повторяется целиком, вместе с токеном сессии. " +
          "Если сервер отверг образец (истёк токен, сменилась версия клиента) — инструмент один раз сам возьмёт свежий перехват; свежего нет — подёргай страницу и повтори." +
          "НАСТРОЙКИ ПАГИНАЦИИ: cursorParam (поле тела, например start_from), cursorPrefix (префикс значения, например conversations_), cursorPath (где в ответе лежит курсор — определяется автоматически), start (первое значение), itemsPath (где массив элементов — определяется автоматически), totalPath, maxSteps (потолок, по умолчанию 20). " +
          "ПРАВКИ ЗАПРОСА: set (переопределить поля тела), remove (убрать поля), key (по какому полю считать повторы — по умолчанию peer_id/id/href). " +
          "РЕЗУЛЬТАТ: по умолчанию пишется В ФАЙЛ (save: false — вернуть в чат), pick: [\"путь.к.полю\", ...] — показать строки таблицей, rows — сколько строк. " +
          "Предохранители встроены: потолок шагов, стоп по пустому ответу, по достижению total и по неподвижному курсору, дедупликация повторов. НЕ подставляй версию API (v) и токен руками — они берутся из перехвата, чужая версия даёт ошибку 100 invalid v.",
        parameters: {
          type: "object",
          properties: {
            match: { type: "string", description: "Часть адреса ИЛИ тела запроса из журнала сети, например messages.getItems — у бандлов (batch.call) имя метода лежит в теле, и совпадение находится там (по умолчанию — последний POST с телом)" },
            url: { type: "string", description: "Адрес запроса, если повторять не из перехвата" },
            method: { type: "string", description: "POST (по умолчанию) или GET" },
            body: { type: "string", description: "Тело запроса (form-encoded), если задаёшь вручную" },
            set: { type: "object", description: "Переопределить поля тела, например { target_count: 50 }" },
            remove: { type: "array", description: "Убрать поля тела" },
            cursorParam: { type: "string", description: "Поле тела с курсором, например start_from" },
            cursorPrefix: { type: "string", description: "Префикс значения курсора, например conversations_" },
            cursorPath: { type: "string", description: "Где в ответе взять следующий курсор (по умолчанию ищется сам)" },
            itemsPath: { type: "string", description: "Где в ответе массив элементов (по умолчанию ищется сам)" },
            totalPath: { type: "string", description: "Где в ответе общее количество" },
            key: { type: "string", description: "Поле для дедупликации строк, например conversation.peer.id" },
            maxSteps: { type: "integer", description: "Потолок запросов (1–60, по умолчанию 20)" },
            pick: { type: "array", description: "Какие поля вывести строками, например [\"conversation.peer.id\", \"last_message.text\"]" },
            rows: { type: "integer", description: "Сколько строк показать (по умолчанию 20)" },
            save: { type: "boolean", description: "false — вернуть данные в чат вместо файла" },
            dir: { type: "string", description: "Папка для файла результата" },
            headers: { type: "object", description: "Дополнительные заголовки запроса" },
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "waitForIdle",
        description:
          "Дождаться, когда страница УСПОКОИТСЯ: DOM перестанет меняться и сеть опустеет. Нужно на Angular/React-сайтах, где после клика всё перерисовывается и элемент «уезжает» — вместо угадывания пауз вызывай это после действия, а потом делай browserSnapshot (ref уже не устареют). quietMs — сколько тишины считать покоем (по умолчанию 500 мс), timeout — максимум ожидания (по умолчанию 8000 мс).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            quietMs: { type: "integer", description: "Тишина в мс, после которой страница считается спокойной (100–5000)" },
            timeout: { type: "integer", description: "Максимум ожидания в мс (по умолчанию 8000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "agentGuide",
        description:
          "Справочники по сайтам и темам: маршруты, подводные камни, рабочие селекторы. ВЫЗЫВАЙ ПЕРЕД работой на незнакомом сайте (после browserOpen / browserAct goto) — это экономит десятки шагов. " +
          'Действия: без аргументов — список; { name: "google-cloud" } — полный текст гайда; { url: "https://console.cloud.google.com" } — есть ли гайд для адреса; ' +
          'а когда путь пройден успешно — сохрани его: { save: "google-cloud", title: "Как включить API", steps: "1) … 2) …", sites: "console.cloud.google.com" } (пишется в память приложения и читается в следующий раз).',
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "list / read / match / save (можно не указывать — определится по аргументам)" },
            name: { type: "string", description: "Имя справочника (латиницей), например google-cloud" },
            url: { type: "string", description: "Адрес страницы — подобрать справочник по домену" },
            save: { type: "string", description: "Имя справочника, в который дописать пройденный маршрут" },
            title: { type: "string", description: "Заголовок маршрута" },
            steps: { type: "string", description: "Что и в каком порядке сработало: подписи кнопок, селекторы, ожидания, грабли" },
            sites: { type: "string", description: "Домены через запятую — по ним гайд подхватится автоматически" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserClose",
        description: "Закрыть вкладку (tabId, по умолчанию активную) или все вкладки и браузер (tabId: \"all\").",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки или \"all\" для закрытия всего браузера" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserStatus",
        description: "Показать состояние браузера: список открытых вкладок (id, заголовок, URL) и какая из них активная. Без аргументов.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserClearProfile",
        description: "Очистить постоянный профиль браузера: закрыть браузер и стереть куки, localStorage и сессии всех сайтов. Используй, только если пользователь сам попросил «выйти со всех сайтов / очистить браузер агента» — после этого придётся авторизовываться заново.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "vaultList",
        description: "Показать сохранённые в менеджере паролей сайты: название, адрес, логин и есть ли пароль. Пароли НИКОГДА не возвращаются — они подставляются только инструментом vaultFill. Без аргументов. Вызывай перед тем, как просить у пользователя логин.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "vaultFill",
        description: "Подставить сохранённые логин и пароль в форму входа на открытой странице. Пароль берётся из менеджера паролей и уходит напрямую в браузер — в чат он не попадает, поэтому пароль в чате не спрашивай. site — название сайта или адрес («ВК», «vk.com»). submit:true — сразу отправить форму клавишей Enter (по умолчанию false: сначала проверь поля).",
        parameters: {
          type: "object",
          properties: {
            site: { type: "string", description: "Название сайта или адрес из vaultList (например «ВК» или vk.com)" },
            submit: { type: "boolean", description: "Отправить форму сразу после заполнения (Enter). По умолчанию false" },
            loginSelector: { type: "string", description: "Свой CSS-селектор поля логина (если автоопределение не сработало)" },
            passwordSelector: { type: "string", description: "Свой CSS-селектор поля пароля" },
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
          },
          required: ["site"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mailSend",
        description: "Отправить письмо по электронной почте (например коммерческое предложение клиенту). to — адрес или несколько через запятую; subject — тема; text — текст письма (можно с переносами строк); html — необязательная HTML-версия. Требует двух условий: настроенного пароля приложения (Настройки → «✉️ Почта») и включённого разрешения «Разрешить агенту отправлять письма». Письмо уходит с ящика пользователя — перед отправкой клиенту покажи готовый текст и попроси подтверждение, если пользователь не просил отправить сразу.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Адрес получателя (или несколько через запятую)" },
            subject: { type: "string", description: "Тема письма" },
            text: { type: "string", description: "Текст письма (обычный текст)" },
            html: { type: "string", description: "HTML-версия письма (необязательно)" },
          },
          required: ["to", "subject", "text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mailList",
        description: "Прочитать последние входящие письма: отправитель, тема, дата, найденный код подтверждения и первые строки текста. limit — сколько писем (по умолчанию 5, максимум 10); unseenOnly: true — только непрочитанные. Используй, чтобы найти код подтверждения при регистрации на сайте или письмо от клиента.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "Сколько последних писем вернуть (1–10, по умолчанию 5)" },
            unseenOnly: { type: "boolean", description: "Только непрочитанные письма (по умолчанию false)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mailCode",
        description: "Найти код подтверждения в свежих письмах (для регистрации или входа на сайтах). from — необязательный фильтр по отправителю или теме («yandex», «gosuslugi»). Возвращает сам код и письмо, в котором он найден. Вызывай после того, как сайт запросил код: письмо приходит в течение минуты.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Фильтр по отправителю или теме письма (необязательно)" },
            limit: { type: "integer", description: "Сколько последних писем проверить (по умолчанию 5, максимум 10)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appRead",
        description: "Карта собственного окна приложения: видимые кнопки, вкладки, поля и списки — каждая строка это ref (e12), роль, видимое имя, id/класс; плюс открытые панели и фрагмент текста. Без аргументов. Вызывай перед действием в UI и после него. ref стабильны, пока элемент жив; после перерисовки окна (обновление списков, смена вкладки) сделай appRead заново. Ищи нужную строку глазами по имени кнопки — и кликай по её ref.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "appClick",
        description: "Кликнуть по элементу в собственном окне приложения. Указывай ОДИН способ: ref из appRead (ref: \"e12\" — самый надёжный), text — видимый текст («Настройки», «Сохранить»), role+text, или selector (#id/.class). Поле index (номер [N]) принимается только для совместимости: номер ломается при перерисовке окна, поэтому он не рекомендуется. Клики по разрушительным кнопкам («Удалить», «Очистить чат», «Сбросить», «Отменить изменения») заблокированы — для них спроси пользователя через askUser. Если элемент не найден, вернётся свежая карта с ref — кликай по ней. После клика проверяй результат через appRead.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref элемента из appRead, например e12" },
            text: { type: "string", description: "Видимый текст элемента (кнопка, вкладка, пункт меню)" },
            role: { type: "string", description: "Роль: button, link, tab, checkbox (необязательно)" },
            selector: { type: "string", description: "CSS-селектор: #id или .class" },
            index: { type: "integer", description: "Устарело: номер [N] из appRead (ненадёжен при перерисовке)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appFill",
        description: "Ввести текст в поле ввода в собственном окне приложения (URL провайдера, модель, путь и т.п.). Поле указывай через ref из appRead (ref: \"e4\" — надёжнее всего), label/placeholder (видимая подпись или подсказка) или selector (#id/.class). text — вводимое значение. Работает с обычными и React-управляемыми полями. Значения бери ТОЛЬКО из настроек или от пользователя; значения секретных полей (пароли, токены) в ответ не выводятся.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref поля из appRead, например e4" },
            selector: { type: "string", description: "Селектор поля: #id, .class, input[name=...]" },
            label: { type: "string", description: "Видимая подпись поля (label)" },
            placeholder: { type: "string", description: "Подсказка внутри поля" },
            text: { type: "string", description: "Значение для ввода" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appSelect",
        description: "Выбрать вариант в выпадающем списке (<select>) в собственном окне приложения. Список указывай через ref из appRead, label (видимая подпись) или selector; value — атрибут value варианта, text — видимый текст варианта. Если варианта нет, вернёт реальный список вариантов.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref списка из appRead" },
            selector: { type: "string", description: "Селектор списка" },
            label: { type: "string", description: "Видимая подпись списка" },
            value: { type: "string", description: "Значение варианта (атрибут value)" },
            text: { type: "string", description: "Или видимый текст варианта" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appPress",
        description: "Нажать клавишу в собственном окне приложения: Enter (отправка/подтверждение), Escape (закрыть оверлей/окно настроек), Tab, ArrowDown и т.п. key — имя клавиши.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Клавиша: Enter, Escape, Tab, ArrowDown..." } },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appWait",
        description: "Ждать появления элемента в собственном окне приложения (после открытия панели, загрузки списка, действий пользователя). Указывай ref из appRead, видимый text или selector; timeout — миллисекунды ожидания (по умолчанию 20000).",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref ожидаемого элемента из appRead" },
            text: { type: "string", description: "Видимый текст ожидаемого элемента" },
            selector: { type: "string", description: "CSS-селектор ожидаемого элемента" },
            timeout: { type: "integer", description: "Таймаут в миллисекундах (по умолчанию 20000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appScreenshot",
        description: "Сделать скриншот собственного окна приложения и показать его пользователю. Нужен, когда надо реально «посмотреть» на UI (подходит vision-модель через analyzeImage); для обычного чтения состояния используй appRead — он точнее и без картинок.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "searchFile",
        description: "Поиск по содержимому файла без чтения его целиком (удобно для больших файлов). path — путь к файлу; pattern — строка или регулярное выражение; caseSensitive — true, если важен регистр (по умолчанию поиск без учёта регистра); maxResults — сколько совпадений показать (по умолчанию 40); context — сколько строк ПОКАЗАТЬ ВОКРУГ каждого совпадения (по умолчанию 0), чтобы видеть код, а не только номер строки; blocks — true, чтобы показывать ЦЕЛИКОМ функции/классы/методы, внутри которых нашлись совпадения (с диапазоном строк), вместо отдельных строк. Возвращает номера строк с совпадениями и, при context>0 или blocks=true, сам код вокруг них.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            pattern: { type: "string", description: "Строка или регулярное выражение для поиска" },
            caseSensitive: { type: "boolean", description: "Учитывать регистр (по умолчанию false)" },
            maxResults: { type: "integer", description: "Максимум совпадений в ответе (по умолчанию 40)" },
            context: { type: "integer", description: "Строк контекста вокруг каждого совпадения (по умолчанию 0)" },
            blocks: { type: "boolean", description: "true — показывать целиком функции/классы вокруг совпадений (по умолчанию false)" },
          },
          required: ["path", "pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fileOutline",
        description: "Карта структуры файла: список определений (функции, классы, методы, константы, экспорты, заголовки markdown, CSS-селекторы, HTML-блоки) с номерами строк — как оглавление. path — путь к файлу; pattern — необязательная строка/регулярное выражение для фильтрации определений (по имени или типу). Незаменим для больших файлов (10 000+ строк): сначала fileOutline, потом readFileLines нужного диапазона. Возвращает до 300 определений.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            pattern: { type: "string", description: "Фильтр: показать только определения, чьё имя или тип совпадает (необязательно)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "searchProject",
        description: "Поиск по всем файлам рабочей директории (рекурсивно, как grep по проекту): находит файлы и строки, где встречается pattern (строка или регулярное выражение). Папки node_modules/.git/dist/сборки пропускаются. maxResults — максимум совпадений (по умолчанию 30). Используй, чтобы понять, где в проекте что-то используется, не читая файлы по одному.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Строка или регулярное выражение" },
            path: { type: "string", description: "Подпапка для сужения поиска (необязательно)" },
            caseSensitive: { type: "boolean", description: "Учитывать регистр (по умолчанию false)" },
            maxResults: { type: "integer", description: "Максимум совпадений (по умолчанию 30)" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listFiles",
        description: "Рекурсивно показать структуру файлов и папок рабочей директории (или подпапки path): до 300 записей, глубоко до 6 уровней. Папки node_modules/.git/dist/сборки пропускаются. Используй в начале работы, чтобы осмотреться в незнакомом проекте.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Относительный путь к подпапке (необязательно)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "startBackground",
        description: "Запустить длительный процесс в фоне (сервер, watcher, база данных) и сразу вернуть управление. command — команда (например «npm run dev»); name — короткое имя (необязательно); cwd — рабочая папка (необязательно, по умолчанию рабочая директория). Возвращает id процесса, который используется в listBackground, backgroundOutput, sendInput, stopBackground.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Команда для запуска в фоне" },
            name: { type: "string", description: "Короткое имя процесса (необязательно)" },
            cwd: { type: "string", description: "Рабочая папка процесса (необязательно)" },
            shell: { type: "string", description: "Оболочка: cmd, powershell, pwsh, bash, sh (по умолчанию cmd на Windows, sh на macOS/Linux)" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listBackground",
        description: "Показать запущенные фоновые процессы: id, имя, PID, статус (работает/завершён) и хвост вывода.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "backgroundOutput",
        description: "Показать последние строки вывода фонового процесса по его id. Полезно после запуска сервера, чтобы увидеть логи и убедиться, что он поднялся.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "id фонового процесса" },
            lines: { type: "integer", description: "Сколько последних строк показать (по умолчанию 50)" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sendInput",
        description: "Отправить текст в stdin запущенного фонового процесса (например, ответить «y» на подтверждение или ввести команду в интерактивную программу). id — id процесса; input — текст (перевод строки добавляется автоматически).",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "id фонового процесса" },
            input: { type: "string", description: "Текст для отправки в процесс" },
          },
          required: ["id", "input"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "stopBackground",
        description: "Остановить фоновый процесс по его id (убивает сам процесс и его дочерние процессы).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "id фонового процесса" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shellStart",
        description: "Запустить постоянную shell-сессию (persistent shell): в отличие от runCommand сессия живёт между вызовами — можно отправлять команды по одной через shellSend и видеть живой вывод. Возвращает id сессии.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Имя сессии (необязательно)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shellSend",
        description: "Отправить команду в постоянную shell-сессию (id от shellStart) и вернуть её вывод. Состояние терминала (переменные, текущая папка) сохраняется между командами.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "id shell-сессии" },
            command: { type: "string", description: "Команда для выполнения в сессии" },
          },
          required: ["id", "command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkUrl",
        description: "Проверить, что HTTP(S)-сервер отвечает по URL: вернёт статус-код, заголовки и начало тела. Полезно после запуска сервера, чтобы убедиться, что он поднялся.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL для проверки, например http://localhost:3000" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "openUrl",
        description: "Открыть URL в браузере пользователя (внешний браузер по умолчанию). url — полный адрес.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL для открытия" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "showImage",
        description: "Показать пользователю изображение (скриншот, результат сборки фронтенда и т.п.) в просмотрщике приложения. path — путь к файлу изображения (относительный — от рабочей директории).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к файлу изображения" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkPort",
        description: "Проверить, занят ли TCP-порт на localhost (слушает ли его какой-то процесс). Полезно узнать, на каком порту поднялся сервер или не упал ли он.",
        parameters: {
          type: "object",
          properties: { port: { type: "integer", description: "Номер порта" } },
          required: ["port"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listPorts",
        description: "Показать список TCP-портов, которые сейчас слушаются на машине (netstat/ss/lsof). Помогает найти, на каком порту поднялся сервер.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "dockerBuild",
        description: "Собрать Docker-образ из Dockerfile. directory — папка с Dockerfile; tag — имя образа (необязательно). Требует установленного Docker.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Папка с Dockerfile" },
            tag: { type: "string", description: "Имя образа:tag (необязательно)" },
          },
          required: ["directory"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "dockerRun",
        description: "Запустить Docker-контейнер. image — имя образа; args — дополнительные аргументы (например «-p 5432:5432 -e POSTGRES_PASSWORD=pass»); detached — true, чтобы запустить в фоне и вернуть id контейнера (по умолчанию true). Требует установленного Docker.",
        parameters: {
          type: "object",
          properties: {
            image: { type: "string", description: "Имя Docker-образа" },
            args: { type: "string", description: "Дополнительные аргументы docker run" },
            detached: { type: "boolean", description: "Запустить в фоне (по умолчанию true)" },
          },
          required: ["image"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "dockerExec",
        description: "Выполнить команду внутри запущенного Docker-контейнера (docker exec). container — имя или id контейнера; command — команда для выполнения.",
        parameters: {
          type: "object",
          properties: {
            container: { type: "string", description: "Имя или id контейнера" },
            command: { type: "string", description: "Команда внутри контейнера" },
          },
          required: ["container", "command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "installPackage",
        description: "Установить npm-пакет (или несколько) в проект: определяет пакетный менеджер по lockfile (npm/yarn/pnpm/bun), выполняет установку и возвращает вывод с установленной версией. packageName — имя пакета (можно с версией, например «react@18» или «-D typescript»); dev — true, чтобы установить в devDependencies (по умолчанию false).",
        parameters: {
          type: "object",
          properties: {
            packageName: { type: "string", description: "Имя пакета, например express или react@18.3.1" },
            dev: { type: "boolean", description: "Установить как devDependency (по умолчанию false)" },
          },
          required: ["packageName"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "lintProject",
        description: "Запустить проверку кода проекта (TypeScript tsc --noEmit, если есть tsconfig.json; ESLint, если есть конфиг) и вернуть список ошибок с файлами и строками. Удобнее, чем вручную угадывать команду через runCommand.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "runTests",
        description: "Запустить тесты проекта: выполняет script «test» из package.json (или bun test / npm test по умолчанию) и возвращает вывод с итогом: сколько прошло, сколько упало, какие тесты упали. Для живого прогресса длинных тестов можно запустить через startBackground + backgroundOutput.",
        parameters: {
          type: "object",
          properties: { timeoutMs: { type: "integer", description: "Максимум ожидания в мс (по умолчанию 180000)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "diffView",
        description: "Показать визуальное сравнение двух файлов или двух папок (как в GitHub): возвращает unified-дифф и открывает его в просмотрщике приложения. path1, path2 — пути (относительные — от рабочей директории) или абсолютные.",
        parameters: {
          type: "object",
          properties: {
            path1: { type: "string", description: "Первый файл/папка" },
            path2: { type: "string", description: "Второй файл/папка" },
          },
          required: ["path1", "path2"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "previewUI",
        description: "Открыть веб-интерфейс (собранный сайт, dev-сервер) прямо внутри приложения в нижней панели предпросмотра — не переключаясь во внешний браузер. url — адрес (например http://localhost:3000). В панели пользователь может переключить размер экрана (десктоп/планшет/телефон) и открыть страницу в новой вкладке браузера. Десктопная функция.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL для открытия во встроенном предпросмотре" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "screenshotCapture",
        description: "Сделать скриншот страницы по URL (невидимое окно, ждёт загрузки и отрисовки), показать пользователю во встроенном просмотрщике и сохранить PNG на диск — в ответе вернётся путь к файлу. Чтобы понять, что на экране, сразу вызови analyzeImage(path: <этот путь>) — вспомогательная vision-модель вернёт текстовое описание UI. Незаменимо для проверки вёрстки. url — полный адрес страницы.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL страницы для скриншота" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "envSet",
        description: "Задать переменную окружения для команд агента (runCommand, startBackground, shell, git, docker). Значение сохраняется и автоматически подмешивается в окружение всех последующих команд — не нужно править .env вручную. Например envSet(\"DATABASE_URL\", \"postgres://...\"). Значения не показываются обратно (envList скрывает их). Необязательный scopes ограничивает выдачу: перечисли группы (terminal, git, cloud, browser, files…) или точные capability (git.push) — переменную получат только они; [\"*\"] — всем. Без scopes переменная доступна всем командам агента, как раньше.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Имя переменной, например DATABASE_URL" },
            value: { type: "string", description: "Значение переменной" },
            scopes: {
              type: "array",
              items: { type: "string" },
              description: "Кому подставлять значение: группы (terminal, git, cloud, browser, files…) или точные capability (git.push); [\"*\"] — всем. Не задано — всем командам агента.",
            },
          },
          required: ["key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "envList",
        description: "Показать список заданных переменных окружения агента (только имена и статус — значения скрыты).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "envUnset",
        description: "Удалить переменную окружения агента по имени. key — имя переменной.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Имя переменной для удаления" } },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFileStructure",
        description: "Показать структуру файла без чтения целиком: импорты/require, экспорты и объявления верхнего уровня с номерами строк. Для больших файлов и быстрого понимания, что откуда берётся. path — путь к файлу, pattern — опциональная регулярка для фильтрации строк.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            pattern: { type: "string", description: "Опциональный фильтр-регулярка (например auth)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",      function: {
        name: "explainCode",
        description: "Показать участок кода с контекстом для объяснения: номера строк, импорты файла, границы enclosing-функции/класса, что определено в окне. Вызывай, когда пользователь просит объяснить код: по результату объясняешь своими словами, не читая файл целиком. path — файл; line — с какой строки начать (без endLine окно само расширится до границ содержащего блока); endLine — явный конец диапазона; symbol — вместо строк найти определение (функцию/класс/метод) по имени и показать его целиком.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            symbol: { type: "string", description: "Имя определения — показать его блок целиком (альтернатива line)" },
            line: { type: "number", description: "Номер строки начала окна (без endLine — расширится до границ блока)" },
            endLine: { type: "number", description: "Конец диапазона строк (необязательно)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
          name: "undoEdit",
          description: "Откатить изменения агента в файле: вернуть содержимое до последней правки (файл, созданный агентом, — удалить). path — путь к файлу (без него — список файлов с числом шагов истории). steps — сколько последних правок откатить за раз (по умолчанию 1, максимум 5).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Путь к файлу для отката (можно не указывать — вернётся список)" },
              steps: { type: "number", description: "Сколько последних правок откатить (1–5, по умолчанию 1)" },
            },
          },
        },
      },
    {
      type: "function",
      function: {
          name: "refactorRename",
          description: "Переименовать идентификатор (функцию, переменную, класс) во всём проекте или в одном файле. Замена по границам слова, node_modules/.git/dist не трогаются. oldName — старое имя, newName — новое, path — ограничить одним файлом/папкой, dryRun — показать, что изменится, без записи (рекомендуется сначала dryRun).",
          parameters: {
            type: "object",
            properties: {
              oldName: { type: "string", description: "Старое имя (например myFunc)" },
              newName: { type: "string", description: "Новое имя (например myFunction)" },
              path: { type: "string", description: "Ограничить одним файлом или папкой (по умолчанию — весь проект)" },
              dryRun: { type: "boolean", description: "true — только показать изменения, не записывать" },
            },
            required: ["oldName", "newName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "runCommandOutput",
          description: "Выполнить команду и дождаться её результата с двумя опциями: retries — перезапускать команду, если она упала с ошибкой (до N раз, пауза 2 с); waitFor — ждать, пока в выводе не появится указанный текст (например listening on port 5000), с таймаутом timeoutMs. Команды, похожие на dev-сервер (expo start, npm run dev, vite и т.п.), автоматически запускаются в фоне: инструмент сразу вернёт id фонового процесса (не блокируется и не убивает сервер), а waitFor будет ждать маркер готовности. Управление сервером — через startBackground-инструменты: checkUrl/checkPort (готовность), backgroundOutput(id) (логи), stopBackground(id) (остановка, освобождает порт).",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда для выполнения" },
              waitFor: { type: "string", description: "Текст, появления которого ждём в выводе (например listening)" },
              retries: { type: "number", description: "Сколько раз перезапускать при ошибке (по умолчанию 0)" },
              timeoutMs: { type: "number", description: "Таймаут одной попытки в мс (по умолчанию 120000)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "installSystemPackage",
          description: "Установить СИСТЕМНУЮ программу (git, node, python, ffmpeg и т.п.), а не npm-пакет: на Windows — winget, macOS — brew, Linux — apt/dnf/apk. packageName — короткое имя (git, node, python, ffmpeg) или точный winget-ID вида Vendor.Name (например Git.Git). После установки вызови refreshEnv() (обновит PATH) и checkInstalledProgram() (проверит). Если нужен администратор или установка прервалась — используй runCommandAsAdmin.",
          parameters: {
            type: "object",
            properties: {
              packageName: { type: "string", description: "Имя программы (git) или winget-ID (Git.Git)" },
            },
            required: ["packageName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "checkInstalledProgram",
          description: "Проверить, установлена ли программа: вернёт установлено/нет, путь к исполняемому файлу и версию (через --version). Ищет в PATH и типовых местах (Program Files и т.п.). Не гадай, установлен ли git/python — сначала проверь этим инструментом.",
          parameters: {
            type: "object",
            properties: {
              programName: { type: "string", description: "Имя программы (например git)" },
            },
            required: ["programName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "canExecute",
          description: "Быстро проверить, можно ли выполнить команду/программу (есть ли она в PATH). command — команда целиком или имя программы. Для встроенных команд оболочки (cd, echo) тоже скажет «да».",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда или имя программы для проверки (например git status или git)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "refreshEnv",
          description: "Обновить переменную PATH текущей сессии приложения из системного окружения. Вызывай ПОСЛЕ установки программы (installSystemPackage / runCommandAsAdmin), чтобы git/node и т.п. стали видны без перезапуска. Не перезапускает уже открытые терминалы.",
          parameters: { type: "object", properties: {} },
        },
      },
    {
      type: "function",
      function: {
          name: "getSystemInfo",
          description: "Показать информацию о системе: ОС и архитектура, версия Node.js приложения, домашний каталог, рабочая директория, сколько записей в PATH, установлены ли git/node/npm/python/docker. Полезно в начале работы и при диагностике «почему не работает».",
          parameters: { type: "object", properties: {} },
        },
      },
    {
      type: "function",
      function: {
          name: "explainError",
          description: "Объяснить код завершения команды человеческим языком: что он значит (127 — команда не найдена, 126 — нет прав, 740/5 — нужен администратор, 130 — Ctrl+C и т.д.) и что делать дальше. exitCode — код из вывода команды, command — необязательная команда для контекста.",
          parameters: {
            type: "object",
            properties: {
              exitCode: { type: "number", description: "Код завершения (например 127)" },
              command: { type: "string", description: "Команда, которая вернула этот код (необязательно)" },
            },
            required: ["exitCode"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "retryCommand",
          description: "Выполнить команду и перезапускать её до maxRetries раз (с паузой pauseMs), пока она не завершится успешно. Возвращает номер удачной попытки или вывод последней с объяснением explainError. Полезно для нестабильных сборок, сети, конкурентных процессов.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда" },
              maxRetries: { type: "number", description: "Сколько повторов при ошибке (по умолчанию 2, максимум 5)" },
              pauseMs: { type: "number", description: "Пауза между попытками в мс (по умолчанию 2000)" },
              timeoutMs: { type: "number", description: "Таймаут одной попытки в мс (по умолчанию 60000)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "timeoutCommand",
          description: "Выполнить команду с жёстким лимитом времени timeoutMs: если не уложилась — принудительно остановить и вернуть частичный вывод. Полезно против зависших команд и бесконечных ожиданий ввода.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда" },
              timeoutMs: { type: "number", description: "Лимит в мс (по умолчанию 15000, минимум 1000)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "runCommandAsAdmin",
          description: "Выполнить команду с правами администратора: появится системный запрос (UAC на Windows, пароль на macOS/Linux) — пользователь его подтверждает вручную. Нужно для установки программ, когда обычных прав не хватает. Вывод отдельного администрируемого окна не перехватывается; после установки — refreshEnv() и checkInstalledProgram().",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда для запуска с правами администратора" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "downloadAndExtract",
          description: "Скачать архив (.zip / .tar.gz / .tgz) по URL и распаковать в папку (path — по умолчанию downloads в рабочей директории). Позволяет получить репозиторий с GitHub (https://github.com/owner/repo/archive/refs/heads/main.zip) даже если git не установлен. Поддерживает большие архивы (до 300 МБ).",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Прямой URL архива" },
              path: { type: "string", description: "Куда распаковать (по умолчанию <рабочая папка>/downloads)" },
            },
            required: ["url"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "apiRequest",
          description: "Отправить HTTP-запрос: method (GET/POST/PUT/PATCH/DELETE...), url, body (строка или объект), headers (объект). Возвращает статус, заголовки и тело ответа (обрезанное). Заменитель curl/Insomnia для проверки API.",
          parameters: {
            type: "object",
            properties: {
              method: { type: "string", description: "HTTP-метод (по умолчанию GET)" },
              url: { type: "string", description: "Полный URL (например https://api.example.com/v1/items)" },
              body: { type: "string", description: "Тело запроса — строка или JSON-объект" },
              headers: { type: "object", description: "Заголовки (например Authorization: Bearer ...)" },
            },
            required: ["url"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "runScript",
          description: "Запустить скрипт из package.json по имени (например dev, build, start) менеджером проекта. scriptName — имя скрипта, args — опциональные аргументы строкой.",
          parameters: {
            type: "object",
            properties: {
              scriptName: { type: "string", description: "Имя скрипта из package.json (например dev)" },
              args: { type: "string", description: "Дополнительные аргументы (например --port 3000)" },
            },
            required: ["scriptName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "validateProject",
          description: "Проверить проект одним вызовом: TypeScript (tsc --noEmit, если есть tsconfig), ESLint (если есть конфиг) и тесты (если есть test-скрипт). Возвращает сводный отчёт по каждому этапу.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitBranch",
          description: "Показать текущую ветку и список всех веток (локальных и удалённых) репозитория рабочей директории.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitDiff",
          description: "Сравнить две ветки (branch1, branch2) или ветку с рабочим деревом (если указана одна). Возвращает список изменённых файлов и статистику; для полного диффа файла используй diffView.",
          parameters: {
            type: "object",
            properties: {
              branch1: { type: "string", description: "Первая ветка (например main); можно не указывать — возьмётся текущая" },
              branch2: { type: "string", description: "Вторая ветка (например feature/x)" },
            },
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitUndoLastCommit",
          description: "Отменить последний коммит БЕЗ потери изменений — git reset --soft HEAD~1: коммит исчезает, а его изменения остаются в рабочем дереве (можно поправить и закоммитить заново). Используй только если уверен, что это нужно.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitCheckout",
          description: "Переключиться на другую ветку git в рабочем репозитории. branch — имя ветки. create: true — создать новую ветку и переключиться на неё (git checkout -b).",
          parameters: {
            type: "object",
            properties: {
              branch: { type: "string", description: "Имя ветки (например feature/auth)" },
              create: { type: "boolean", description: "true — создать ветку, если её ещё нет" },
            },
            required: ["branch"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "findReferences",
          description: "Найти все использования символа (функции/переменной/класса) по границам слова — как «Найти все ссылки» в IDE, без ложных совпадений внутри других слов. symbol — имя; path — ограничить одним файлом или папкой (без path — весь проект). Каждое вхождение классифицируется: определение / импорт / вызов / ссылка.",
          parameters: {
            type: "object",
            properties: {
              symbol: { type: "string", description: "Имя символа, например createLead" },
              path: { type: "string", description: "Файл или папка для ограничения поиска (по умолчанию — весь проект)" },
            },
            required: ["symbol"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "getDependencies",
          description: "Показать зависимости проекта: dependencies и devDependencies из package.json с установленными версиями. audit: true — дополнительно проверить уязвимости (npm audit, может занять время).",
          parameters: {
            type: "object",
            properties: { audit: { type: "boolean", description: "Запустить npm audit для проверки уязвимостей" } },
          },
        },
      },
    {
      type: "function",
      function: {
          name: "formatCode",
          description: "Отформатировать файл через Prettier (если он установлен в проекте). path — файл или папка; check: true — только проверить форматирование без записи. Если Prettier не установлен — вернёт инструкцию.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Файл или папка для форматирования" },
              check: { type: "boolean", description: "true — только проверить, без записи" },
            },
            required: ["path"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "dbQuery",
          description: "Выполнить SQL-запрос к базе через системный клиент: postgres://... — psql, mysql://... — mysql. Требует установленный CLI-клиент. connectionString — строка подключения, sql — запрос. Возвращает вывод клиента.",
          parameters: {
            type: "object",
            properties: {
              connectionString: { type: "string", description: "Строка подключения (postgres://user:pass@host/db или mysql://...)" },
              sql: { type: "string", description: "SQL-запрос (SELECT/INSERT/UPDATE и т.п.)" },
            },
            required: ["connectionString", "sql"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "askUser",
        description: "Задать вопрос пользователю и дождаться ответа. Используй, когда нужно уточнить намерение перед необратимым действием, выбрать вариант или получить разрешение. question — текст вопроса. Пользователь увидит вопрос и введёт ответ текстом.",
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "Текст вопроса пользователю" } },
          required: ["question"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "analyzeImage",
        description: "Проанализировать изображение вспомогательной vision-моделью (второй ключ): вернуть подробное текстовое описание — объекты, текст, UI, цвета, расположение. Используй, когда нужно понять скриншот/картинку/макет, а твоя модель не видит изображения, или для детального разбора. path — путь к файлу изображения; question — (необязательно) что именно нужно описать.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу изображения (.png/.jpg/.jpeg/.webp/.gif/.bmp/.ico)" },
            question: { type: "string", description: "Что именно описать (по умолчанию — полное описание картинки)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generateImage",
        description: "Сгенерировать изображение по текстовому описанию (вспомогательная модель, второй ключ). Файл сохраняется в рабочую директорию проекта, пользователю показывается превью, возвращается путь — встраивай его в проект (например <img src=\"...\">). prompt — детальное описание картинки; filename — (необязательно) имя файла (по умолчанию generated-<время>.png, расширение добавится само); aspect_ratio — (необязательно) пропорции, например 16:9, 1:1, 9:16, 4:3.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Подробное описание изображения на английском (модели генерации лучше понимают английские промпты)" },
            filename: { type: "string", description: "Имя файла, например hero.png (по умолчанию generated-<время>.png)" },
            aspect_ratio: { type: "string", description: "Пропорции: 1:1, 16:9, 9:16, 4:3, 3:4 и т.п." },
          },
          required: ["prompt"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listProcesses",
        description: "Список запущенных процессов ОС (Windows: tasklist; macOS/Linux: ps). filter — необязательная подстрока имени или пути для фильтрации (например node, expo, chrome). Нужен, чтобы найти PID зависшего процесса перед killProcess.",
        parameters: {
          type: "object",
          properties: { filter: { type: "string", description: "Необязательно: подстрока имени/пути процесса" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "killProcess",
        description: "Завершить процесс по PID или имени (например зависший node.exe, expo, браузер). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ пользователя. pid — числовой ID из listProcesses; name — имя процесса (на Windows без расширения, например node); force — принудительное завершение (Windows: /F). На Windows завершается всё дерево процесса.",
        parameters: {
          type: "object",
          properties: { pid: { type: "integer", description: "PID процесса (из listProcesses)" }, name: { type: "string", description: "Имя процесса вместо PID, например node" }, force: { type: "boolean", description: "Принудительно (по умолчанию false)" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clipboardWrite",
        description: "Скопировать текст в системный буфер обмена (пользователь сможет вставить его куда угодно). text — что копировать.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "Текст для копирования" } },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clipboardRead",
        description: "Прочитать текущий текст из системного буфера обмена (то, что скопировал пользователь). Полезно, когда пользователь просит «прочитай, что я скопировал» или даёт команду из буфера.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "screenshotDesktop",
        description: "Скриншот ЭКРАНА или окна Windows (не страницы — для страниц есть screenshotCapture). window — необязательная подстрока заголовка окна (например «Блокнот», «chrome»); без неё снимается весь экран. Скриншот показывается пользователю и сохраняется PNG на диск — в ответе вернётся путь. Чтобы понять, что на экране, сразу вызови analyzeImage(path: <этот путь>) — вспомогательная vision-модель вернёт описание.",
        parameters: {
          type: "object",
          properties: { window: { type: "string", description: "Необязательно: подстрока заголовка окна" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "registryRead",
        description: "Прочитать значение из реестра Windows (только на Windows). path — раздел вида HKCU\Software\MyApp или HKLM\Software\...; name — имя значения (без name — значение по умолчанию). Чтение разрешено только из разделов SOFTWARE, ENVIRONMENT, SYSTEM, SECURITY.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь в реестре, например HKCU\Software\MyApp" }, name: { type: "string", description: "Имя значения (необязательно)" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "registryWrite",
        description: "Записать значение в реестр Windows (только на Windows, ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ). path — раздел ТОЛЬКО под HKCU\Software или HKCU\Environment; name — имя значения; value — значение; type — REG_SZ (строка), REG_DWORD (число) или REG_EXPAND_SZ. Для HKLM нужен администратор (runCommandAsAdmin).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь под HKCU\Software или HKCU\Environment" }, name: { type: "string", description: "Имя значения" }, value: { type: "string", description: "Значение" }, type: { type: "string", description: "REG_SZ | REG_DWORD | REG_EXPAND_SZ (по умолчанию REG_SZ)" } },
          required: ["path","name","value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "openPath",
        description: "Открыть файл или папку системным приложением (PDF в просмотрщике, картинку, документ, папку в проводнике/файловом менеджере). path — путь к файлу/папке (относительный — от рабочей директории).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к файлу или папке" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wingetSearch",
        description: "Поиск программы в каталоге winget (только на Windows) по имени — вернёт список с точными ID вида Vendor.Name. Затем установка: installSystemPackage('Vendor.Name').",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Поисковый запрос, например python, ffmpeg, ollama" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "installExe",
        description: "Скачать установщик по прямой ссылке и запустить его (ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ). Поддерживаются .exe (запуск), .msi (через msiexec) и .zip (распаковка + поиск установщика внутри). url — прямая ссылка; name — имя программы (для проверки после установки); silentArgs — аргументы тихой установки (для .exe по умолчанию /S, для .msi — /passive /norestart); run: true — сразу запустить найденный в архиве установщик. Файл проверяется ДО запуска: в ответе видны размер, SHA-256 и подпись издателя (недействительная подпись останавливает установку, пока не передан allowUnsigned: true), а заданный sha256 не даёт запустить подменённый при загрузке файл. Если установка требует прав администратора — приложение подскажет runCommandAsAdmin.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Прямая ссылка на установщик .exe (https://...)" }, name: { type: "string", description: "Имя программы (необязательно)" }, silentArgs: { type: "string", description: "Аргументы тихой установки (по умолчанию /S)" }, sha256: { type: "string", description: "Ожидаемый хэш SHA-256 установщика: при несовпадении запуск не состоится" }, allowUnsigned: { type: "boolean", description: "Разрешить запуск файла без действительной подписи издателя (по умолчанию запрещено)" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "noteSave",
        description: "Сохранить заметку проекта под ключом key (латиница/цифры/точка/дефис/подчёркивание, до 64 символов). Кириллицу в ключе писать можно: «Клиенты ВК» превратится в klienty-vk, и в ответе будет видно, под каким ключом легла заметка (тот же перевод работает и в noteRead/noteDelete). Заметки переживают перезапуск и видны в следующих сессиях — это твоя долговременная память о проекте: архитектура, решения, договорённости, что уже сделано. Перезаписывает заметку с тем же key. Содержимое — до 6000 символов.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Короткое имя заметки, например architecture, todos, decisions, api-notes" },
            content: { type: "string", description: "Текст заметки (до 6000 символов)" },
          },
          required: ["key", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "noteRead",
        description: "Прочитать заметки проекта. Без key — все заметки (свежие первыми); с key — одну заметку. Используй в начале работы и при сомнении о договорённостях или состоянии проекта.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Имя заметки (необязательно; без него — все)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "noteList",
        description: "Показать только ключи всех заметок проекта (без содержимого).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "noteDelete",
        description: "Удалить заметку проекта по ключу.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Имя заметки для удаления" } },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "todoWrite",
        description:
          "План работ для многошаговой задачи: показывается пользователю отдельной панелью-чеклистом с прогрессом и виден между перезапусками. " +
          "Вызывай В НАЧАЛЕ многошаговой задачи (от 3 шагов) и повторно — после каждого выполненного шага, присылая ПОЛНЫЙ список с обновлёнными статусами. " +
          "tasks: массив пунктов (до 7). Каждый пункт — либо строка с текстом, либо объект { text, status, note }, где status: pending (ожидает), in_progress (в работе), done (готово), failed (не удалось), note — короткая пометка (например, причина ошибки). " +
          "Ровно один пункт может быть in_progress — тот, который делаешь сейчас. Не пересказывай план в тексте ответа: он и так виден пользователю.",
        parameters: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              description: "Полный список пунктов плана (до 7). Строка или объект { text, status, note }.",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", description: "Короткий пункт плана" },
                  status: { type: "string", description: "pending | in_progress | done | failed" },
                  note: { type: "string", description: "Короткая пометка к пункту (необязательно)" },
                },
                required: ["text"],
              },
            },
            title: { type: "string", description: "Название плана (необязательно), например «Починка ycLogs»" },
          },
          required: ["tasks"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "taskAdd",
        description: "Добавить дело в личный список задач со сроком (таск-менеджер приложения). Срок разбирается по-человечески: «завтра 14:00», «сегодня вечером», «в пятницу», «через 2 недели», «15.09», «10 октября», «через 2 часа». Дата без времени = весь день (09:00). Указывай срок, если он звучит в словах пользователя; срока нет — спроси, не выдумывай. Повтор («каждый день», «по будням», «каждую пятницу», «каждый месяц», «каждые 2 часа») ставится параметром repeat. Если дело должен выполнить САМ агент по сроку — добавь auto: true и prompt (что сделать).",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Что нужно сделать (коротко, по делу)" },
            due: { type: "string", description: "Срок: «завтра 14:00», «в пятницу», «через 2 недели», «15.09» (можно пусто)" },
            priority: { type: "string", enum: ["low", "normal", "high"], description: "Приоритет (по умолчанию normal)" },
            project: { type: "string", description: "Проект или сфера дела: работа, личное, клиент X" },
            note: { type: "string", description: "Детали дела (до 2000 символов)" },
            repeat: { type: "string", description: "Повтор: «каждый день», «по будням», «каждую пятницу», «каждый месяц», «каждые 2 часа», пусто — без повтора" },
            auto: { type: "boolean", description: "true — приложение само запустит агента в срок (в чате «Автозадачи») и положит ответ туда" },
            prompt: { type: "string", description: "Задание для автозапуска: что именно сделать в срок (нужно при auto: true)" },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "taskList",
        description: "Показать дела со сроками: активные (по умолчанию), выполненные или все. Просроченные и ближайшие — первыми, плюс сводка по срокам (просрочено / сегодня / завтра / неделя / без срока). Начинай с этого вызова любую работу про планы, сроки и отчёты.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "done", "all"], description: "Какие дела показать (по умолчанию active)" },
            due: { type: "string", enum: ["overdue", "today", "tomorrow", "week", "none"], description: "Фильтр по сроку (необязательно)" },
            project: { type: "string", description: "Только дела этого проекта (необязательно)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "taskUpdate",
        description: "Изменить дело: срок, название, приоритет, проект, заметку или статус (todo/doing/done/canceled). Дело ищется по id (t7) или по куску названия — уточняй id, если под название подходит несколько дел.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "id дела (t7) или часть названия" },
            title: { type: "string", description: "Новое название" },
            due: { type: "string", description: "Новый срок (пустая строка — без срока)" },
            priority: { type: "string", enum: ["low", "normal", "high"] },
            status: { type: "string", enum: ["todo", "doing", "done", "canceled"] },
            project: { type: "string" },
            note: { type: "string" },
            repeat: { type: "string", description: "Повтор: «каждый день», «по будням», «каждую пятницу», «каждый месяц», «каждые 2 часа», «без повтора»" },
            auto: { type: "boolean", description: "true — агент выполнит дело сам по сроку" },
            prompt: { type: "string", description: "Задание для автозапуска: что именно сделать" },
            snooze: { type: "string", description: "Отсрочить напоминание: «через час», «завтра 9:00» (срок при этом не меняется)" },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "taskDone",
        description: "Отметить дело выполненным. done: false снимает отметку (дело снова активное). Отмечай только по словам пользователя: сделанным дело считает он, а не ты.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "id дела (t7) или часть названия" },
            done: { type: "boolean", description: "false — снять отметку «выполнено»" },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "taskDelete",
        description: "Удалить дело совсем. Используй, когда человек отменил задачу или просит убрать её из списка (вместо этого можно отметить status: canceled).",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "id дела или часть названия" } },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "missionStart",
        description:
          "Начать ДОЛГУЮ работу миссией: приложение заведёт папку .agent/missions/<id>/ в рабочей папке (цель, план, журнал шагов, отчёт), будет сама продолжать прогон батчами и сохранит состояние, даже если приложение перезапустят. Вызывай, когда работа требует много шагов: разобрать десятки писем, навести порядок в куче файлов, обработать документы, собрать большой отчёт. Для короткой задачи миссия НЕ нужна — обычная работа идёт как раньше.",
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "Что нужно сделать — полностью, словами пользователя (это цель миссии)" },
            title: { type: "string", description: "Короткое название миссии (для папки и панели)" },
            steps: { type: "array", items: { type: "string" }, description: "План работ: 3–10 шагов по порядку" },
            minutes: { type: "number", description: "Сколько минут разрешено работать над миссией (по умолчанию из настроек, 480 = 8 часов)" },
          },
          required: ["goal"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "missionStep",
        description:
          "Отметить шаг миссии: done — что сделано, fail — что не получилось, next — что делаешь дальше, note — что попутно замечено. Всё пишется в журнал .agent/missions/<id>/journal.md, поэтому отмечай КАЖДЫЙ законченный шаг: по журналу человек видит, чем ты занят. Работает и без missionStart — если миссия есть, шаг попадёт в неё.",
        parameters: {
          type: "object",
          properties: {
            done: { type: "string", description: "Что выполнено (коротко, по-русски)" },
            fail: { type: "string", description: "Что не получилось (вместо done)" },
            next: { type: "string", description: "Следующий шаг — что делаешь сейчас" },
            note: { type: "string", description: "Деталь: сколько нашёл, что решил, что мешает" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "missionStatus",
        description:
          "Показать миссию: цель, план с отметками, прогресс, метрики и хвост журнала. Вызывай в начале работы (чтобы продолжить с места остановки) и когда нужно понять, что уже сделано.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "id миссии (без него — текущая незакрытая)" },
            journal: { type: "number", description: "Сколько строк журнала показать (по умолчанию 20)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "missionFinish",
        description:
          "Закрыть миссию, когда работа действительно закончена: report — короткий итог для человека (попадёт в report.md и в чат), status — done | failed | stopped. Если миссию не закрыть, приложение будет считать работу незавершённой и предлагать продолжить.",
        parameters: {
          type: "object",
          properties: {
            report: { type: "string", description: "Итог: что сделано, что осталось, как проверить" },
            status: { type: "string", enum: ["done", "failed", "stopped"], description: "Состояние миссии (по умолчанию done)" },
            next: { type: "string", description: "Что осталось на потом (необязательно)" },
          },
          required: ["report"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memoryList",
        description:
          "Дневник сжатых памяток контекста (память диалогов). Без date — список дней с количеством памяток; с date (ГГГГ-ММ-ДД) — памятки за этот день: время, провайдер/модель, рабочая папка и текст. Это то, что агент сворачивал в памятку, когда контекст переполнялся, — помогает вспомнить, что делали в прошлые сессии. Работает, только если в настройках включена галочка «Память диалогов» (по умолчанию выключена).",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Дата ГГГГ-ММ-ДД (необязательно; без неё — список дней)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memorySearch",
        description:
          "Поиск по дневнику сжатых памяток контекста (память диалогов): найти, о чём говорили и что делали раньше. Возвращает дату, время, число совпадений и фрагмент памятки. Можно ограничить одной датой (date) и задать limit. Используй, когда пользователь спрашивает «что мы делали 5-го числа» или «когда мы правили X».",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Что искать — слово или фраза" },
            date: { type: "string", description: "Ограничить датой ГГГГ-ММ-ДД (необязательно)" },
            limit: { type: "number", description: "Сколько совпадений вернуть (по умолчанию 20)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkpointSave",
        description: "Создать точку отката: полный снимок текстовых файлов рабочей директории (без .git, node_modules, dist, build и т.п.). Делай ПЕРЕД серией рискованных правок или рефакторингом — потом можно вернуть всё разом через checkpointRollback(id). Хранится до 15 чекпоинтов, старые вытесняются.",
        parameters: {
          type: "object",
          properties: { label: { type: "string", description: "Короткая подпись, например «до рефакторинга api» (необязательно)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkpointList",
        description: "Показать все точки отката: id, подпись, дата, число файлов.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "checkpointRollback",
        description: "Откатить рабочую директорию к точке отката: восстановить все файлы из снимка checkpointSave (перезаписывает текущее содержимое). Файлы, созданные после чекпоинта, не удаляются. Используй, когда серия правок сломала проект.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Идентификатор чекпоинта (из checkpointList)" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "applyPatch",
        description: "Применить unified diff (формат git diff) — правка нескольких файлов одним вызовом. patch — текст диффа с заголовками --- / +++ и хунками @@. Изменяет существующие файлы, создаёт новые (--- /dev/null), удаляет файлы (+++ /dev/null). basePath — папка, относительно которой идут пути (по умолчанию рабочая директория). Генерируй патч аккуратно: контекст должен точно совпадать с содержимым файлов (перечитай их через readFile). После применения запусти validateProject.",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "Unified diff (git diff): --- a/путь, +++ b/путь, хунки @@ -N,M +N,M @@" },
            basePath: { type: "string", description: "Базовая папка для путей из патча (по умолчанию — рабочая директория)" },
          },
          required: ["patch"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "waitUntil",
        description: "Подождать seconds секунд (1–300) и вернуться. Используй перед повторной проверкой состояния: сервер ещё стартует (checkPort/checkUrl), тест ещё работает, файл должен появиться. Сразу после — перепроверь то, ради чего ждал.",
        parameters: {
          type: "object",
          properties: {
            seconds: { type: "integer", description: "Сколько секунд ждать (1–300)" },
            reason: { type: "string", description: "Зачем ждём (показывается пользователю)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitStash",
        description: "Работа со stash git: action push — спрятать незакоммиченные изменения и очистить рабочее дерево (message — подпись); pop — вернуть последний stash; list — показать стек stash.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "push / pop / list (по умолчанию push)" },
            message: { type: "string", description: "Подпись stash (для action: push)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitCherryPick",
        description: "Перенести коммит из другой ветки/истории на текущую ветку (git cherry-pick). commit — хэш или ссылка (например abc123 или HEAD~2).",
        parameters: {
          type: "object",
          properties: { commit: { type: "string", description: "Хэш коммита или ссылка" } },
          required: ["commit"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitBlame",
        description: "Показать историю строк файла (git blame): кто и в каком коммите менял каждую строку. path — путь к файлу; lines — сколько первых строк показать (необязательно). Полезно, чтобы понять, когда и зачем появился код.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            lines: { type: "integer", description: "Сколько первых строк показать (необязательно)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "semanticSearch",
        description: "Семантический поиск по коду проекта: ищет по смыслу, а не по точному тексту (auth находит authenticate, распознаёт camelCase/snake_case), ранжирует файлы по релевантности и показывает сниппет с номерами строк. query — запрос своими словами (что нужно найти), maxResults — сколько файлов вернуть (по умолчанию 8), path — папка поиска (по умолчанию рабочая). Для точного регулярного поиска используй searchFile/searchProject.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Что ищем своими словами, например «валидация входа», «подключение к базе», «обработка ошибок API»" },
            maxResults: { type: "integer", description: "Сколько файлов вернуть (1–20, по умолчанию 8)" },
            path: { type: "string", description: "Папка поиска (по умолчанию рабочая директория)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "otaStatus",
        description: "Показать статус локального самообновления (OTA): включено ли, какая версия кода приложения установлена, какие папки-источники бандлов настроены. Вызывай после сборки бандла (node scripts/make-ota.js), чтобы убедиться, что приложение видит обновление.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "otaCheck",
        description: "Проверить и применить локальное OTA-обновление (бандл из папки обновлений). Если обновление найдено — приложение перезапустится с новым кодом. Во время работы агента вернётся busy (применение заблокировано): бандл применится автоматически в течение минуты после завершения задачи.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "otaRollback",
        description: "Откатить код приложения на предыдущую версию (если после обновления что-то сломалось). Приложение перезапустится. Нельзя вызывать во время работы агента.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "ycStatus",
        description: "Yandex Cloud: показать статус подключения (авторизован ли пользователь, какой каталог выбран), разрешения агента на создание/удаление ресурсов и счётчики ресурсов по всем сервисам каталога (API Gateway, Certificates, CDN, DNS, Logging, Postbox, Container Registry, IAM, Lockbox, YDB, Storage, Serverless Containers, VPC).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "ycList",
        description: "Yandex Cloud: список ресурсов. service — ключ сервиса (apiGateway, certificateManager, cdn, dns, logging, postbox, containerRegistry, iam, lockbox, ydb, storage, serverlessContainers, vpc); без service — сводка по всем. Возвращает имена и id ресурсов.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса (необязательно): apiGateway | certificateManager | cdn | dns | logging | postbox | containerRegistry | iam | lockbox | ydb | storage | serverlessContainers | vpc" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycCreate",
        description: "Yandex Cloud: создать ресурс в выбранном каталоге. service — ключ сервиса (создание доступно для: ydb, lockbox, containerRegistry, storage, dns, serverlessContainers, vpc), name — имя ресурса (латиница, цифры, дефис). Создание может быть платным (YDB, Storage, Containers) — только по явной просьбе пользователя и при включённом разрешении «Разрешить агенту создавать ресурсы». Сначала посмотри цену через ycCosts, назови её пользователю и получи согласие, затем вызови повторно с confirm: true — без него платный ресурс не создаётся.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса: ydb | lockbox | containerRegistry | storage | dns | serverlessContainers | vpc" },
            name: { type: "string", description: "Имя ресурса (2–63 символа, латиница/цифры/дефис)" },
            confirm: { type: "boolean", description: "true — пользователь согласился на платный ресурс (цену показал ycCosts)" },
          },
          required: ["service", "name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycCosts",
        description: "Yandex Cloud: ориентир стоимости ресурса ДО создания (тарифы из официальной документации, ₽ с НДС). service — ключ сервиса (без него — сводка по всем ресурсам и предупреждение о дорогих). Дополнительно можно передать параметры: gb (объём данных), versions, zones, queriesMln, memoryMb и cores (для ревизии контейнера). Это оценка, а не счёт: перед созданием платного ресурса назови цену пользователю.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса: ydb | lockbox | containerRegistry | storage | dns | serverlessContainers | vpc (пусто — сводка)" },
            gb: { type: "number", description: "Объём данных в ГБ (storage, containerRegistry)" },
            versions: { type: "number", description: "Число версий секретов (lockbox)" },
            zones: { type: "number", description: "Число DNS-зон (dns)" },
            queriesMln: { type: "number", description: "Миллионы DNS-запросов в месяц (dns)" },
            memoryMb: { type: "number", description: "Память ревизии контейнера в МБ" },
            cores: { type: "number", description: "Ядра ревизии контейнера (1 = 100% vCPU, 0.2 = 20%)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycDelete",
        description: "Yandex Cloud: удалить ресурс по id (id виден в ycList). service — ключ сервиса, id — идентификатор ресурса. Удаление необратимо и может удалить данные — только по явной просьбе пользователя и при включённом разрешении «Разрешить агенту удалять ресурсы».",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса" },
            id: { type: "string", description: "id ресурса (из ycList)" },
          },
          required: ["service", "id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycDeploy",
        description: "Yandex Cloud: задеплоить папку проекта в Serverless Containers (лёгкий хостинг). Собирает Docker-образ (или генерирует Dockerfile по типу проекта), загружает в Container Registry, создаёт/обновляет Serverless Container и при public=true настраивает публичный доступ. directory — папка проекта (по умолчанию рабочая директория), name — имя приложения, public — публичный URL (по умолчанию true). Требует Docker на ПК и разрешение «Разрешить агенту создавать ресурсы». Деплой платный — только по явной просьбе пользователя. Секреты передаются ССЫЛКОЙ: secretId — готовый секрет Lockbox, secretKeys — имена его ключей (это не секрет). Значения секретов агенту передавать НЕЛЬЗЯ: их человек вводит в панели деплоя, и они уходят в Lockbox, а не в чат.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Папка проекта (по умолчанию рабочая директория)" },
            name: { type: "string", description: "Имя приложения (станет именем контейнера и образа)" },
            public: { type: "boolean", description: "Публичный URL без авторизации (по умолчанию true)" },
            memoryMb: { type: "integer", description: "Память ревизии в МБ (по умолчанию 256)" },
            cores: { type: "integer", description: "Число ядер (по умолчанию 1)" },
            secretId: { type: "string", description: "id готового секрета Lockbox: значения подставит облако, в чат они не попадают" },
            secretKeys: { type: "array", items: { type: "string" }, description: "Имена ключей секрета (не значения) — станут переменными окружения ревизии" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycLogs",
        description: "Yandex Cloud: показать логи ресурса за последние 3 часа. Читаются внутренним API приложения (Cloud Logging: лог-группы по REST, записи по gRPC) — внешний yc CLI не нужен, ycInstall для логов не требуется. id — id ресурса (из ycList); service — ключ сервиса (необязателен, сужает фильтр по типу ресурса); sinceHours — окно в часах (по умолчанию 3), limit — сколько записей (по умолчанию 100).",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса (необязательно): serverlessContainers | apiGateway | ydb | storage | dns | iam | lockbox | cdn | certificateManager | containerRegistry | logging | vpc" },
            id: { type: "string", description: "id ресурса (из ycList)" },
            sinceHours: { type: "integer", description: "За сколько часов читать (1–168, по умолчанию 3)" },
            limit: { type: "integer", description: "Сколько записей вернуть (1–500, по умолчанию 100)" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycInstall",
        description: "Yandex Cloud: установить официальный yc CLI внутрь приложения (папка userData/bin, системных прав не требует) и добавить его в PATH всех команд агента. Нужен, только если в песочнице требуется сама команда yc (логи через ycLogs работают и без него). Токен и каталог подставляются автоматически (YC_IAM_TOKEN — свежий IAM-токен, YC_CLOUD_ID, YC_FOLDER_ID), поэтому yc init не нужен. Если yc ответит «The token is invalid» — повтори вызов через минуту: приложение продлевает IAM само. force=true — переустановить поверх имеющегося.",
        parameters: {
          type: "object",
          properties: {
            force: { type: "boolean", description: "Переустановить, даже если yc CLI уже встроен" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycContainer",
        description:
          "Yandex Cloud: работа с Serverless-контейнером «как в консоли» — обзор, редактор, ревизии. action: overview (статус, URL, число ревизий и полные настройки активной) | revisions (список ревизий с фильтром) | revision (детали одной ревизии) | deploy (создать ревизию: настройки берутся из активной ревизии, указанные поля их переопределяют) | rollback (откатить контейнер на выбранную ревизию) | update (имя, описание, метки контейнера). container — имя или id (список: ycList(service: \"serverlessContainers\")). deploy/rollback/update требуют разрешения «Разрешить агенту менять контейнеры» и явной просьбы пользователя: новая ревизия сразу получает трафик и тарифицируется. Образ, переменные окружения и ресурсы меняются ТОЛЬКО новой ревизией — контейнер правится через deploy.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "overview | revisions | revision | deploy | rollback | update" },
            container: { type: "string", description: "Имя или id контейнера" },
            revisionId: { type: "string", description: "Id ревизии (для action: revision и rollback; виден в action: revisions)" },
            image: { type: "string", description: "Образ для новой ревизии, например cr.yandex/<registry-id>/<image>:latest (по умолчанию — из активной ревизии)" },
            env: { type: "object", description: "Переменные окружения: добавляются к текущим (envReplace: true — заменить набор целиком)" },
            envReplace: { type: "boolean", description: "Заменить переменные окружения целиком, а не дополнить текущие" },
            command: { type: "array", items: { type: "string" }, description: "Переопределить ENTRYPOINT образа" },
            args: { type: "array", items: { type: "string" }, description: "Переопределить CMD образа" },
            memoryMb: { type: "integer", description: "Память ревизии в МБ, кратно 128 (128–8192)" },
            cores: { type: "integer", description: "Ядра ревизии (1–4)" },
            timeoutSec: { type: "integer", description: "Таймаут выполнения, секунды (1–600)" },
            concurrency: { type: "integer", description: "Одновременных запросов на инстанс" },
            serviceAccountId: { type: "string", description: "Сервисный аккаунт ревизии" },
            networkId: { type: "string", description: "Сеть VPC для ревизии (доступ к базам и внутренним сервисам)" },
            name: { type: "string", description: "Новое имя контейнера (action: update)" },
            description: { type: "string", description: "Описание контейнера или ревизии" },
            labels: { type: "object", description: "Метки контейнера key:value (action: update; заменяют весь набор)" },
          },
          required: ["action", "container"],
        },
      },
    },
  ];

  // ── Транспорт провайдеров ──────────────────────────────────────────────────
  // Конвертация сообщений, кэш промпта, сборка запроса, стрим ответа, список
  // моделей и окно модели живут в src/renderer/provider-transport.js. Ему нужны
  // ровно две вещи: подключение к провайдеру и таблица инструментов выше.
  const {
    partsText,
    buildChatRequest,
    consumeProviderStream,
    listModels,
    normalizeUsage,
    splitStaticSystem,
    anthropicSystem,
    modelWindow,
    ollamaModelInfo,
    ollamaNumCtx,
    probeLocalModel,
    toolsAsText,
    withTextTools,
  } = ProviderTransport({ config: ProviderConfig, toolDefinitions: TOOL_DEFINITIONS });

  // ── Контекст и компакция ───────────────────────────────────────────────────
  // Оценка токенов, бюджет, обрезка истории и сжатие старых витков в памятку живут
  // в src/renderer/context-window.js. Ему нужны подключение к провайдеру (запрос к
  // дешёвой модели за памяткой) и транспорт (разбор частей сообщения). Объявления
  // стоят здесь, а не по месту использования: ниже таблица групп немедленно считает
  // вес инструментов через estimateTokens.
  const {
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    windowBudget,
    sanitizeToolPairs,
    trimConversation,
    truncateText,
    compactRemote,
    createContextManager,
  } = ContextWindow({ config: ProviderConfig, transport: ProviderTransport });

  // ── Контекст-окно, бюджет и обрезка истории — в src/renderer/context-window.js ──
  // estimateTokens, contextBudget, trimConversation, compactRemote и
  // createContextManager получены в начале файла.

  // Веб: поиск и чтение страниц — в модуле src/renderer/web-tools.js.
  // Имена не изменились, поэтому main.js, preview-сервер и инструменты не менялись.
  const { downloadHtml, webSearchDDG, webSearch, htmlToText, webFetchPage } = WebTools;

  /* Стриппер думающих блоков <think>...</think> / <thought>...</thought>.
     Устойчив к стримингу: теги могут приходить по кусочкам.
     opts.onHidden(chunk) — если передан, получает текст рассуждений по мере
     стриминга (его можно показать пользователю, как в Replit/Claude). */
  function createThinkingStripper(opts) {
    const onHidden = opts && typeof opts.onHidden === "function" ? opts.onHidden : null;
    let visible = "";
    let hidden = "";
    let inBlock = false;
    const hold = 16; // хвост, в котором может прятаться незавершённый тег
    const openRe = /<think(ing)?>/i;
    const closeRe = /<\/think(ing)?>/i;
    function flushHidden() {
      if (!onHidden || !inBlock) return;
      if (hidden.length > hold) {
        const out = hidden.slice(0, hidden.length - hold);
        hidden = hidden.slice(hidden.length - hold);
        if (out) onHidden(out);
      }
    }
    return {
      push(text) {
        if (!text) return "";
        for (const ch of text) {
          if (!inBlock) {
            visible += ch;
            const m = visible.slice(-hold).match(openRe);
            if (m) {
              visible = visible.slice(0, visible.length - m[0].length);
              hidden = "";
              inBlock = true;
            }
          } else {
            hidden += ch;
            flushHidden();
            const close = hidden.slice(-hold).match(closeRe);
            if (close) {
              // Дофлашиваем рассуждения, не включая сам закрывающий тег
              const idx = hidden.lastIndexOf(close[0]);
              if (idx > 0 && onHidden) onHidden(hidden.slice(0, idx));
              hidden = "";
              inBlock = false;
            }
          }
        }
        let out = "";
        if (!inBlock && visible.length > hold) {
          out = visible.slice(0, visible.length - hold);
          visible = visible.slice(visible.length - hold);
        }
        return out;
      },
      finish() {
        if (inBlock) {
          // Поток оборвался внутри блока — отдаём накопленные рассуждения целиком
          if (onHidden && hidden) onHidden(hidden);
          inBlock = false;
          hidden = "";
          visible = "";
          return "";
        }
        const out = visible;
        visible = "";
        return out;
      },
    };
  }

  function stripThinking(text) {
    const s = createThinkingStripper();
    return s.push(text) + s.finish();
  }

  // ── План работ (todoWrite): нормализация пунктов ──────────────────────────
  // Принимает что угодно (строки, объекты, JSON-строку) и возвращает чистый
  // список: до 7 пунктов, допустимые статусы, уникальные id. Никогда не бросает.
  const PLAN_STATUSES = ["pending", "in_progress", "done", "failed"];
  const PLAN_MAX_ITEMS = 7;
  const PLAN_STATUS_ALIASES = {
    pending: "pending", todo: "pending", new: "pending", open: "pending", waiting: "pending",
    ожидает: "pending", ожидание: "pending", запланировано: "pending", план: "pending",
    in_progress: "in_progress", inprogress: "in_progress", progress: "in_progress", doing: "in_progress",
    active: "in_progress", current: "in_progress", running: "in_progress",
    в_работе: "in_progress", вработе: "in_progress", работа: "in_progress", выполняется: "in_progress",
    done: "done", complete: "done", completed: "done", ok: "done", success: "done", finished: "done",
    готово: "done", выполнено: "done", сделано: "done", завершено: "done",
    failed: "failed", fail: "failed", error: "failed", blocked: "failed",
    ошибка: "failed", не_удалось: "failed", неудалось: "failed", провал: "failed",
  };

  function normalizePlanStatus(v) {
    const k = String(v == null ? "" : v).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (PLAN_STATUS_ALIASES[k]) return PLAN_STATUS_ALIASES[k];
    return "pending";
  }

  function normalizePlanTasks(raw) {
    let list = raw;
    if (list && !Array.isArray(list) && typeof list === "object") {
      // Модель часто присылает { tasks: [...] } или { items: [...] } целиком.
      list = list.tasks || list.items || list.steps || list.plan || list.todos || null;
    }
    if (typeof list === "string") {
      const t = list.trim();
      try {
        const parsed = JSON.parse(t);
        list = Array.isArray(parsed) ? parsed : (parsed && (parsed.tasks || parsed.items || parsed.steps)) || null;
      } catch {
        // Свободный текст: каждая значимая строка — пункт (снимаем «- », «1. », «[ ]»).
        list = t.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const it of list) {
      let text = "";
      let status = "pending";
      let note = "";
      if (it && typeof it === "object") {
        text = String(it.text || it.title || it.task || it.name || it.step || "").trim();
        status = normalizePlanStatus(it.status || it.state || it.done);
        note = String(it.note || it.comment || it.detail || "").trim();
      } else {
        text = String(it == null ? "" : it).trim().replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
      }
      // Строка вида «- [x] шаг» / «☑ шаг» — статус прямо в тексте.
      const cb = text.match(/^\[([ xX\-\/])\]\s*/);
      if (cb) {
        text = text.slice(cb[0].length).trim();
        if (cb[1].toLowerCase() === "x") status = "done";
        else if (cb[1] === "/") status = "in_progress";
      }
      const mark = text.match(/^(✅|✔|☑|❌|⚠️|⚠|🔄|⏳|⬜)\s*/);
      if (mark) {
        text = text.slice(mark[0].length).trim();
        const ch = mark[1];
        if (ch === "✅" || ch === "✔" || ch === "☑") status = "done";
        else if (ch === "❌" || ch === "⚠️" || ch === "⚠") status = "failed";
        else if (ch === "🔄" || ch === "⏳") status = "in_progress";
      }
      // Обрезаем служебное: длинные пункты не нужны, они ломают слабые модели.
      if (text.length > 160) text = text.slice(0, 157).trim() + "…";
      if (note.length > 120) note = note.slice(0, 117).trim() + "…";
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: "t" + (out.length + 1), text, status, note });
      if (out.length >= PLAN_MAX_ITEMS) break;
    }
    // Ровно один шаг может быть «в работе»: если модель пометила несколько
    // (частая ошибка слабых моделей), оставляем первый, остальные понижаем.
    let seenActive = false;
    for (const it of out) {
      if (it.status !== "in_progress") continue;
      if (seenActive) it.status = "pending";
      else seenActive = true;
    }
    return out;
  }

  function planSummary(tasks) {
    const items = Array.isArray(tasks) ? tasks : [];
    const total = items.length;
    const done = items.filter((t) => t && t.status === "done").length;
    const failed = items.filter((t) => t && t.status === "failed").length;
    const active = items.find((t) => t && t.status === "in_progress");
    return { total, done, failed, active: active ? active.text : "" };
  }
  const TOOL_ALIASES = {
    createfile: "writeFile",
    create_file: "writeFile",
    write_file: "writeFile",
    read_file: "readFile",
    list_directory: "listDirectory",
    mkdir: "createFolder",
    makedirectory: "createFolder",
    make_dir: "createFolder",
    create_folder: "createFolder",
    git_clone: "gitClone",
    git_status: "gitStatus",
    git_commit: "gitCommit",
    git_push: "gitPush",
    git_pull: "gitPull",
    git_log: "gitLog",
    git_revert: "gitRevert",
    read_file_lines: "readFileLines",
    readfilelines: "readFileLines",
    edit_file: "editFile",
    editfile: "editFile",
    run_command: "runCommand",
    runcommand: "runCommand",
    shells_status: "shellsStatus",
    shellsstatus: "shellsStatus",
    shell_status: "shellsStatus",
    check_shells: "shellsStatus",
    shells: "shellsStatus",
    browser_open: "browserOpen",
    browser_snapshot: "browserSnapshot",
    browsersnapshot: "browserSnapshot",
    snapshot: "browserSnapshot",
    dom: "browserSnapshot",
    page_map: "browserSnapshot",
    browser_fill: "browserFill",
    browser_click: "browserClick",
    browser_select: "browserSelect",
    browser_press: "browserPress",
    browser_text: "browserText",
    browser_screenshot: "browserScreenshot",
    browser_eval: "browserEval",
    browsereval: "browserEval",
    eval_js: "browserEval",
    run_js: "browserEval",
    execute_js: "browserEval",
    browser_dom: "browserDOM",
    browserdom: "browserDOM",
    dom_html: "browserDOM",
    browser_overlays: "browserOverlays",
    browseroverlays: "browserOverlays",
    overlays: "browserOverlays",
    browser_act: "browserAct",
    browseract: "browserAct",
    act: "browserAct",
    steps: "browserAct",
    dialogs: "browserOverlays",
    dismiss_overlays: "browserOverlays",
    browser_wait: "browserWait",
    hover: "browserHover",
    scroll: "browserScroll",
    network: "browserNetwork",
    replay: "browserReplay",
    browser_replay: "browserReplay",
    replay_request: "browserReplay",
    virtual_list: "browserReplay",
    list_all: "browserReplay",
    read_all: "browserReplay",
    browser_scroll: "browserScroll",
    scroll_page: "browserScroll",
    scrollto: "browserScroll",
    scroll_to: "browserScroll",
    browser_hover: "browserHover",
    hover_element: "browserHover",
    browser_network: "browserNetwork",
    network_log: "browserNetwork",
    requests: "browserNetwork",
    wait_for_idle: "waitForIdle",
    waitidle: "waitForIdle",
    idle: "waitForIdle",
    agent_guide: "agentGuide",
    agentguide: "agentGuide",
    guide: "agentGuide",
    site_guide: "agentGuide",
    browser_close: "browserClose",
    browser_status: "browserStatus",
    memory_list: "memoryList",
    memorylist: "memoryList",
    memory_days: "memoryList",
    memory_search: "memorySearch",
    memorysearch: "memorySearch",
    context_memory: "memoryList",
    browser_clear_profile: "browserClearProfile",
    browserclearprofile: "browserClearProfile",
    browser_connect: "browserConnect",
    browserconnect: "browserConnect",
    cdp: "browserConnect",
    my_chrome: "browserConnect",
    mychrome: "browserConnect",
    vault_list: "vaultList",
    vaultlist: "vaultList",
    vault_fill: "vaultFill",
    vaultfill: "vaultFill",
    mail_send: "mailSend",
    mailsend: "mailSend",
    send_mail: "mailSend",
    send_email: "mailSend",
    email: "mailSend",
    mail_list: "mailList",
    maillist: "mailList",
    inbox: "mailList",
    list_mail: "mailList",
    mail_code: "mailCode",
    mailcode: "mailCode",
    confirmation_code: "mailCode",
    email_code: "mailCode",
    app_read: "appRead",
    app_click: "appClick",
    app_fill: "appFill",
    app_select: "appSelect",
    app_press: "appPress",
    app_wait: "appWait",
    app_screenshot: "appScreenshot",
    terminal: "runCommand",
    shell: "runCommand",
    execute: "runCommand",
    web_search: "webSearch",
    websearch: "webSearch",
    search: "webSearch",
    internet_search: "webSearch",
    web_fetch: "webFetch",
    webfetch: "webFetch",
    fetch_url: "webFetch",
    fetch: "webFetch",
    open_url: "webFetch",
    read_url: "webFetch",
    readweb: "webFetch",
    search_file: "searchFile",
    searchfile: "searchFile",
    grep: "searchFile",
    find_in_file: "searchFile",
    search_project: "searchProject",
    searchproject: "searchProject",
    file_outline: "fileOutline",
    fileoutline: "fileOutline",
    outline: "fileOutline",
    structure: "fileOutline",
    symbols: "fileOutline",
    toc: "fileOutline",
    file_map: "fileOutline",
    grep_project: "searchProject",
    find: "searchProject",
    rg: "searchProject",
    list_files: "listFiles",
    listfiles: "listFiles",
    tree: "listFiles",
    ls: "listFiles",
    project_tree: "listFiles",
    ask_user: "askUser",
    askuser: "askUser",
    question: "askUser",
    ask: "askUser",
    start_background: "startBackground",
    startbackground: "startBackground",
    bg: "startBackground",
    run_background: "startBackground",
    list_background: "listBackground",
    listbackground: "listBackground",
    background_output: "backgroundOutput",
    backgroundoutput: "backgroundOutput",
    process_output: "backgroundOutput",
    logs: "backgroundOutput",
    send_input: "sendInput",
    sendinput: "sendInput",
    sendkeys: "sendInput",
    simulate_input: "sendInput",
    stop_background: "stopBackground",
    stopbackground: "stopBackground",
    kill_process: "stopBackground",
    shell_start: "shellStart",
    shellstart: "shellStart",
    start_shell: "shellStart",
    shell_send: "shellSend",
    shellsend: "shellSend",
    shell_command: "shellSend",
    check_url: "checkUrl",
    checkurl: "checkUrl",
    ping_url: "checkUrl",
    openurl: "openUrl",
    open_url_browser: "openUrl",
    show_image: "showImage",
    showimage: "showImage",
    display_image: "showImage",
    check_port: "checkPort",
    checkport: "checkPort",
    list_ports: "listPorts",
    listports: "listPorts",
    netstat: "listPorts",
    docker_build: "dockerBuild",
    dockerbuild: "dockerBuild",
    docker_run: "dockerRun",
    dockerrun: "dockerRun",
    docker_exec: "dockerExec",
    dockerexec: "dockerExec",
    install_package: "installPackage",
    installpackage: "installPackage",
    npm_install: "installPackage",
    yarn_add: "installPackage",
    pnpm_add: "installPackage",
    lint_project: "lintProject",
    lintproject: "lintProject",
    lint: "lintProject",
    tsc_check: "lintProject",
    eslint: "lintProject",
    run_tests: "runTests",
    runtests: "runTests",
    test: "runTests",
    runtest: "runTests",
    diff_view: "diffView",
    diffview: "diffView",
    compare: "diffView",
    preview_ui: "previewUI",
    previewui: "previewUI",
    preview: "previewUI",
    open_preview: "previewUI",
    screenshot_capture: "screenshotCapture",
    screenshotcapture: "screenshotCapture",
    screenshot: "screenshotCapture",
    capture: "screenshotCapture",
    env_set: "envSet",
    envset: "envSet",
    set_env: "envSet",
    export_env: "envSet",
    env_list: "envList",
    envlist: "envList",
    list_env: "envList",
    env_unset: "envUnset",
    envunset: "envUnset",
    unset_env: "envUnset",
    read_file_structure: "readFileStructure",
    readfilestructure: "readFileStructure",
    file_structure: "readFileStructure",
    imports_exports: "readFileStructure",
    explain_code: "explainCode",
    explaincode: "explainCode",
    explain: "explainCode",
    explain_file: "explainCode",
    edit_file_nth: "editFile",
    editfilenth: "editFile",
    get_functions: "fileOutline",
    getfunctions: "fileOutline",
    functions: "fileOutline",
    exports: "fileOutline",
    undo_edit: "undoEdit",
    undoedit: "undoEdit",
    undo: "undoEdit",
    rollback: "undoEdit",
    refactor_rename: "refactorRename",
    refactorrename: "refactorRename",
    rename_symbol: "refactorRename",
    rename_function: "refactorRename",
    rename: "refactorRename",
    run_command_output: "runCommandOutput",
    runcommandoutput: "runCommandOutput",
    run_with_retry: "runCommandOutput",
    wait_for: "runCommandOutput",
    run_until: "runCommandOutput",
    api_request: "apiRequest",
    apirequest: "apiRequest",
    http_request: "apiRequest",
    http: "apiRequest",
    request: "apiRequest",
    curl: "apiRequest",
    run_script: "runScript",
    runscript: "runScript",
    npm_run: "runScript",
    run_npm_script: "runScript",
    validate_project: "validateProject",
    validateproject: "validateProject",
    validate: "validateProject",
    check_project: "validateProject",
    full_check: "validateProject",
    git_branch: "gitBranch",
    gitbranch: "gitBranch",
    branch: "gitBranch",
    branches: "gitBranch",
    git_checkout: "gitCheckout",
    gitcheckout: "gitCheckout",
    checkout: "gitCheckout",
    switch_branch: "gitCheckout",
    switchbranch: "gitCheckout",
    git_diff_branches: "gitDiff",
    gitdiff: "gitDiff",
    compare_branches: "gitDiff",
    branch_diff: "gitDiff",
    git_undo_last_commit: "gitUndoLastCommit",
    git_init: "gitInit",
    gitinit: "gitInit",
    init_repo: "gitInit",
    initrepo: "gitInit",
    create_repo: "gitInit",
    createrepo: "gitInit",
    new_repo: "gitInit",
    local_repo: "gitInit",
    init_git: "gitInit",
    gitundolastcommit: "gitUndoLastCommit",
    undo_commit: "gitUndoLastCommit",
    soft_reset: "gitUndoLastCommit",
    find_references: "findReferences",
    findreferences: "findReferences",
    references: "findReferences",
    where_used: "findReferences",
    usages: "findReferences",
    symbol_usage: "findReferences",
    reset_soft: "gitUndoLastCommit",
    get_dependencies: "getDependencies",
    getdependencies: "getDependencies",
    dependencies: "getDependencies",
    deps: "getDependencies",
    npm_ls: "getDependencies",
    npm_audit: "getDependencies",
    format_code: "formatCode",
    formatcode: "formatCode",
    format: "formatCode",
    prettier: "formatCode",
    db_query: "dbQuery",
    dbquery: "dbQuery",
    sql: "dbQuery",
    psql: "dbQuery",
    query_db: "dbQuery",
    install_system_package: "installSystemPackage",
    installsystempackage: "installSystemPackage",
    install_system: "installSystemPackage",
    check_installed_program: "checkInstalledProgram",
    checkinstalledprogram: "checkInstalledProgram",
    check_program: "checkInstalledProgram",
    installed: "checkInstalledProgram",
    can_execute: "canExecute",
    canexecute: "canExecute",
    exists: "canExecute",
    refresh_env: "refreshEnv",
    refreshenv: "refreshEnv",
    refresh_path: "refreshEnv",
    get_system_info: "getSystemInfo",
    getsysteminfo: "getSystemInfo",
    system_info: "getSystemInfo",
    os_info: "getSystemInfo",
    explain_error: "explainError",
    explainerror: "explainError",
    exit_code: "explainError",
    retry_command: "retryCommand",
    retrycommand: "retryCommand",
    timeout_command: "timeoutCommand",
    timeoutcommand: "timeoutCommand",
    run_as_admin: "runCommandAsAdmin",
    runcommandasadmin: "runCommandAsAdmin",
    admin: "runCommandAsAdmin",
    elevate: "runCommandAsAdmin",
    download_and_extract: "downloadAndExtract",
    downloadandextract: "downloadAndExtract",
    download_zip: "downloadAndExtract",
    extract_archive: "downloadAndExtract",
    todo_write: "todoWrite",
    todowrite: "todoWrite",
    todo: "todoWrite",
    todos: "todoWrite",
    plan: "todoWrite",
    write_plan: "todoWrite",
    writeplan: "todoWrite",
    update_plan: "todoWrite",
    updateplan: "todoWrite",
    plan_tasks: "todoWrite",
  };
  const KNOWN_TOOLS = TOOL_DEFINITIONS.map((t) => t.function.name);

  function normalizeToolName(name) {
    const n = String(name || "").trim();
    if (!n) return "";
    if (KNOWN_TOOLS.includes(n)) return n;
    return TOOL_ALIASES[n.toLowerCase()] || n;
  }

  function normalizeToolArgs(args) {
    if (args && typeof args === "object") return args;
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return {};
  }

  // Запасной способ вызова инструментов: если модель вместо tool_calls
  // напечатала JSON-объект вида {"name": "...", "arguments": {...}} текстом,
  // приложение само найдёт его и выполнит.
  function extractToolCallsFromText(text) {
    const calls = [];
    if (!text) return calls;
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf("{", i);
      if (start === -1) break;
      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let k = start; k < text.length; k++) {
        const ch = text[k];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = k + 1;
            break;
          }
        }
      }
      if (end === -1) break;
      const raw = text.slice(start, end);
      i = end;
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      // Поддерживаем разные форматы, которые модели печатают текстом:
      // 1) {"name": "writeFile", "arguments": {...}}
      // 2) {"function": {"name": "writeFile", "arguments": {...}}}  (формат Ollama)
      // 3) {"tool": "gitStatus", "parameters": {...}}
      let name = obj.name || (obj.function && obj.function.name) || obj.tool;
      let args = obj.arguments != null ? obj.arguments : obj.function && obj.function.arguments != null ? obj.function.arguments : obj.parameters;
      if (typeof name !== "string") continue;
      name = normalizeToolName(name);
      if (!KNOWN_TOOLS.includes(name)) continue;
      calls.push({ name, args: normalizeToolArgs(args), raw });
    }
    return calls;
  }


  // ── Адреса, ключи и заголовки провайдеров — в src/renderer/provider-config.js ──
  // baseFor, proxiedBase, apiKeyFor, apiHeaders, projectHeader, jsonArgs, genCallId
  // и реестр G4F получены в начале файла: код ниже и остальное ядро не менялись.

  // ── Сообщения, запрос и стрим — в src/renderer/provider-transport.js ──
  // Конвертация сообщений, кэш промпта, сборка запроса, разбор потока и список
  // моделей берутся оттуда (см. начало раздела выше).

  // ── Чтение ошибок и лимиты провайдера — в src/renderer/provider-config.js ──
  // readApiError, friendlyRateLimitError, classifyKeyError, rateLimitInfo,
  // createRateLimiter и fmtError получены в начале файла.

  // ── Вспомогательная модель (второй ключ): зрение + генерация изображений ──
  // Логика живёт в src/renderer/image-tools.js: ядро даёт ей только транспортные
  // помощники, поэтому модуль можно проверять без агента и без настроек.
  const {
    normalizeAuxBase,
    auxConfig,
    describeImageRemote,
    generateImageRemote,
    imageAttempts,
    imageProviderLabel,
    proxiedUrl,
  } = ImageTools({ apiHeaders, proxiedBase, readApiError });

  // ── Динамические инструменты: при тесном контексте шлём только ядро ──
  const CORE_TOOL_NAMES = new Set([
    "createFolder", "readFile", "writeFile", "listDirectory", "readFileLines", "editFile",
    "runCommand", "runCommandOutput", "retryCommand", "timeoutCommand", "shellsStatus",
    "webSearch", "webFetch", "searchFile", "searchProject", "listFiles",
    "fileOutline", "readFileStructure", "explainCode", "undoEdit",
    "startBackground", "listBackground", "backgroundOutput", "sendInput", "stopBackground",
    "shellStart", "shellSend", "checkUrl", "checkPort", "openUrl", "showImage",
    "previewUI", "diffView", "askUser", "analyzeImage", "generateImage", "screenshotCapture",
    "listProcesses", "killProcess", "clipboardRead", "clipboardWrite", "screenshotDesktop",
    "registryRead", "registryWrite", "openPath", "wingetSearch", "installExe",
    "memoryList", "memorySearch", "todoWrite",
    // Git-минимум: приложение про репозитории — без этих инструментов агент на тесном
    // окне не мог даже посмотреть состояние, хотя до правки сюда попадал только браузер.
    "gitStatus", "gitDiff", "gitLog", "gitCommit", "gitBranch", "gitPush", "gitPull", "gitInit",
    // Поиск возможностей доступен всегда: иначе «узкий» набор нечем расширить.
    "findTools",
    // Браузерный минимум: без него при тесном контексте агент не мог открыть сайт вообще.
    "browserOpen", "browserSnapshot", "browserClick", "browserFill", "browserAct",
    "browserScroll", "browserHover", "browserScreenshot", "browserNetwork", "waitForIdle",
    "browserEval", "browserOverlays", "agentGuide", "browserReplay",
  ]);
  const CORE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => CORE_TOOL_NAMES.has(t.function && t.function.name));
  // План-режим: модель должна уметь составить план структурой, а не текстом,
  // поэтому туда уходит ровно один инструмент — todoWrite.
  const PLAN_MODE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => t.function && t.function.name === "todoWrite");
  // ── Роутер инструментов (ускорение №3) ───────────────────────────────────
  // 147 схем — это ~24 700 токенов в КАЖДОМ раунде: и деньги, и время до первого
  // токена. Роутер отдаёт модели базовый набор (файлы, терминал, основы git,
  // память, web, план) плюс только те группы, которые нужны по делу — по словам
  // в запросе пользователя и уже начатой работе.
  //
  // Два правила, которые нельзя нарушать:
  //  1) ПОРЯДОК инструментов — канонический (как в TOOL_DEFINITIONS), без сортировки
  //     по релевантности: иначе меняется префикс запроса и рушится кэш промпта
  //     (Anthropic/OpenRouter) и переиспользование префикса (OpenAI/DeepSeek/Groq).
  //  2) Липкость: группа, однажды включённая в задаче, остаётся до её конца — иначе
  //     инструмент исчезнет на середине работы.
  //
  // Предохранители: A) вызов реального инструмента вне набора → схема добавляется и
  // вызов повторяется (main.js); B) мета-инструмент findTools — модель сама просит
  // нужную возможность; C) настройка «отправлять все инструменты» + авто-расширение
  // при ошибке «неизвестный инструмент».
  // ── Роли агента ──────────────────────────────────────────────────────────
  // Роль — это РЕЖИМ ЧАТА, а не одноразовый промпт: её текст подставляется в системный
  // промпт каждый раунд, а её группы инструментов включены с первого раунда. Поэтому
  // роль держится весь диалог (чип-промпт так не умеет) и заодно сужает набор схем —
  // каждый раунд дешевле и префикс запроса стабильнее (кэш провайдера).
  const DEFAULT_ROLE = "dev";
  const AGENT_ROLES = [
    {
      id: "dev",
      icon: "🛠",
      title: "Разработчик",
      hint: "Код, файлы, git, запуск проекта — обычный режим приложения.",
      groups: [],
      chips: [],
      prompt: "",
    },
    {
      id: "assistant",
      icon: "🧑💼",
      title: "Ассистент",
      hint: "Помощник по делам на этом ПК: файлы, документы, письма, сайты, порядок.",
      groups: ["notes", "mail", "system", "browser", "files", "terminal", "vault"],
      chips: [
        { t: "Спланируй мой день", send: true },
        { t: "Разбери входящие", send: true },
        { t: "Напиши письмо", send: false },
        { t: "Наведи порядок в папке", send: false },
        { t: "Сделай выжимку из файла", send: false },
        { t: "Собери отчёт за неделю", send: true },
      ],
      prompt: [
        "РЕЖИМ «АССИСТЕНТ»: ты личный помощник по делам на этом компьютере, а не разработчик.",
        "1. Работаешь с файлами, документами, письмами, сайтами и порядком в папках; код пишешь только по прямой просьбе (иначе предложи роль «Разработчик»).",
        "2. Решения, договорённости и важные выводы сохраняй в память проекта (noteSave) — в новой сессии прочитай их (noteRead/noteList).",
        "3. Личные дела и сроки — это роль «Менеджер»: если человек говорит о дедлайнах и планах, предложи переключить роль и веди список дел.",
        "4. Файлы и документы ищи поиском по рабочей папке, прежде чем спрашивать; выжимку из длинного файла делай сам и показывай коротко.",
        "5. Письма и сообщения отправляй только по явной просьбе и после показа получателя и текста (mailSend).",
        "6. Входы на сайты бери из менеджера паролей (vaultList/vaultFill), пароли в чат не печатай.",
        "7. Заказ, бронь, формы на сайтах — через браузер; перед оплатой или отправкой данных остановись и спроси подтверждение.",
        "8. ВК (vk.com/vk.ru) — по отдельному справочнику: agentGuide { name: \"vk\" } (подхватывается сам на адресах vk.com/vk.ru). Перед действием проверь, что сессия жива (browserText); вход — пароль из менеджера паролей (vaultList/vaultFill), иначе попроси человека войти в окне. Сообщение отправляют РОВНО четыре шага: browserOpen → browserFill в [role=textbox] БЕЗ submit → browserClick по .ConvoComposer__sendButton--submit → проверка пустым полем (browserEval: .ComposerInput__input.textContent.length === 0). submit: true и Enter в ВК НЕ отправляют — текст залипает в поле.",
        "9. Действия на ПК (программы, буфер, скриншот, процессы) — группа system: сначала посмотри, потом меняй.",
      ].join("\n"),
    },
    {
      id: "manager",
      icon: "📋",
      title: "Менеджер",
      hint: "Дела и сроки: план дня, дедлайны, напоминания, отчёты.",
      // browser и vault — чтобы вести переписку с клиентами в ВК и на сайтах: без группы
      // браузера роль дел физически не могла отправить сообщение, хотя справочник ВК есть.
      groups: ["tasks", "notes", "mail", "system", "browser", "vault"],
      chips: [
        { t: "Что у меня на сегодня?", send: true },
        { t: "Что просрочено?", send: true },
        { t: "Спланируй неделю", send: true },
        { t: "Разбери входящие", send: true },
        { t: "Собери отчёт за неделю", send: true },
      ],
      prompt: [
        "РЕЖИМ «МЕНЕДЖЕР»: ты личный менеджер дел и сроков, а не разработчик.",
        "1. В начале работы и когда речь о планах — вызывай taskList (просроченные и ближайшие первыми) и опирайся на список, а не на память.",
        "2. Любую задачу, просьбу и договорённость превращай в дело: taskAdd(title, due, priority, project, note). Срок разбирается по-человечески: «завтра 14:00», «в пятницу», «через 2 недели», «15.09». Срок не назван — спроси, не выдумывай.",
        "3. Закрывай и переноси дела только по словам человека: taskDone(id, false) снимает отметку, taskUpdate меняет срок или название.",
        "4. Просроченное и «горит сегодня» говори прямо в начале ответа и предлагай, что важнее — человек не должен вычитывать список.",
        "5. Отчёты (день, неделя, проект) собирай из дел и заметок (noteList), а не из общих слов.",
        "6. Письма и напоминания наружу — только по явной просьбе и после подтверждения адресата.",
        "7. Код и файлы проекта не меняй САМОВОЛЬНО: твоя работа — дела, сроки и порядок. Но если человек прямо попросил код, скрипт или правку файла — делай: это просьба, а не самодеятельность. Большая такая работа — это миссия (missionStart), а не повод отказаться.",
        "8. Если дел нет — так и скажи и предложи занести первое.",
        "9. Повторяющиеся планы («каждый день в 9», «по понедельникам») заводи через taskAdd с repeat: «каждый день», «по будням», «каждую пятницу», «каждый месяц», «каждые 2 часа».",
        "10. Дело, которое агент должен ВЫПОЛНИТЬ сам по сроку, помечай auto: true и пиши prompt — что именно сделать. Тогда приложение в срок запустит агента в чате «Автозадачи», и ответ появится там. Без auto дело только напоминает.",
        "11. Отсрочить надоевшее напоминание — taskUpdate с snooze: «через час», «завтра 9:00». Срок при этом не меняется.",
        "12. БОЛЬШАЯ работа (разобрать десятки писем, навести порядок в куче файлов, обработать пачку документов, собрать большой отчёт) — это миссия: сначала missionStart(goal, steps), СРАЗУ после неё — todoWrite с планом миссии (панель плана видит человек, и план нужен с первого шага, а не после половины работы), потом работай шаг за шагом и после КАЖДОГО шага вызывай missionStep(done, next, note). Файлы миссии лежат в рабочей папке (.agent/missions/<id>/), поэтому работу видно человеку и она переживает перезапуск приложения.",
        "13. Миссия не закрыта — не заканчивай ответ словами «осталось сделать то и то»: продолжай делом. Закрывай её только когда работа действительно сделана — missionFinish(report) с коротким итогом.",
        "14. Если тебя разбудили по сроку (чат «Автозадачи») — сначала missionStatus (или missionStart, если миссии ещё нет), потом работа: в журнале должно быть видно, чем ты занимался.",
        "15. Переписка в ВК (клиенты, партнёры, заявки) — по справочнику agentGuide { name: \"vk\" }: адреса диалогов, селекторы, отправка сообщения, выгрузка диалогов запросом и грабли. Перед действием проверь сессию (browserText); вход — пароль из менеджера паролей (vaultList/vaultFill), иначе попроси человека войти в окне. Отправка — ровно четыре шага с кнопкой .ConvoComposer__sendButton--submit и проверкой пустого поля; submit: true и Enter в ВК НЕ отправляют.",
        "16. Отвечать людям в переписке от имени человека можно только по его просьбе и после показа адресата и текста. Непришедший ответ — это дело со сроком, а не повод писать от себя.",
      ].join("\n"),
    },
    {
      id: "researcher",
      icon: "🔎",
      title: "Исследователь",
      hint: "Поиск и разбор: источники, сравнения, выжимки с сохранением выводов.",
      groups: ["browser", "notes", "files"],
      chips: [
        { t: "Найди и разбери: ", send: false },
        { t: "Сравни подходы: ", send: false },
        { t: "Сделай выжимку из источника", send: false },
        { t: "Сохрани выводы в заметки", send: false },
      ],
      prompt: [
        "РЕЖИМ «ИССЛЕДОВАТЕЛЬ»: ты разбираешься в теме по источникам, а не пишешь код.",
        "1. Сначала поиск (webSearch), затем чтение страниц (webFetch/browser) — свежие факты важнее памяти модели.",
        "2. Каждый важный вывод подкрепляй источником: адрес и дата. Где источник один — так и скажи.",
        "3. Отделяй факты от предположений и явно помечай предположения.",
        "4. Итог — короткая структура: что выяснили, чем подтверждено, что осталось неизвестным.",
        "5. Результат сохраняй в память проекта (noteSave), чтобы вернуться к нему в новой сессии.",
        "6. Файлы проекта читай, но не меняй: правки — роль «Разработчик».",
      ].join("\n"),
    },
  ];

  function roleById(id) {
    const key = String(id || "").trim().toLowerCase();
    return AGENT_ROLES.find((r) => r.id === key) || AGENT_ROLES.find((r) => r.id === DEFAULT_ROLE);
  }

  // Роль целиком (для интерфейса и подсказок).
  function rolesList() {
    return AGENT_ROLES.map((r) => ({ id: r.id, icon: r.icon, title: r.title, hint: r.hint, chips: r.chips.slice(), groups: r.groups.slice() }));
  }

  // Что роль даёт прогону: группы с первого раунда, чипы и текст в системный промпт.
  function rolePlan(id) {
    const r = roleById(id);
    return { id: r.id, icon: r.icon, title: r.title, groups: r.groups.slice(), chips: r.chips.slice(), prompt: r.prompt };
  }

  // Роль из чата: строка id, можно мусор — вернётся роль по умолчанию.
  function roleOfChat(chat) {
    return roleById(chat && chat.role).id;
  }

  const BASE_TOOL_NAMES = [
    // файлы и папки
    "createFolder", "readFile", "readFileLines", "writeFile", "editFile", "listDirectory",
    "listFiles", "searchFile", "fileOutline", "readFileStructure", "applyPatch", "undoEdit", "diffView",
    // терминал и фоновые процессы
    "runCommand", "runCommandOutput", "startBackground", "listBackground", "backgroundOutput",
    "sendInput", "stopBackground",
    // git-основы (приложение про репозитории — это обязательный минимум)
    "gitStatus", "gitDiff", "gitLog", "gitCommit", "gitBranch",
    // диалог, план, память
    "askUser", "todoWrite", "memoryList", "memorySearch", "findTools",
    // web, картинки, ожидание
    "webSearch", "webFetch", "showImage", "analyzeImage", "generateImage", "waitUntil", "checkUrl",
  ];

  const TOOL_GROUPS = [
    {
      id: "git",
      title: "git и GitHub (удалённые операции)",
      keywords: ["запуш", "push", "опублик", "github", "гитхаб", "gitlab", "клонир", "clone", "выгрузи",
        "pull", "стяни", "ветк", "branch", "checkout", "stash", "откати коммит", "revert", "cherry",
        "blame", "кто автор", "перенеси коммит"],
      names: ["gitClone", "gitPush", "gitPublish", "gitInit", "gitPull", "gitRevert", "gitUndoLastCommit",
        "gitCheckout", "gitStash", "gitCherryPick", "gitBlame"],
    },
    {
      id: "browser",
      title: "браузер (сайты, клики, интерфейсы)",
      keywords: ["браузер", "browser", "сайт", "страниц", "вкладк", "зайди", "зайти", "открой ссылк",
        "ссылк", "url", "http", "гугл", "google", "авито", "вконтакте", "вк ", "клик", "нажми",
        "навед", "прокрут", "скролл", "подсказк", "капч", "cookies", "сесси", "chromium", "playwright",
        "авторизуй", "форма вход", "ленив", "виртуальн", "диалог", "пагинац", "все сообщения"],
      names: ["browserOpen", "browserConnect", "browserClose", "browserStatus", "browserClearProfile",
        "browserSnapshot", "browserClick", "browserFill", "browserAct", "browserSelect", "browserPress",
        "browserText", "browserScreenshot", "browserEval", "browserDOM", "browserOverlays", "browserWait",
        "browserScroll", "browserHover", "browserNetwork", "browserReplay", "waitForIdle", "agentGuide"],
    },
    {
      id: "system",
      title: "система Windows (процессы, реестр, установка программ)",
      keywords: ["реестр", "registry", "процесс", "диспетчер задач", "скриншот экрана", "экран",
        "буфер", "clipboard", "скопируй", "вставь", "установи программ", "установк", "installer",
        "winget", "choco", "scoop", "драйвер", "характеристик", "железо", "gpu", "cpu", "оперативн",
        "переменные среды", "админ", "права администратора", "проводник", "ярлык"],
      names: ["getSystemInfo", "listProcesses", "killProcess", "clipboardRead", "clipboardWrite",
        "screenshotDesktop", "registryRead", "registryWrite", "openPath", "wingetSearch", "installExe",
        "installSystemPackage", "checkInstalledProgram", "canExecute", "refreshEnv", "runCommandAsAdmin"],
    },
    {
      id: "project",
      title: "сборка, тесты, зависимости, .env, docker/BД",
      keywords: ["тест", "test", "линт", "lint", "prettier", "формат код", "собери проект", "сборк",
        "docker", "докер", "контейнер", "база данн", "бд", "sql", "запрос к баз", "env", "переменн",
        "api", "http-запрос", "проверь проект", "архив", "распакуй", "зависимост", "установи пакет",
        "библиотек"],
      names: ["runTests", "lintProject", "formatCode", "validateProject", "installPackage",
        "downloadAndExtract", "dbQuery", "dockerBuild", "dockerRun", "dockerExec",
        "apiRequest", "envSet", "envList", "envUnset"],
    },
    {
      id: "files",
      title: "навигация и рефакторинг по коду",
      keywords: ["структур", "outline", "зависимост", "dependenc", "ссылки на", "найди ссылк",
        "рефактор", "переименуй", "переименова", "семантич", "по смыслу", "объясни код", "объясни ошибк"],
      names: ["searchProject", "explainCode", "refactorRename", "explainError", "findReferences",
        "semanticSearch", "getDependencies"],
    },
    {
      id: "terminal",
      title: "оболочки, порты, фоновые команды",
      keywords: ["shell", "оболочк", "терминал", "порт", "фонов", "долгую команд", "таймаут",
        "повтори команд", "скрипт", "bash", "powershell"],
      names: ["shellsStatus", "shellStart", "shellSend", "retryCommand", "timeoutCommand", "runScript",
        "listPorts", "checkPort"],
    },
    {
      id: "notes",
      title: "заметки и точки возврата",
      keywords: ["заметк", "note", "чекпоинт", "checkpoint", "точку возврата", "точка возврата",
        "дневник", "памятк", "откатись"],
      names: ["noteSave", "noteRead", "noteList", "noteDelete", "checkpointSave", "checkpointList",
        "checkpointRollback"],
    },
    {
      id: "tasks",
      title: "дела и сроки (личный список задач)",
      keywords: ["задач", "срок", "дедлайн", "deadline", "просроч", "напомни", "мои дела", "список дел",
        "напомина", "расписан", "календар", "встреч", "план на", "чеклист", "менеджер",
        "что сделать", "успеть", "перенес", "записать дело", "меня дела", "по делам", "на сегодня", "на неделю",
        "мисси", "долгая работа", "долго работать", "работай долго", "по шагам", "не останавливайся", "работай часами"],
      names: ["taskAdd", "taskList", "taskUpdate", "taskDone", "taskDelete",
        "missionStart", "missionStep", "missionStatus", "missionFinish"],
    },
    {
      id: "mail",
      title: "почта агента",
      keywords: ["почт", "письм", "mail", "smtp", "imap", "ящик", "коммерческое предлож", "кп ",
        "входящ", "код подтвержден"],
      names: ["mailSend", "mailList", "mailCode"],
    },
    {
      id: "vault",
      title: "менеджер паролей",
      keywords: ["парол", "vault", "сохрани вход", "вход на сайт", "логин и пароль"],
      names: ["vaultList", "vaultFill"],
    },
    {
      id: "app",
      title: "управление окном приложения",
      keywords: ["окно приложени", "окна приложени", "окном приложени", "интерфейс приложени",
        "своё прилож", "свою прилож", "наше прилож", "мое прилож", "моё прилож", "в приложении",
        "скриншот приложени", "панель приложени", "панели приложени"],
      names: ["appRead", "appClick", "appFill", "appSelect", "appPress", "appWait", "appScreenshot",
        "screenshotCapture"],
    },
    {
      id: "preview",
      title: "превью и запуск проекта",
      keywords: ["превью", "preview", "запусти проект", "запустить проект", "dev-сервер", "dev server",
        "localhost", "открой в браузере"],
      names: ["previewUI", "openUrl"],
    },
    {
      id: "ota",
      title: "самообновление",
      keywords: ["ota", "самосовершен", "обнови себя", "откати обновление", "обновление приложени"],
      names: ["otaStatus", "otaCheck", "otaRollback"],
    },
    {
      id: "cloud",
      title: "Yandex Cloud",
      keywords: ["yandex", "яндекс", "облак", "cloud", "серверлес", "serverless", "бакет", "s3"],
      names: ["ycStatus", "ycList", "ycContainer", "ycCosts", "ycCreate", "ycDelete", "ycDeploy", "ycLogs", "ycInstall"],
    },
  ];

  // Потолок «веса» выбранных схем (в токенах): база + группы должны укладываться сюда.
  // База стоит ~5 900 (36 схем), «браузер» ~5 570, «система» ~2 270, «проект» ~1 950.
  // 15 000 = база + 2–3 группы: тихая задача остаётся ~5.9k вместо 24.5k, а нужные
  // группы почти всегда помещаются. Если потолок всё же срезал группу — main.js
  // пишет об этом в «Консоль» (dropped), а предохранители A/B доберут её при работе.
  // База не режется никогда: без файлов/терминала/git агент не работает.
  const ROUTER_MAX_TOKENS = 15000;

  const _toolByGroupName = new Map(); // имя → id группы (для предохранителя A)
  const _groupNames = new Map();      // id → [имена]
  for (const g of TOOL_GROUPS) {
    _groupNames.set(g.id, g.names.slice());
    for (const n of g.names) _toolByGroupName.set(n, g.id);
  }
  const _groupTokensCache = new Map();
  function groupTokenWeight(id) {
    if (_groupTokensCache.has(id)) return _groupTokensCache.get(id);
    const names = new Set(_groupNames.get(id) || []);
    const w = estimateTokens(JSON.stringify(TOOL_DEFINITIONS.filter((t) => names.has(t.function && t.function.name))));
    _groupTokensCache.set(id, w);
    return w;
  }
  const BASE_TOOL_WEIGHT = estimateTokens(
    JSON.stringify(TOOL_DEFINITIONS.filter((t) => BASE_TOOL_NAMES.indexOf(t.function && t.function.name) !== -1))
  );

  // Какие группы активированы по тексту запроса (счётчик совпавших слов группы).
  function scoreGroups(text) {
    const t = String(text || "").toLowerCase();
    const out = [];
    for (const g of TOOL_GROUPS) {
      let score = 0;
      for (const kw of g.keywords) {
        if (kw && t.indexOf(kw) !== -1) score++;
      }
      out.push({ id: g.id, score: score });
    }
    return out;
  }

  // Предохранитель B: поиск инструмента по смыслу запроса (findTools).
  // Ищем по имени и описанию; слова запроса должны встречаться целиком (частичное
  // совпадение окончаний не требуется — берём и по началу слова, как scoreGroups).
  function searchTools(query, limit) {
    const q = String(query || "").toLowerCase().trim();
    const n = Math.max(1, Math.min(30, Number(limit) || 8));
    if (!q) return [];
    const words = q.split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 3);
    const scoreOf = (f) => {
      const name = String(f.name).toLowerCase();
      const desc = String(f.description || "").toLowerCase();
      let sc = 0;
      if (name.indexOf(q.replace(/\s+/g, "")) !== -1) sc += 6;
      for (const w of words) {
        const root = w.length > 5 ? w.slice(0, w.length - 2) : w;
        if (name.indexOf(root) !== -1) sc += 3;
        if (desc.indexOf(root) !== -1) sc += 1;
      }
      return sc;
    };
    // 1) Группы, чьи ключевые слова совпали («запуш» → git, «скриншот» → system).
    //    Это главный сигнал: он ловит русские слова, которых нет в английских именах.
    const groupScore = new Map(scoreGroups(q).filter((s) => s.score > 0).map((s) => [s.id, s.score]));
    const out = [];
    const seen = new Set();
    TOOL_DEFINITIONS.forEach((t, idx) => {
      const f = t && t.function;
      if (!f || !f.name || f.name === "findTools") return;
      const gid = _toolByGroupName.get(f.name) || "";
      const gs = groupScore.get(gid) || 0;
      const sc = scoreOf(f) + gs * 4 + (gs > 0 ? 2 : 0);
      if (sc <= 0) return;
      seen.add(f.name);
      out.push({ name: f.name, group: gid, description: String(f.description || ""), score: sc, idx: idx });
    });
    // 2) Инструменты, найденные в первом проходе, тянут за собой всю свою группу:
    //    модель просит «письмо» — получает весь почтовый набор.
    const groupsHit = new Set(out.filter((x) => x.group).map((x) => x.group));
    TOOL_DEFINITIONS.forEach((t, idx) => {
      const f = t && t.function;
      if (!f || !f.name || seen.has(f.name)) return;
      const gid = _toolByGroupName.get(f.name) || "";
      if (!gid || !groupsHit.has(gid)) return;
      seen.add(f.name);
      // 0.5 — ниже прямых совпадений, но выше нуля: порядок внутри группы остаётся
      // каноническим (idx), поэтому список детерминирован.
      out.push({ name: f.name, group: gid, description: String(f.description || ""), score: 0.5, idx: idx });
    });
    out.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return out.slice(0, n);
  }

  // Текст для роутера: по нему выбираются группы инструментов на задачу.
  // Раньше сюда попадали ТОЛЬКО последние 3 сообщения пользователя — и на «продолжай»
  // (где нет ни одного ключевого слова) группа предыдущей работы выпадала. Тогда набор
  // схем менялся прямо посреди прогона: предохранитель A дотягивал группу на ходу,
  // префикс запроса становился другим — и бесплатный пул провайдера отвечал
  // 503 cache_only_cold («принимаю только запрос с готовым кэшем»). Поэтому роутер
  // обязан видеть саму работу: историю реплик, а не одну последнюю фразу.
  const ROUTER_TASK_MESSAGES = 12;
  const ROUTER_TASK_CHARS = 6000;
  const ROUTER_TASK_PER_MESSAGE = 1200;
  function routerTaskText(messages, opts) {
    const o = opts || {};
    const maxMessages = Math.max(1, Number(o.maxMessages) || ROUTER_TASK_MESSAGES);
    const maxChars = Math.max(200, Number(o.maxChars) || ROUTER_TASK_CHARS);
    const list = Array.isArray(messages) ? messages : [];
    const parts = [];
    // Новейшее — в начало: при обрезке теряется самое старое, а не текущая задача.
    for (let i = list.length - 1; i >= 0 && parts.length < maxMessages; i--) {
      const m = list[i];
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const c = m.content;
      const txt = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n")
          : "";
      const clean = String(txt || "").replace(/\s+/g, " ").trim();
      if (clean) parts.push(clean.slice(0, ROUTER_TASK_PER_MESSAGE));
    }
    return parts.join("\n").slice(0, maxChars);
  }

  // Отказ пула провайдера: 503 и «холодный» ответ (cache_only_cold у бесплатных пулов)
  // — принимается только запрос с готовым кэшем либо пул перегружен. Наша вина тут
  // косвенная (сменился префикс запроса), и лечится это повтором ТОГО ЖЕ раунда с
  // паузой: история не переписывается, поэтому повтор уже может попасть в кэш.
  const UNAVAILABLE_WAITS = [4000, 10000, 20000];
  const UNAVAILABLE_MAX = UNAVAILABLE_WAITS.length;
  function coldCacheInfo(status, detail, attempt) {
    const st = Number(status) || 0;
    // Ветку берут только 5xx: 429, 402 и 400 разбираются своими правилами.
    if (st && !(st >= 500 && st <= 599)) return null;
    const d = String(detail || "");
    const cold = /cache[ _-]?only/i.test(d);
    const busy = /overloaded|unavailable|capacity|too many requests|temporarily|try again/i.test(d);
    if (!cold && !busy && st !== 503 && st !== 502 && st !== 529) return null;
    const i = Math.max(0, Math.min(UNAVAILABLE_MAX - 1, (Number(attempt) || 1) - 1));
    const waitMs = UNAVAILABLE_WAITS[i];
    const text = cold
      ? "⏳ Пул провайдера принял только запрос с готовым кэшем (cache_only_cold). Жду " +
        Math.round(waitMs / 1000) + " с и повторяю тот же раунд — история не меняется, шанс попасть в кэш растёт."
      : "⏳ Провайдер временно недоступен (" + st + "). Жду " + Math.round(waitMs / 1000) +
        " с и повторяю тот же раунд.";
    return { cold: cold, waitMs: waitMs, text: text };
  }

  // Итоговый набор схем: база + липкие/найденные группы в КАНОНИЧЕСКОМ порядке.
  // opts: { text, sticky (массив id), roleGroups (id групп роли), forceAll, maxTokens }
  // Минимальная история, которую оставляем модели. Служит границей для роутера:
  // сколько токенов окна можно отдать схемам, не оставив диалог без истории.
  // Раньше граница была жёсткой (12 000) и на локальном окне 8–32k съедала весь
  // остаток — группы схем срезались всегда, то есть роли и справочники не работали.
  const MIN_HISTORY_TOKENS = 1500;
  // Потолок веса схем: не больше ROUTER_MAX_TOKENS и не больше того, что реально
  // остаётся от окна после системного промпта и минимальной истории.
  function routerMaxTokens(budget, systemWeight, baseWeight) {
    const b = Math.max(0, Math.round(Number(budget) || 0));
    const sys = Math.max(0, Math.round(Number(systemWeight) || 0));
    const base = Math.max(0, Math.round(Number(baseWeight) || 0));
    const spare = b - sys - MIN_HISTORY_TOKENS;
    return Math.max(base, Math.min(ROUTER_MAX_TOKENS, Math.max(base, spare)));
  }

  function routeTools(opts) {
    const o = opts || {};
    const sticky = new Set(o.sticky || []);
    // Группы активной роли — с первого раунда (стабильный префикс запроса и никаких
    // «дополнений на ходу», из-за которых промахивается кэш провайдера).
    for (const g of o.roleGroups || []) if (g) sticky.add(g);
    if (o.forceAll) {
      return {
        tools: TOOL_DEFINITIONS,
        groups: TOOL_GROUPS.map((g) => g.id),
        dropped: [],
        tokens: estimateTokens(JSON.stringify(TOOL_DEFINITIONS)),
        activated: [],
        all: true,
      };
    }
    const scores = scoreGroups(o.text);
    const byId = new Map(scores.map((s) => [s.id, s.score]));
    const activated = [];
    for (const s of scores) {
      if (s.score > 0) {
        sticky.add(s.id);
        activated.push(s.id);
      }
    }
    const maxTokens = Math.max(BASE_TOOL_WEIGHT, o.maxTokens || ROUTER_MAX_TOKENS);
    // Группы добавляем по силе сигнала; при равном счёте — по порядку реестра
    // (детерминированно). Сортировка влияет только на ПОРЯДОК ДОБАВЛЕНИЯ, а не на
    // порядок схем в запросе — он всегда канонический.
    const wanted = [];
    for (let i = 0; i < TOOL_GROUPS.length; i++) {
      const g = TOOL_GROUPS[i];
      if (!sticky.has(g.id)) continue;
      wanted.push({ id: g.id, score: byId.get(g.id) || 0, i: i, tokens: groupTokenWeight(g.id) });
    }
    wanted.sort((a, b) => b.score - a.score || a.i - b.i);
    let weight = BASE_TOOL_WEIGHT;
    const used = [];
    const dropped = [];
    for (const g of wanted) {
      if (weight + g.tokens <= maxTokens) {
        used.push(g.id);
        weight += g.tokens;
      } else {
        dropped.push(g.id);
      }
    }
    const names = new Set(BASE_TOOL_NAMES);
    for (const id of used) {
      for (const n of _groupNames.get(id) || []) names.add(n);
    }
    return {
      tools: TOOL_DEFINITIONS.filter((t) => names.has(t.function && t.function.name)),
      groups: used,
      dropped: dropped,
      tokens: weight,
      activated: activated,
      all: false,
    };
  }

  // Предохранитель A: имя реального инструмента, которого нет в текущем наборе.
  // Возвращает id группы (или "" — такого инструмента нет вовсе).
  function groupOfTool(name) {
    return _toolByGroupName.get(String(name || "")) || "";
  }

  // Если окно контекста >= 26k — шлём все инструменты; иначе только ядро (~36 вместо 74).
  function selectTools(budget) {
    const b = budget || contextBudget("openai");
    return b >= 26000 ? TOOL_DEFINITIONS : CORE_TOOL_DEFINITIONS;
  }

  // ── Окно модели и параметры Ollama — в src/renderer/provider-transport.js ──
  // modelWindow, ollamaModelInfo, ollamaNumCtx и OLLAMA_KEEP_ALIVE живут там же.

  // ── Компакция старых витков — в src/renderer/context-window.js ──
  // Сжатие истории в памятку берётся оттуда (см. начало раздела «Контекст»).

  // ── Парсеры для инструментов ОС (процессы, реестр, системная информация) ──
  // tasklist /FO CSV /NH (Windows) или ps -eo (macOS/Linux) → [{pid, name, mem, ...}]
  function parseProcessesCsv(csv) {
    const procs = [];
    const lines = String(csv || "").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/"([^"]*)","(\d+)","([^"]*)","([^"]*)","([^"]*)"/);
      if (m) {
        procs.push({ name: m[1], pid: parseInt(m[2], 10), session: m[3], sessionNum: m[4], mem: m[5] });
        continue;
      }
      const p = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (p) procs.push({ pid: parseInt(p[1], 10), name: p[2], cpu: p[3], rss: p[4], args: p[5] });
    }
    return procs;
  }

  // Whitelist реестра: чтение — только SOFTWARE/ENVIRONMENT/SYSTEM/SECURITY; запись — только HKCU.
  function registryPathAllowed(regPath, write) {
    const p = String(regPath || "").trim();
    if (!p) return { ok: false, error: "Укажи путь в реестре (например HKCU\\Software\\MyApp)" };
    if (!/^HK[A-Z0-9]+\\/i.test(p)) {
      return { ok: false, error: "Путь должен начинаться с корня (HKLM\\, HKCU\\, HKCR\\, HKU\\ или HKCC\\)" };
    }
    const up = p.toUpperCase();
    if (write) {
      const ok = up.startsWith("HKCU\\SOFTWARE") || up.startsWith("HKCU\\ENVIRONMENT");
      return ok
        ? { ok: true }
        : { ok: false, error: "Запись разрешена только в HKCU\\Software и HKCU\\Environment. Для HKLM нужны права администратора — используй runCommandAsAdmin с reg add." };
    }
    const first = (up.split("\\")[1] || "").toUpperCase();
    if (["SOFTWARE", "ENVIRONMENT", "SYSTEM", "SECURITY"].includes(first)) return { ok: true };
    return { ok: false, error: "Чтение разрешено только из разделов SOFTWARE, ENVIRONMENT, SYSTEM, SECURITY (например HKLM\\Software, HKCU\\Environment)." };
  }

  // Разбор JSON системной информации от PowerShell → плоский объект.
  function parseSysInfoJson(json) {
    const d = {};
    try {
      const o = JSON.parse(String(json || "{}"));
      if (o && typeof o === "object") {
        if (o.os) d.os = String(o.os);
        if (o.build) d.build = String(o.build);
        if (o.cpu) d.cpu = String(o.cpu);
        if (o.gpu) d.gpu = String(o.gpu);
        if (o.ramGB != null) d.ramGB = Number(o.ramGB);
        if (Array.isArray(o.ips)) d.ips = o.ips.map(String);
        if (Array.isArray(o.disks)) d.disks = o.disks;
      }
    } catch {}
    return d;
  }

  return {
    SYSTEM_PROMPT,
    TOOL_DEFINITIONS,
    G4F_PROVIDERS,
    createThinkingStripper,
    stripThinking,
    normalizeToolName,
    normalizeToolArgs,
    normalizePlanTasks,
    normalizePlanStatus,
    planSummary,
    PLAN_MAX_ITEMS,
    extractToolCallsFromText,
    // транспорт провайдеров
    baseFor,
    isLocalBase,
    buildChatRequest,
    consumeProviderStream,
    toolsAsText,
    withTextTools,
    listModels,
    readApiError,
    friendlyRateLimitError,
    rateLimitInfo,
    createRateLimiter,
    genCallId,
    // контекст
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    windowBudget,
    trimConversation,
    sanitizeToolPairs,
    truncateText,
    selectTools,
    routeTools,
    routerMaxTokens,
    MIN_HISTORY_TOKENS,
    routerTaskText,
    coldCacheInfo,
    UNAVAILABLE_MAX,
    searchTools,
    AGENT_ROLES,
    DEFAULT_ROLE,
    roleById,
    rolesList,
    rolePlan,
    roleOfChat,
    TOOL_GROUPS,
    BASE_TOOL_NAMES,
    groupOfTool,
    ROUTER_MAX_TOKENS,
    PLAN_MODE_TOOL_DEFINITIONS,
    modelWindow,
    ollamaModelInfo,
    ollamaNumCtx,
    probeLocalModel,
    isLocalEndpoint,
    compactRemote,
    createContextManager,
    // веб (общий для Electron main и preview-сервера)
    downloadHtml,
    webSearchDDG,
    webSearch,
    classifyKeyError,
    webFetchPage,
    htmlToText,
    // вспомогательная модель: зрение + генерация изображений
    auxConfig,
    normalizeAuxBase,
    fmtError,
    splitStaticSystem,
    anthropicSystem,
    normalizeUsage,
    describeImageRemote,
    generateImageRemote,
    imageAttempts,
    imageProviderLabel,
    proxiedUrl,
    // инструменты ОС
    parseProcessesCsv,
    registryPathAllowed,
    parseSysInfoJson,
  };
});

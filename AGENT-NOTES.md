# Блокнот агента (заметки для будущих сессий)

## Общение
- Пользователь пишет по-русски и просит отвечать **исключительно на русском языке** (записано 6 сентября 2026). Все ответы — на русском, даже если код/сообщения системы на английском.

## Проект: AI Developer Agent (Electron)
- Приложение: чат с AI-агентом (Ollama / OpenAI-совместимые / Anthropic), файловые операции, git, GitHub.
- Файлы: `src/main.js` (главный процесс Electron), `src/preload.js` (мост), `src/renderer/` (UI: app.js, index.html, styles.css, agent-core.js, markdown.js).
- Сервер предпросмотра: `node server.js` (bun run preview, порт 8080) — только UI чата; полный функционал (файлы, git, клонирование) работает в десктоп-приложении.
- **Живая проверка интерфейса — обязательна: `bun run test:live`** (`scripts/live-ui.js`). Поднимает
  `server.js` на свободном порту, открывает **настоящий Chromium** (Playwright) и проверяет рельсу,
  панели, настройки, мобильную ширину, оба пути панели плана (текст модели и инструмент `todoWrite`),
  а также функции ядра прямо в живой странице. Браузер ставится один раз: `npx playwright install --with-deps chromium`.
- **Сквозная проверка десктопа — тоже обязательна при правках инструментов и главного процесса:
  `bun run test:live:desktop`** (`scripts/live-desktop.js`). Поднимает фейковый OpenAI-совместимый
  провайдер, запускает НАСТОЯЩИЙ Electron и проводит вызов инструмента целиком: рендерер → IPC →
  главный процесс → сеть → файл на диске (например `generateImage` пишет настоящий PNG). Под Xvfb:
  `xvfb-run -a node scripts/live-desktop.js` (нужны `libgtk-3-0`). Перед запуском гасите старые
  экземпляры: `pkill -f "electron/dist/electron"` — иначе занят порт отладки и тест не подключится.
  **Почему это правило:** структурный `test/smoke.test.js` исполняет СРЕЗЫ кода, подставляя имена в область
  видимости. Из-за этого он видел `normalizePlanTasks`, хотя в живом окне такого имени нет — вызов падал
  `ReferenceError`, тот молча гас в потоке ответа, и панель плана не появлялась ни разу (1.5.64).
- Репозитории GitHub: клик по строке = выбор (`github:pickRepo`), кнопка «⬇ Выгрузить» = клонирование в рабочую папку (`github:selectRepo`).
- Публикация НОВОГО репозитория: кнопка «⬆ Опубликовать на GitHub» в панели файлов и инструмент агента `gitPublish` (общая функция `publishLocalToGithub` в main.js): создаёт репозиторий POST /user/repos (по умолчанию приватный), git init -b main (если нужно), переименовывает master→main, первый коммит, remote origin, push -u, затем PATCH default_branch. У агента заблокирована без настройки «Разрешить агенту git push». Если в папке уже есть origin — ошибка с советом использовать Push.
- Клонирование: единая логика `cloneRepoTo` (пустые папки переиспользуются, имена папок безопасны для Windows, понятные ошибки, если git не установлен).
- Защита от «Permission denied» при клонировании:
  - `ensureWritableDir` делает **реальную проверку записи** (создаёт/удаляет подпапку `.ai-agent-write-test`), потому что `accessSync(W_OK)` не ловит OneDrive/сетевые/системные папки.
  - `pickCloneBase` / `cloneBaseCandidates` подбирают первую записываемую папку по цепочке: запрошенная → сохранённая рабочая → домашняя → Документы → временная.
  - Если git всё равно не может создать файлы (антивирус/«Контролируемый доступ к папкам» Windows блокирует git.exe) — `cloneRepoTo` повторяет клон в запасных записываемых папках.
  - Панель проекта (`projectDir`) следует за папкой последнего склонированного репозитория (`settings.githubRepoDir`).
- Терминал: команды агента (`runCommand`, `startBackground`, `shellSend`) дублируются в нижнюю панель терминала через `termAgentEcho`.
- Чаты привязаны к проектам (`chat.projectId`): переключение проекта переключает на чат этого проекта (`ensureProjectChat`), выбор чата чужого проекта переключает проект (`selectChat`). Так агент не видит контекст других проектов. При старте открывается чат активного проекта.
- Системный промпт (правило 17): запуск проекта — ТОЛЬКО через встроенный терминал (runCommand/startBackground/shellStart), dev-сервер по умолчанию на порту 5000.
- Авто-коммит после задания агента (`agentAutoCommit`, по умолчанию ВКЛ, чекбокс в настройках): когда агент завершил задачу (emit done) и менял файлы в git-репозитории — main.js делает локальный коммит «Авто-коммит агента: <первая строка последнего сообщения>» (add -A + commit, БЕЗ push). Пропуск: план-режим, нет изменений, папка не git, остановка/ошибка. Событие `ai:event {type:"checkpoint"}` → тост в UI; после `done` панель git обновляется.
- Хронологический вывод ответа агента (сегменты): текст и действия идут по порядку «текст → действия → текст → … → итог внизу». В app.js: `ensureSegmentForText` создаёт НОВЫЙ assistant-сегмент, если текст пришёл сразу после tool-сообщения (действие); `session.segmentIds` хранит сегменты запуска; `ensureWorkGroup` вставляет блок действий в конец списка (appendChild); `finishStream` помечает все сегменты готовыми, убирает пустые промежуточные (пустой ответ целиком → «…»), кнопки план/undo вешает на последний сегмент; `regenerate` удаляет весь запуск (от последнего user-сообщения). Сохранённая история = хронологический порядок сообщений, рендерится без изменений схемы.
- Быстрый запуск проекта в превью (пользователь сам): в вкладке «Превью» строка команды + «▶ Запустить» / «⏹ Остановить» + живой лог. IPC: `dev:start(dir, command)` / `dev:stop` / `dev:status(dir)` (main.js: `devStart`/`devStop`/`devStatus`, `detectDevCommand` — dev→start→serve из package.json, bun если есть bun.lock/bunfig). События стримятся в `dev:event` (start/out/exit/stopped). Остановка убивает дерево процесса (bgKill) — порт освобождается. После старта превью открывается на `settings.previewUrl` (по умолчанию http://localhost:5000).
- Мобильный доступ (LAN + PWA + PIN): телефон в той же Wi-Fi сети открывает `http://<IP-ПК>:9090` (порт настраивается), вводит PIN из Настроек → «Мобильный доступ» — и работает весь функционал ядра: чат, консоль, превью, файлы, git, GitHub. Архитектура: `src/mobile-bridge.js` (НОВЫЙ, без зависимостей) — HTTP-сервер отдаёт интерфейс + PWA (manifest /manifest.webmanifest, service worker /sw.js, иконка /icon.svg), WebSocket /ws (RFC 6455, реализован вручную) с PIN-авторизацией (5 неверных попыток → auth_lock + закрытие). RPC: клиент шлёт {t:"call",id,ch,args}, мост вызывает ТОТ ЖЕ обработчик, что и ipcMain (main.js проксирует `ipcMain.handle` → карта `ipcHandlerMap`; прокси ставится в самом верху main.js ДО всех регистраций). События: main.js проксирует `mainWindow.webContents.send` → `mobileBridge.broadcast` (ai:event/term:event/dev:event/github:event уходят на телефоны). Настройки: `mobileEnabled/mobilePort/mobilePin` в DEFAULT_SETTINGS, IPC `mobile:status` и `mobile:pinRegen` (генерация PIN в main, не в рендерере). При включении без PIN — генерируется автоматически. Мост стартует в whenReady (applySettings(loadSettings())), гасится в before-quit.
- Клиентская часть: `src/renderer/mobile-api.js` (НОВЫЙ, подключён в index.html перед app.js). ВАЖНО: активируется ТОЛЬКО при флаге `window.__mobileBridge`, который подмешивает мост через `/bootstrap.js` (bridge-роут; в Electron и в веб-превью server.js этого файла нет — там 404 и скрипт no-op, поэтому мок-режим и preload не ломаются). Без этого флага нельзя: `window.api` появляется синхронно, и мок-превью повисло бы на неразрешимых очередях вызовов. При загрузке через мост: синхронно создаёт `window.api` (зеркало preload.js, вызовы ДО авторизации встают в очередь), по WS-открытии показывает PIN-гейт (инлайн-стили, id mobile-gate), после auth_ok — flushQueue + регистрация SW. Переподключение: при обрыве после успешной авторизации — гейт «Соединение потеряно», PIN запоминается и шлётся автоматически. `window.mobileApi.host` — хост моста; app.js в `previewOpen` подменяет `http://localhost:*` на этот хост (с телефона localhost = сам телефон), `previewOpenTab` на телефоне открывает вкладку телефона, а не ПК.
- Адаптация UI под телефоны (styles.css, @media max-width:900px): `#sidebar` и `#project-panel` — оверлеи слева (в `#sidebar` класс `.open`), `.side-panel` — оверлей справа (94vw), `#app` height 100dvh, кнопка-бургер `btn-mobile-menu` в шапке (скрыта на десктопе), клик по чату закрывает меню.
- Вспомогательная модель (зрение + генерация картинок, второй ключ OpenRouter): настройки `visionEnabled/visionAuto/visionUrl/visionKey/visionModel/imageModel` (DEFAULT_SETTINGS). В agent-core.js новые экспорты: `auxConfig(s)` (url/key с фолбэком на основной ключ: пустой visionKey → openaiApiKey, пустой visionUrl → openaiUrl), `describeImageRemote(cfg, dataUrl, prompt, model)` (chat/completions с image_url-частью, Bearer-авторизация, max_tokens 2048, таймаут 180с), `generateImageRemote(cfg, prompt, model, opts)` (эндпоинт OpenRouter `POST {base}/images`, тело {model, prompt, aspect_ratio?}; ответ `data[0].b64_json` + `media_type` → Buffer; таймаут 300с). Инструменты агента в main.js (`executeTool`): `analyzeImage {path, question}` — читает файл-картинку (≤8МБ), показывает её событием `ai:event {type:"image"}` и возвращает описание; `generateImage {prompt, filename, aspect_ratio}` — генерит, сохраняет в рабочую директорию (имя безопасное, расширение добавляется), шлёт `{type:"image"}` и возвращает путь. Авто-пре-пасс в runAi (после trimConversation): если `visionEnabled && visionAuto && visionModel` и в последнем user-сообщении есть image_url-части (до 3) — каждую описывает vision-моделью и ПОДМЕНЯЕТ content на текст + «[Описание присланного изображения…]» (кодер не обязан уметь видеть картинки); прогресс — события `ai:event {type:"vision", text}` → рендерятся как плашка `.vision-note` в чате. UI: блок «🖼 Зрение и генерация» в настройках (чекбоксы enabled/auto, URL, ключ с 👁, модели с ↻-подгрузкой через `loadAuxModels(kind)` → чипы в `#vision-model-hints`), иконки инструментов `analyzeImage: "👁"`, `generateImage: "🎨"`. Правило 18 в SYSTEM_PROMPT.
- Контекст-менеджмент (фикс «агент замолкает» и «пишет код в чате вместо правки файлов»):
  - **A. Реальное окно модели**: `modelWindow(settings, model)` в agent-core — GET {base}/models, парсит `context_length || context_window`, кэш 10 мин по base (суффиксные id вида `vendor/model:free` матчатся). В runAi бюджет = min(эвристика, окно − 4096 резерв на вывод), минимум 3000. Раньше для всех OpenAI-совместимых было жёстко 50000 — у фри-моделей окно меньше, запросы не влезали.
  - **B. Динамические инструменты**: `selectTools(budget)` — при окне ≥ 26k шлются все 74 инструмента, иначе только ядро `CORE_TOOL_NAMES` (~36: файлы, терминал, web, askUser, vision/gen, preview). Вес схемы инструментов вычитается из бюджета истории (`histBudget`). Экономия ~30k токенов за раунд.
  - **C. Компакция вместо жёсткой обрезки**: `compactRemote(settings, messages)` — когда история не влезает, старые витки (всё до последнего user-сообщения, голова ≥ 4000 токенов) сжимаются дешёвым вызовом модели (тот же провайдер, max_tokens 900, stream:false, таймаут 30с) в «ПАМЯТКУ ПРЕДЫДУЩЕГО КОНТЕКСТА» (роль system). `createContextManager({settings, emit, planMode})` — фабрика с состоянием запуска: компакция выполняется ОДИН раз за запуск, памятка пере-прикрепляется между раундами (обрезка `trimConversation` её не теряет); при ошибке/маленькой голове/план-режиме — тихий фолбэк на обычную обрезку. Событие `ai:event {type:"compact"}` → плашка в чате (класс `.vision-note`, кейс `compact` в app.js).
  - **D. Пустой финальный ответ**: если раунд завершился без текста и без tool_calls (фри-модели при переполненном контексте) — один раз добавляется user-сообщение «напиши итоговый отчёт» и цикл продолжается (`reportRetried`); если и после этого пусто — в чат уходит честное сообщение «⚠ Модель не прислала итоговый текст…». `maxRounds` поднят 10 → 25 (план-режим 3). Кнопка «↩ Отменить изменения агента» при ошибке продолжает работать как раньше.
- Правая панель «Превью + Консоль» вместо нижней: `#side-panel` — слот справа от чата (460px, ресайзится полоской `.sp-resize` на левом крае, как у панели проекта). Сверху красивый сегментированный переключатель `.sp-switch`/`.sp-btn` (data-sp: preview/console). Кнопки шапки: `btn-toggle-preview` и `btn-toggle-console` (бывш. btn-toggle-terminal). Функции в app.js: `openSidePanel`/`closeSidePanel`/`switchSideTab`/`sidePanelVisible` (вкладки `sideTab`: "preview" | "console"). Логи dev-сервера теперь ДУБЛИРУЮТСЯ в консоль (`termServerAppend` → `.term-server`, янтарный цвет, ts-info/ts-err) — открыл «Консоль» и видишь живой вывод сервера + можешь вводить команды (терминал как был).
- Локальный self-update (OTA, вариант 3): агент может улучшать собственный код и обновлять приложение на ходу, без пересборки EXE.
  - `src/bootstrap.js` (НОВЫЙ, стабильный, НЕ трогать) — точка входа (`package.json main` теперь указывает на него). При старте: если в `<userData>/ota/current` есть `version.json` + `src/main.js` — грузит основной код ОТТУДА, иначе из app.asar. Фолбэк: если OTA-код не загрузился (агент сломал) — бандл переименовывается в `current.broken` и стартует установленная версия. Module-фолбэк: `Module._resolveFilename` — если OTA-код требует модуль вне своего дерева (electron-updater) — до-разрешает из node_modules приложения.
  - `src/ota.js` (НОВЫЙ, стабильный, НЕ трогать) — ядро self-update: `sources(settings)` (userData/ota + settings.otaDir + ota/ рядом с кодом), `findCandidate` (манифест с версией выше установленной), `applyBundle` (проверка sha256, распаковка base64-бандла, ПРЕФЛАЙТ синтаксиса всех JS через ELECTRON_RUN_AS_NODE, атомарный своп current → current.prev), `rollback` (prev → current + relaunch), `check` (не применяется при `global.__agentRunning`), `status`. Корень OTA переопределяется `AI_AGENT_OTA_ROOT` (для тестов).
  - `scripts/make-ota.js` (НОВЫЙ) — сборка бандла агентом/пользователем: `node scripts/make-ota.js [--out <папка>] [--version x.y.z]`. Собирает src/** + assets/** + package.json + server.js (исключая node_modules/.git/dist/build/ota/bin/.tmp-*), прогоняет node --check по всем .js (фейл = сборка прерывается), версия = --version || авто-бамп патча (если совпадает с последним манифестом) || package.json version. Пишет `ota/manifest.json` {app, version, builtAt, files, sha256} + `ota/bundle.json` {version, files:{rel: base64}}. Папка ota/ в .gitignore.
  - UI: Настройки → «🔄 Самосовершенствование (OTA)»: чекбокс `s-ota-enabled`, поле `s-ota-dir` (необязательный источник), `ota-status` (версия/папка/источники), кнопки `btn-ota-check` / `btn-ota-rollback` / `btn-ota-open`. IPC: `ota:status/check/rollback/openDir` (preload: otaStatus/otaCheck/otaRollback/otaOpenDir; мобильный мост подхватывает автоматически). Таймер: проверка через 5с после старта и каждые 60с (`ota.check` в whenReady). Правило 19 в SYSTEM_PROMPT: агент знает про self-update (после правок → node --check → make-ota).
- Инструменты ОС (Windows-фокус, 10 новых → всего 84): `listProcesses` (tasklist CSV / ps, парсер `parseProcessesCsv`), `killProcess` (taskkill /T + /F, pkill/kill; ЗАПРОС ПОДТВЕРЖДЕНИЯ — через `DANGEROUS_TOOLS` в цикле runAi), `clipboardRead`/`clipboardWrite` (Electron clipboard), `screenshotDesktop` (desktopCapturer: экран или окно по подстроке заголовка; показывает через `activeEmit {type:"image"}`), `registryRead` (PowerShell Get-ItemPropertyValue; whitelist чтения — только SOFTWARE/ENVIRONMENT/SYSTEM/SECURITY), `registryWrite` (New-ItemProperty; запись только HKCU\Software и HKCU\Environment + подтверждение), `openPath` (shell.openPath), `wingetSearch`, `installExe` (скачивает .exe → тихий запуск, подтверждение). Расширен `getSystemInfo`: Windows build/CPU/GPU/RAM/IP/диски (PowerShell CIM → `parseSysInfoJson`), winget list (количество + первые 10); на mac/linux — os.cpus/totalmem/networkInterfaces. WINGET_IDS расширен (~40 программ: bun, docker, ollama, vscode, chrome, postgresql, mysql и т.д.); `installSystemPackage` при отсутствии winget пробует choco, затем scoop; при неизвестном ID советует wingetSearch. Парсеры/whitelist — чистые функции в agent-core (тестируемые).
- Провайдер G4F (gpt4free, локальные бесплатные модели): пресет `g4f` в PRESETS (URL `http://localhost:1337/v1` — современный interference-API; старые сборки — 8080, label «G4F»), чип в настройках, подсказка `#g4f-hint` (видна только при выборе пресета — toggling в `setPreset`). Ключ не нужен: `apiHeaders` в agent-core добавляет `Authorization` только при непустом ключе. Модели грузятся обычной кнопкой ↻ (`/v1/models`). Запуск на ПК: `pip install -U g4f`, затем `g4f api` (современный interference-API — порт 1337, старые сборки — 8080).
- G4F: АВТО-ПОДБОР ПОРТА (почему у пользователя «молчал» G4F): пресет теперь указывает на 1337, а `probeG4fBase(configuredBase, timeoutMs)` в main.js ищет живой инстанс — сначала указанный URL, затем `http://localhost:1337/v1` и `http://localhost:8080/v1` (GET /models, таймаут 2.5с). IPC `g4f:probe` (preload: `g4fProbe`) — для рендерера. app.js: `probeG4fPort()` вызывается при выборе пресета G4F в `setPreset` и при открытии настроек с активным G4F (`syncG4fProviderBox`, троттлинг 30с через `g4fProbeLastTs`); если указанный URL не отвечает, а живой g4f найден — поле URL обновляется АВТОМАТИЧЕСКИ (только если в поле был localhost/127.0.0.1, чтобы не затирать туннель/сетевой адрес — иначе просто подсказка). В `g4f:test` при ошибке GET /models тоже идёт проба порта с конкретной подсказкой («живой g4f найден на … — поправь URL»).
- G4F: выбор провайдера в настройках (аккордеон «Провайдер G4F» под полем модели: поиск по буквам + список из ~42 провайдеров, ★ — стабильные без ключа/входа; клик вставляет маршрут «Провайдер:» в поле модели). У КАЖДОГО провайдера в реестре G4F_PROVIDERS (agent-core.js) есть `models` — типовые модели (офлайн-подсказки, 2–4 шт.). Клик по провайдеру: показывает чипы его моделей через `renderModelHints("openai", ...)` (клик по чипу дописывает модель после «Провайдер:») и параллельно `refreshG4fModels(name)` тихо дёргает `/v1/models` запущенного g4f. ВАЖНО: живой список НЕ ПОДМЕНЯЕТ реестровые модели — чипы СЛИВАЮТСЯ: сначала реестровые имена провайдера (реальные: DeepSeek-V3, Qwen…), затем алиасы от g4f (gpt-4o, default… — это глобальный каталог interference-API, у него нет разбивки по провайдерам; запрос {provider, model} матчится на стороне g4f). Дубликаты убираются, реестровые хранятся без префикса, живые — с префиксом «Провайдер:». Если g4f молчит — остаются только реестровые подсказки, ошибок в UI нет. renderModelHints показывает до 12 чипов. Гонки: `g4fModelReqSeq` — ответ применяется, только если провайдер не сменился. ЕДИНЫЙ реестр `G4F_PROVIDERS` теперь живёт в agent-core.js (экспорт; app.js берёт его оттуда же) — транспорт и UI не могут разойтись. Маршрут «Провайдер:модель» в `buildChatRequest` (openai) разбивается на отдельные поля: `provider: Провайдер` + `model: модель` без префикса — так требует современный g4f interference-API; если префикс не из реестра (например `deepseek/deepseek-r1:free` у OpenRouter) — имя не трогается. Клик по чипу модели в `renderModelHints` больше НЕ затирает «Провайдер:» — модель дописывается после двоеточия.
- G4F: кнопка «▶» у каждого провайдера в настройках — тест с логами в консоли: IPC `g4f:test` (main.js, главный процесс — нет CORS, видны сырые статусы/тела): 1) GET {base}/models (статус, кол-во, первые модели), 2) POST {base}/chat/completions с `provider` + первой типовой моделью провайдера (max_tokens 8, stream:false) — что провайдер РЕАЛЬНО отвечает («Зарегистрируйтесь…», ошибка, или текст ответа). Логи рендерятся в панель «Консоль» (`.term-server` + классы ts-ok/ts-warn/ts-err), панель открывается автоматически (`switchSideTab("console")`), вердикт — в сообщение настроек. В браузере/превью — заглушка «доступно в приложении на ПК». Мобильный мост подхватывает канал автоматически. preload: `g4fTest(opts)`.
- G4F: фикс «бесконечного думания» в `consumeProviderStream` (agent-core.js): (1) ошибки, которые провайдеры шлют ВНУТРИ SSE-стрима (`data: {"error":...}` — OpenAI-стиль, `{"type":"error"}` — Anthropic, NDJSON-ошибка — Ollama), теперь превращаются в исключение с текстом («Зарегистрируйтесь и повторите свой запрос» и т.п.) вместо молчаливого игнора → чат видит ошибку, а не висит; (2) таймауты: первый байт 90 с (`firstByteTimeoutMs`) и пауза между чанками 60 с (`idleTimeoutMs`) — зависший/молчащий провайдер завершается ошибкой; «первый байт» засчитывается только при реальных данных (не пустые keep-alive чанки).
- Фикс зависаний агента на dev-серверах (важно!): `SERVER_CMD_RE` в main.js распознаёт команды-серверы (expo start, npm/bun/yarn run dev|start|serve|watch|preview, vite (не build), next dev, node server.js, uvicorn, django runserver и т.п.). Поведение: `runCommand` при таймауте серверной команды возвращает подсказку «используй startBackground + checkUrl/checkPort + stopBackground»; `runCommandOutput` для серверных команд запускает через bgSpawn (сразу возвращает id, НЕ блокируется, НЕ убивает сервер по таймауту; waitFor ждёт маркер готовности через bgWaitFor). Причина бага «не смог убить порт»: `spawnCollect` при таймауте звал `child.kill()` — на Windows это убивает только cmd.exe, а node/expo-дети оставались сиротами и держали порт, при этом процесса не было в bgProcesses → stopBackground «не найден». Исправлено: `killProcessTree` (taskkill /T /F / группа процессов) + `detached` в spawnCollect; `devStop` дополнительно освобождает порт через `killProcessesOnPort` (netstat/lsof + taskkill), даже если процесс запускал агент. `parsePortFromUrl` берёт порт из settings.previewUrl.

## Инструменты (важно!)
- `str_replace` в этой среде **не находит текст дальше ~1100 строк файла** (глюк кэша). Для правок в хвосте больших файлов (`src/main.js`, `src/renderer/app.js`) использовать временный Node-скрипт с точными заменами (`.tmp-patch*.js`, писать через write_file, запускать `node`, потом удалять), после — `node --check`.
## Сохранённые OpenAI-подключения (несколько ключей) — 9 сентября 2026
- `settings.openaiProfiles` — массив `{ id, name, url, apiKey, model, project }`; `settings.openaiActiveProfile` — id активного; `settings.autoSwitchProfiles` — авто-переключение при ошибке.
- Хранение: `openaiProfiles` добавлен в `SECRET_KEYS` (secrets.js) — ключи шифруются (safeStorage/DPAPI), в settings.json их нет.
- Миграция: старые `openaiUrl`+`openaiApiKey` → первый профиль «p-main» (и в main.js normalizeSettings, и в app.js normalize) — только если `openaiProfiles` вообще не было.
- UI: `s-openai-profile` (select), кнопки `btn-profile-save` (💾 сохранить/обновить), `btn-profile-delete` (🗑), чекбокс `s-auto-switch` — в блоке openai-fields (index.html).
- Выбор профиля → `applyOpenaiProfile` заполняет поля URL/ключ/модель/проект (активный профиль зеркалится в openaiUrl/openaiApiKey — весь остальной код чата/теста не менялся).
- Авто-переключение: main.js catch авто-повтора runAi (только provider=openai, autoSwitchProfiles, ≥2 профилей с ключами) → `switchOpenaiProfile` по кругу → saveSettings → событие `profile_switched` → renderer показывает пометку в чате и перечитывает настройки (`api.getSettings`). Браузерный путь: `tryWebAutoSwitch` в webSend (счётчик webAutoSwitches — защита от бесконечного круга).

## OTA: кнопка «🗑 Сбросить OTA» — 9 сентября 2026
- Проблема: локально собранный OTA-бандл (scripts/make-ota.js → ota/ рядом с кодом) может быть нерабочим; bootstrap.js грузит код из userData/ota/current, а findCandidate применяет бандл с версией СТРОГО выше установленной — поэтому нерабочий бандл «переживает» переустановку кода с GitHub (папка ota/ рядом с кодом остаётся источником).
- Решение: `ota.reset(removeSource, settings)` в ota.js — удаляет userData/ota (применённый бандл) и, при removeSource=true, папку ota/ рядом с кодом. IPC `ota:reset`, кнопка «🗑 Сбросить OTA» в Настройки → Self-update (с confirmModal). После сброса — перезапуск приложения.
- Вручную: удалить ota/ рядом с кодом проекта и %APPDATA%/<AppName>/ota (userData) — или выключить чекбокс OTA в настройках.

## Версия 1.5.0 (OTA-бандл в репо) — 9 сентября 2026
- package.json version = 1.5.0 — выше любой локально накопленной версии сломанных бандлов («на тройке» — 1.3.x/1.0.3x).
- ota/manifest.json + ota/bundle.json (рабочий бандл из актуального кода) коммитятся в репо (.gitignore: ota/* с исключениями !ota/manifest.json !ota/bundle.json).
- Механика: OTA применяет бандл, если manifest.version СТРОГО выше установленной (userData/ota/current/version.json). 1.5.0 > любая сломанная 1.x.y < 1.5 → применится поверх без ручной чистки.
- Пересобрать бандл вручную: node scripts/make-ota.js [--version X.Y.Z].

## Настройки: вкладки + аккордеон провайдеров — 9 сентября 2026
- Вкладки (.stab / .settings-tab-body): Модель, Зрение, Проект и GitHub, Мобильный, Секреты, Self-update. Кнопки «Проверить подключение»/«Сохранить» — в общем футере .settings-footer (видны всегда). Открытие настроек → вкладка «Модель» (showSettingsTab).
- Провайдеры — аккордеон (.acc[data-acc]): setProviderUI раскрывает карточку активного провайдера (бейдж «✓ активен»), клик по заголовку (.acc-head) раскрывает/сворачивает вручную без смены выбора.
- Все id элементов настроек сохранены — JS не ломался (проверено скриптом: отсутствует только динамический #file-editor).
- OTA-бандл пересобран в 1.5.1 (после 1.5.0) — новый UI доедет до ПК поверх сломанной версии.

## Панель действий агента над полем ввода — 9 сентября 2026
- ensureWorkGroup теперь вставляет панель «Выполняю действия» в #work-panel (между #typing и #input-bar), а не в ленту #messages. Новый запуск очищает панель (одна панель за раз).
- Осталось в ленте: размышления (thinking), текст ответа, ошибки; действия (инструменты, правки кода) — в живой панели над полем ввода.
- Стили: #work-panel (padding, flex-shrink:0), карточка max-height 240px + скролл при развороте.
- OTA-бандл: 1.5.3.

## Кликабельные ссылки в чате — 9 сентября 2026
- markdown.js inline(): голые URL (https?://...) теперь автолинкуются (с обрезкой хвостовой пунктуации .,;:!?)]), markdown-ссылки [text](url) — как раньше.
- main.js: setWindowOpenHandler + will-navigate на mainWindow — http(s) открываются в браузере пользователя (shell.openExternal), а не в новом окне Electron.
- Стили .bubble.md a уже были (цвет + underline).
- OTA-бандл: 1.5.4.

## Пресеты провайдеров — в аккордеон — 9 сентября 2026
- Блок чипов «Провайдер» внутри карточки OpenAI-совместимых обёрнут в мини-аккордеон (.mini-acc, data-acc-head="presets"): свёрнут по умолчанию, раскрывается кликом. Обработчик аккордеона: карточки провайдеров выбирают/сворачивают, вложенные блоки — просто toggle.
- OTA-бандл: 1.5.5.

## Жёсткое отключение OTA (bootstrap) — 9 сентября 2026
- Проблема: bootstrap.js грузит main.js из userData/ota/current, ЕСЛИ там валидный бандл — старый OTA-код перекрывает новый код из папки/EXE, даже после пересборки.
- Фикс: bootstrap.js теперь читает settings.json из userData — при otaEnabled === false грузит код ТОЛЬКО из установки (ASAR_DIR), игнорируя current.
- Порядок действий пользователя: Настройки → Self-update → снять «Разрешить локальные обновления на ходу» → Сохранить → запустить собранный EXE из нового кода. Или удалить %APPDATA%\<AppName>\ota (кнопка «🗑 Сбросить OTA»).
- OTA-бандл: 1.5.6 (обновлённый bootstrap.js попадёт и в current при следующем применении).

## OTA: главное правило версий (1.5.7)

Проблема: свежескачанный код не загружался — bootstrap.js брал применённый
бандл из userData/ota/current всегда, когда OTA не выключен в настройках,
даже если бандл старее установленного кода.

Решение (src/bootstrap.js):
- Бандл грузится ТОЛЬКО если его версия СТРОГО НОВЕЕ установленной
  (package.json рядом с кодом / app.asar). Свежий код всегда побеждает
  устаревший бандл, вручную ничего удалять не нужно.
- Если бандл есть, но не новее установленного — он автоматически удаляется
  (не висит мёртвым грузом и не путает панель Self-update).

Дополнительно (src/ota.js): findCandidate тоже пропускает бандлы не новее
установленной версии приложения — обновление не накатывается по кругу.

Проверка: versionGt согласован в обоих файлах (1.5.7>1.5.6 ✓, равенство ✗,
1.10>1.9 ✓, мусор ✗). Бандл v1.5.7 собран (17 JS проверены).

## Yandex Cloud (1.5.8): хостинг и инфраструктура из приложения

Интеграция с Yandex Cloud REST API (чистый Node, без yc CLI):
- **src/yandex-cloud.js** (новый модуль): OAuth-токен → IAM-токен (кэш, авто-обновление ~12 ч);
  эндпоинты грузятся динамически с https://api.cloud.yandex.net/endpoints (фолбэк — известные адреса);
  списки ресурсов по 13 сервисам (API Gateway, Certificate Manager, CDN, DNS, Logging, Postbox,
  Container Registry, IAM, Lockbox, YDB, Object Storage, Serverless Containers, VPC);
  создание (ydb, lockbox, containerRegistry, storage, dns, serverlessContainers, vpc) и удаление
  с ожиданием операции (/operations/{id}).
- **Авторизация**: OAuth-токен (тот же, что у yc CLI) → secrets.json (зашифрованно), кнопка
  «🔑 Получить токен» открывает oauth.yandex.ru. Первый каталог выбирается автоматически.
- **UI**: вкладка «☁️ Yandex Cloud» в настройках (токен, каталог, разрешения агента);
  вкладка «Cloud» в правой панели (рядом с Превью/Консоль) — дашборд-сетка карточек
  13 сервисов с живыми счётчиками, клик по карточке — список ресурсов, «＋ Создать», «🗑» с подтверждением.
- **Агент**: инструменты ycStatus / ycList / ycCreate / ycDelete (TOOL_DEFINITIONS + промпт №28).
  Создание/удаление агентом — только при включённых чекбоксах разрешений (по умолчанию выключены).
  Платные ресурсы — только по явной просьбе пользователя. В веб-версии — заглушка «только в desktop».
- Файлы: src/yandex-cloud.js (новый), src/secrets.js, src/main.js (IPC yc:* ×9, инструменты ×4),
  src/preload.js, src/renderer/agent-core.js, src/renderer/app.js, src/renderer/index.html,
  src/renderer/styles.css, package.json (1.5.8), ota/ (бандл).
- Postbox управляется через AWS-совместимый API (в списке эндпоинтов отсутствует) —
  карточка дашборда честно покажет «API недоступно», создание адреса — в консоли Yandex Cloud.

## Yandex Cloud этап 2 (1.5.9): деплой, сводка, статусы/логи, ycDeploy

- **Деплой одной кнопкой**: вкладка Cloud → «🚀 Задеплоить проект» (рабочая директория).
  Конвейер: Dockerfile (свой или сгенерированный по типу: node/python/статика) → docker login
  cr.yandex (IAM) → docker build → push в Container Registry (реестр создаётся сам) →
  Serverless Container (создаётся/обновляется) → публичный доступ (SA + роль
  serverless.containers.invoker на каталог через updateAccessBindings) → deployRevision →
  URL контейнера. Прогресс шагов живой (событие yc_step), результат — URL + кнопка «Открыть».
- **Облако в цифрах**: сводка над дашбордом — всего ресурсов и сервисов с ресурсами.
- **Статусы и логи**: в списке контейнеров — бейдж статуса (ACTIVE/CREATING/ERROR/DELETING),
  кнопка «↗» (открыть URL) и «📜» (логи через yc CLI: yc logging read; Logging REST для
  чтения не существует — только gRPC/CLI; без yc — подсказка).
- **Вход по коду (device flow)**: для Yandex Cloud требует регистрации собственного
  OAuth-приложения с device flow (публичный client_id yc CLI его не поддерживает) —
  сделана быстрая альтернатива: кнопка «📋 Вставить» из буфера обмена рядом с токеном.
- **Инструменты агента**: ycDeploy (directory, name, public) — деплой проекта из чата;
  ycLogs (service, id) — логи контейнера. Промпт №28 дополнен. ycDeploy требует
  «Разрешить агенту создавать ресурсы» (реестр/контейнер/SA) — платный.
- Файлы: src/yandex-cloud.js (деплой-хелперы), src/main.js (yc:deploy/yc:logs,
  ycGenerateDockerfile, total/activeServices), src/preload.js, src/renderer/agent-core.js,
  src/renderer/app.js (деплой UI, сводка, статусы, вставка из буфера),
  src/renderer/index.html, src/renderer/styles.css, package.json (1.5.9), ota/ (бандл).

## ВКонтакте: гайд и поддержка (1.5.10)

- **Справочник агента** `src/agent-guides/vk.md` (полный гайд по фронту ВК:
  роутинг, поиск людей, профиль, диалоги, селектор [role="textbox"], Enter-отправка,
  ленивая загрузка, дубликаты, vk.com/vk.ru). Читается агентом по требованию:
  readFile(path: "agent-guide:vk") — хук в main.js (executeTool), не раздувает контекст.
- **Промпт №29 «ВКонтакте»**: маршруты, contenteditable-поле, порядок
  click→fill→Enter, ожидание и перечитывание, уточнение дубликатов, вход вручную.
- **browserFill улучшен**: при сбое page.fill автоматически делает клик по полю →
  Ctrl+A (очистка) → keyboard.insertText (корректно триггерит события ввода в
  contenteditable/SPA — ВК и аналоги). Возвращает способ вставки (fill/insertText).
- Файлы: src/agent-guides/vk.md (новый), src/browser-tools.js (fallback fill),
  src/main.js (agent-guide:* хук), src/renderer/agent-core.js (промпт №29),
  package.json (1.5.10), ota/ (бандл).

## Анализ переписок + фундамент для КП (1.5.11)

- **Методология** `src/agent-guides/chat-analysis.md` (новый справочник, читается
  через readFile(path: "agent-guide:chat-analysis")): определение человека по уликам
  (коллега/начальник/друг/родственник/клиент/поставщик), суть переписки (2–4 предложения),
  формат-таблица «Человек | Кто он | Суть | Важность | Следующий шаг»,
  профиль клиента (потребность, бюджет/сроки, возражения, тон) + фундамент для КП
  (2–4 пункта, следующий шаг, аргументы из его слов). Длинные истории — частями (PageUp + browserText).
- **Промпт №30 «Анализ переписок»**: краткий алгоритм + ссылки на справочники
  (chat-analysis, vk). Применяется к ВК, чатам, письмам, файлам.
- Файлы: src/agent-guides/chat-analysis.md (новый), src/renderer/agent-core.js (промпт №30),
  package.json (1.5.11), ota/ (бандл).

## ВК: боевой опыт (1.5.12)
- Гайд `src/agent-guides/vk.md` обновлён полным опытом из песочницы: al_im.php-редирект,
  работа только в существующей вкладке (новые — без сессии), browserText вместо скриншотов,
  фильтр левого меню, сценарий анализа переписок.
- Добавлена таблица известных контактов (Евгения Пимашина, Online_заявки, Дмитрий Соболев,
  Сергей Бухтеев) и бизнес-контекст (Бумеранги-Тула / Positive-store / BMGBRAND;
  пользователь — Михаил Пимашин). Используется для быстрого определения типа отношений
  и подготовки КП клиентам (чат Online_заявки — основной канал входящих).
- Пункт 29 промпта дополнен боевыми правилами ВК.

## Похудение промпта (1.5.13)
- Пункты 28–30 (Yandex Cloud / ВК / анализ переписок) сжаты: 3732 → 2174 символа.
- Весь промпт: ~19.3k → ~17.7k символов. Детали — в agent-guides (vk.md, chat-analysis.md),
  читаются по требованию, в контексте не висят.

## Serper — усиленный поиск для агента (1.5.14)
- Новое поле в Настройках → 🔒 Секреты → «🔎 Поиск для агента»: Serper API-ключ (хранится зашифрованно в secrets.json).
- webSearch: при наличии ключа идёт в Google через Serper (10 результатов, ru), иначе — прежний DuckDuckGo.
- Ошибки (403 неверный ключ, таймаут, HTTP) сообщаются понятным текстом.
- Файлы: src/secrets.js (serperApiKey в SECRET_KEYS), src/main.js (DEFAULT_SETTINGS + webSearch case + импорт),
  src/renderer/agent-core.js (webSearchSerper + webSearch), src/renderer/{index.html,app.js} (поле и его сохранение).

## Умное переключение ключей (1.5.15)
- Проблема: авто-переключение профилей срабатывало на ЛЮБУЮ ошибку (включая 400, контент, сеть)
  и не имело пауз — лишние ротации ключей, риск «долбления» провайдера.
- Решение: классификатор classifyKeyError (agent-core.js, общий для desktop и web):
  переключаем ключ только на 401/403 (неверный ключ, кулдаун 10 мин), 402/insufficient_quota
  (баланс, 5 мин), 429/rate limit (лимит, 1 мин). Ошибки запроса/контента/сети ключ не меняют.
- Cooldown на профиль (main.js: profileCooldown; app.js: webProfileCooldown): провинившийся
  ключ пропускается, пока не отлежится. Если все в кулдауне — переключения нет.
- UI-подсказка у чекбокса «Авто-переключение» обновлена (умное поведение + напоминание
  использовать свои аккаунты, не обходить лимиты бесплатного тарифа).
- Тесты: 18/18 (классификатор + switchOpenaiProfile с cooldown на реальном коде).


## 1.5.16 — удобства из Replit: статус-бар, вкладки файлов с подсветкой, палитра команд

### Статус-бар (низ окна)
- index.html: `#status-bar` после `#app`; `body` стал flex-колонкой, `#app` — `flex:1; height:auto`.
- app.js: `updateStatusBar()` (проект, ветка, счётчик изменений, dev-сервер+порт, модель, версия).
  Хуки: refreshProject/refreshCommits/refreshChanges/refreshProjects/setPreviewStatus/updateBadge/renderOtaStatus.
- Клики: проект/изменения → панель проекта, dev-сервер → превью, модель → попап моделей, версия → Настройки → Self-update.
- `renderOtaStatus()` теперь вызывается и на старте (версия видна сразу, а не после захода в настройки).

### Файлы: вкладки + подсветка + редактор
- Новый модуль `src/renderer/highlight.js` (`window.Highlight`): подсветка без зависимостей
  для js/ts, json, html/xml, css, python, shell, sql, yaml, markdown; гарантия — при снятии тегов
  текст совпадает с исходным (проверено тестом).
- `openFiles` + `#file-tabs`: несколько файлов открыто одновременно, активная вкладка,
  точка «есть несохранённые правки», закрытие крестиком, авто-выбор соседней вкладки.
- Чтение: нумерация строк (sticky-гаттер) + подсветка в `<pre class="code-pre">`.
- Правка: `textarea` прозрачным текстом поверх подсвеченного слоя (те же метрики шрифта/строки),
  синхронизация скролла, живая нумерация, Tab = 2 пробела, Ctrl+S = сохранить.
  Кнопка ✨ в шапке включает/выключает подсветку; для файлов >150 КБ подсветка выключается сама.
- Удаление файла/папки закрывает и их вкладки (`closeTabsUnder`).

### Палитра команд (Ctrl+K)
- Новая панель `#palette-overlay` + `paletteActions()`: чат, файлы, git/GitHub, запуск и хостинг,
  настройки (все вкладки), проверка подключения. Фильтр по подстроке, группы, ↑↓/Enter/Esc.
- Ctrl+K — палитра, Ctrl+P — быстрый переход по файлам проекта, Ctrl+Shift+K — прежний поиск по чатам.
- `collectProjectFiles()` обходит проект по `fs:listTree` (лимит 1200 файлов, пропускает node_modules/.git/dist/…).

### Заодно
- Убран битый вызов `updateCtxIndicator` (функции в коде не было — каждый рендер чата сыпал ошибку в консоль).
  Сам индикатор контекста в разметке есть (#ctx-indicator), логика так и не была написана — кандидат на следующий шаг.

### Проверки
- `node --check` — чисто; сверка всех 272 id app.js ↔ index.html; все CSS-классы и токены на месте.
- Подсветка: 14 языков, round-trip текста — ок.
- UI-прогон на реальной странице (jsdom, 54 проверки): статус-бар, палитра, вкладки, подсветка, редактор, dirty-метка — всё зелёное.
- Осталось непроверенным: точное выравнивание слоёв редактора «на глаз» (метрики совпадают, но визуально надо глянуть).

## 1.5.17 — Yandex Cloud стало видно: кнопка «☁️» в шапке и экран-подсказка

Проблема: дашборд ресурсов жил только во вкладке «Cloud» правой панели, а кнопки для неё в шапке не было —
открыть можно было лишь через «Консоль/Превью» и потом клик по вкладке. При отсутствии токена панель была пустой.

- index.html: в шапку добавлена кнопка **#btn-toggle-cloud** («☁️» + точка состояния #btn-toggle-cloud-dot).
- app.js: клик по ней открывает/закрывает правую панель именно на вкладке Cloud (как «Консоль»/«Превью»),
  активное состояние кнопки синхронизировано в openSidePanel/closeSidePanel.
- Точка состояния: зелёная — токен и каталог готовы, жёлтая — нужен каталог/IAM, пустая — не подключено
  (ycSetHeaderDot из ycRefreshSettingsUI и ycLoadDashboard).
- Дашборд без токена больше не пустой: новый блок **#yc-onboard** — что даёт интеграция, 3 шага,
  кнопки «⚙️ Настройки Yandex Cloud» и «🔑 Получить токен» (общая функция ycOpenTokenPage).
- Настройки → «☁️ Yandex Cloud»: кнопка **#btn-yc-open-dash** «Открыть дашборд» (закрывает настройки и открывает панель).
- Веб-версия: в дашборде и в настройках честно написано, что управление облаком работает в desktop-приложении.

### Проверки
- UI-прогон на реальной странице (jsdom, 25 проверок, три сценария: подключено / без токена / веб) — всё зелёное.
- `node --check` — чисто; сверка id app.js ↔ index.html — ок; smoke-тесты 61/61.
- OTA-бандл 1.5.17 собран, файлы в бандле идентичны текущим.

## 1.5.18 — переписка больше не пропадает при внезапном закрытии

Проблема: чат писался на диск только в начале и в конце хода. Если закрыть приложение
посреди ответа агента, весь уже полученный текст и действия терялись. Дополнительно:
`fs.writeFileSync` не атомарен — закрытие во время записи могло оставить обрезанный
chats.json, и при следующем старте история выглядела как «всё удалилось».

- **main.js — атомарная запись**: пишем в `chats.json.tmp`, затем подмена через `fs.renameSync`
  (с откатом на copyFileSync для залоченного на Windows файла). Предыдущая версия сохраняется
  как `chats.json.bak`.
- **main.js — восстановление**: `loadChats()` читает основной файл, а при повреждении JSON
  поднимает историю из `.bak`. Раньше битый файл молча превращался в пустую историю.
- **main.js + preload.js — синхронный канал `chats:saveSync`** (`ipcRenderer.sendSync`):
  renderer успевает записать данные при закрытии окна (асинхронный invoke мог не дойти).
- **app.js — автосохранение во время ответа**: `persistChatsSoon()` (throttle 1.5 c) вызывается
  на каждом чанке текста, размышлении, старте/результате действия и перезаписи сегмента.
  `persistChatsNow()` — немедленная запись в конце хода (отменяет отложенную).
- **app.js — сброс на диск** по `beforeunload`, `pagehide` и `visibilitychange → hidden`
  (в мобильном режиме синхронного канала нет — там используется обычный путь).
- **app.js — `sanitizeChats()` при загрузке**: снимает флаги `pending` с незавершённых сообщений
  (иначе после перезапуска висел вечный индикатор «выполняется»), незавершённым действиям
  дописывает пояснение, а в активном чате один раз добавляет пометку «ответ был прерван».

### Проверки
- smoke-тесты: **72/72** (добавлено 11 постоянных: атомарность записи, восстановление из .bak,
  битый JSON, throttle, синхронный сброс при закрытии, отсутствие лишних записей,
  `sanitizeChats` на прерванной истории и на целой истории, битые данные).
- Логика проверяется на реальном коде из `main.js`/`app.js` (срезы файлов + заглушки окружения).
- OTA-бандл **1.5.18** собран; 27 файлов сверены с диском побайтово — расхождений нет.

## 1.5.20 — постоянный профиль браузера, индикатор контекста, «Дописать ответ»

Серия из трёх улучшений «удобства как в Replit», начатая с самых болезненных мест.

- **browser-tools.js — постоянный профиль браузера.** `launchBrowser()` перешёл на
  `chromium.launchPersistentContext(userData/browser-profile)` — куки, localStorage и авторизации
  сохраняются между запусками приложения (сессии ВК и сайтов больше не слетают).
  Так как у `BrowserContext` нет `isConnected()`, появился `sessionAlive()` (для Browser —
  `isConnected`, для контекста — отсутствие события `close`). При смене настройки профиля
  работающая сессия перезапускается (`runningProfileDir`), стартовая пустая вкладка
  переиспользуется, а не дублируется. Добавлены `setProfileDir/profilePath/clearProfile`.
- **main.js/preload.js — управление профилем**: настройка `browserProfile` (по умолчанию вкл.),
  каналы `browser:profileInfo` / `browser:clearProfile`, инструмент агента `browserClearProfile`.
- **index.html/app.js — секция «🌐 Браузер агента»** в «Проект и GitHub»: тумблер постоянного
  профиля, состояние (папка/пусто) и кнопка «🧹 Очистить профиль (выйти со всех сайтов)».
- **main.js/app.js — индикатор контекста** (разметка `#ctx-indicator` была, логики не было):
  `emitContext()` шлёт `{type:"context", used, budget, percent}` после обрезки истории и между
  раундами, `renderContext()` рисует полоску (жёлтая ≥75%, красная ≥92%).
- **app.js — «↻ Дописать ответ»**: прерванный ответ (после аварийного закрытия) помечается
  `interrupted: true`, в сообщении появляется кнопка, которая продолжает работу тем же путём,
  что и обычная отправка (в историю уходит прозрачная просьба дописать, не начиная заново).

### Проверки
- browser-tools: 21 проверка на реальном коде с подставным playwright (persistent-запуск,
  папка профиля, `status`, очистка, перезапуск сессии при смене настройки, обычный режим без профиля).
- smoke-тесты: **81/81** (+9 постоянных: профиль браузера, отрисовка индикатора контекста,
  связность разметки/preload/обработчиков, кнопка «Дописать ответ»). Индикатор проверяется
  на реальном коде из `app.js` (срез + простой DOM).
- `node --check` по всем изменённым файлам — чисто; сверка id app.js ↔ index.html — чисто.
- OTA-бандл **1.5.20** собран; 27 файлов сверены с диском побайтово — расхождений нет.

## 1.5.22 — менеджер паролей сайтов (агент входит на сайты сам)

Часть серии «удобства как в Replit», этап 2 из плана. Главный принцип безопасности:
**пароль никогда не попадает в чат, историю и контекст модели** — он уходит напрямую
из зашифрованного хранилища в браузер.

- **`src/vault.js` (новый модуль, чистый — без electron и без диска):** `normalizeEntry`
  (обрезка, вырезание переводов строк из пароля, отбрасывание мусора и записей без
  имени/адреса), `sanitizeList` (дедупликация по id, лимит 100), `findEntry`
  (точное имя → точный хост → вхождение), `listText` (текст агенту БЕЗ паролей,
  только «пароль: сохранён/не сохранён»), `notFoundText`, `fillLogin` (подстановка логина
  и пароля через переданные браузерные примитивы: `bt.fill/login`, `bt.fill/password`,
  опционально `submit` → Enter; понятные ответы на все сбои).
- **secrets.js:** `sitePasswords` добавлен в `SECRET_KEYS`; объекты-секреты вынесены
  в `OBJECT_KEYS` + `isObjectKey()` (agentEnv / openaiProfiles / sitePasswords) —
  сериализуются в JSON и шифруются в `secrets.json` (safeStorage/DPAPI).
- **main.js:** настройка `sitePasswords: []`, чистка списка в `normalizeSettings`,
  инструменты агента **`vaultList`** (сайты без паролей) и **`vaultFill`** (подстановка входа).
  Добавлена **защита от затирания**: если сохранение настроек пришло без массива
  `sitePasswords` (старый интерфейс / мобильный клиент) — берём предыдущее значение.
- **agent-core.js:** описания обоих инструментов, их имена в списке, алиасы
  (`vault_list`/`vault_fill`), и переписан абзац промпта: пароли брать из менеджера,
  **НИКОГДА не просить пароль в чате**, при отсутствии записи — попросить войти руками
  в окне браузера (профиль запомнит сессию) и предложить добавить запись в настройках.
- **index.html/app.js/styles.css:** секция «🔑 Пароли сайтов» в Настройках → 🔒 Секреты:
  список записей (пароль показывается только маской `••••••`), форма (название, адрес,
  логин, пароль с глазком, заметка), 💾 Сохранить / Очистить форму, ✏️ загрузить в форму,
  🗑 удалить с подтверждением, Enter в любом поле сохраняет. Запись в форме не показывает
  сохранённый пароль — правка требует ввести пароль заново.

### Проверки
- `vault`: 41 проверка логики (нормализация, поиск, отсутствие утечек пароля в текст для
  агента, все ветки `fillLogin` — submit, частичный вход, ошибки браузера, нет логина/записи).
- интерфейс: 30 проверок на реальном коде `app.js` (срез блока паролей + мини-DOM):
  валидация, обрезка полей, маска пароля в списке, правка без подстановки пароля, удаление,
  устойчивость к `sitePasswords: null`.
- `secrets`: round-trip `sitePasswords` через шифрование (в файле нет ни адреса, ни пароля).
- smoke-тесты: **95/95** (+14 постоянных для vault и его интерфейса).
- `node --check` по всем изменённым файлам — чисто; сверка id app.js ↔ index.html — чисто
  (новые 9 id на месте, поле пароля — `type="password"`).
- OTA-бандл **1.5.22** собран; 28 файлов (включая новый `src/vault.js`) сверены с диском
  побайтово — расхождений нет.

## 1.5.23 — вход на сайты с жёсткими проверками (Gmail и подобные)

Версия включает всё из 1.5.22 (менеджер паролей) плюс правку запуска браузера.

Вопрос пользователя: Chromium агента блокируется на входе в Gmail («этот браузер может
быть небезопасен»). Причина — следы автоматизации, которые видит Google:
флаг `--enable-automation` (он же плашка «управляется автоматизированным ПО»)
и `navigator.webdriver = true`.

- **browser-tools.js:** в `launchEngine` добавлены документированные опции Playwright:
  `ignoreDefaultArgs: ["--enable-automation"]` и
  `args: [..., "--disable-blink-features=AutomationControlled"]`.
- Это **не обход защит сайтов**: капча, 2FA и проверка пароля остаются на месте,
  вход делает сам пользователь своими данными. Убираются только те признаки,
  которые браузер афиширует о себе без необходимости.
- Гарантии нет: Google может блокировать и после этого. Надёжный путь для почты —
  IMAP/SMTP (этап 5), вообще без браузера; для этого нужен пароль приложения.

### Проверки
- smoke-тесты: **96/96** (+1: проверка, что флаги скрытия автоматизации реально
  передаются в запуск, а браузер остаётся видимым `headless: false`).
- OTA-бандл **1.5.23** собран (`--version 1.5.23`, без авто-бампа — чтобы версия
  в `package.json` и в бандле совпадала); 28 файлов сверены с диском побайтово.

## 1.5.25 — Yandex Cloud: логи без внешнего CLI, токен в окружении, встроенный yc

### Зачем
Песочница упиралась в две вещи: `ycLogs` требовал внешний `yc` (в песочнице его нет,
а `yc init` интерактивный — нужен человек с браузером), а токен Yandex Cloud был «заперт»
в настройках приложения и не доходил до команд агента.

### Что сделано
- **src/yc-logs.js (новый):** чтение Cloud Logging БЕЗ внешнего CLI. Разобрался, почему
  «просто REST» не работает: у `LogReadingService` нет HTTP-привязки (метод только gRPC),
  поэтому лог-группы берутся по REST (`GET /logging/v1/logGroups`), а записи — по gRPC
  (`POST /yandex.cloud.logging.v1.LogReadingService/Read`) на встроенном `http2`
  со своим минимальным protobuf. Ни одной новой зависимости — обновление доезжает по OTA.
- **src/yc-cli.js (новый):** официальный `yc` скачивается в `{userData}/bin` (схема из
  install.sh: `/release/stable` → `/release/{ver}/{os}/{arch}/yc`), пишется через `.tmp`
  + `rename`, nедокачанный файл никогда не занимает место рабочего бинаря. Системных прав
  не требует, папка добавляется в PATH всех команд агента.
- **main.js:** `agentEnv` разделён на `userAgentEnv` (то, что задал пользователь — только
  это и сохраняется в настройках) и автоматические переменные Yandex Cloud:
  **YC_TOKEN / YC_CLOUD_ID / YC_FOLDER_ID** (функция `ycAutoEnv`, сборка в `applyAgentEnv`).
  Теперь `yc` работает без `yc init`. `ycEnsurePath()` подмешивает `{userData}/bin` в PATH.
  Инструмент **ycInstall** + IPC `yc:cliStatus` / `yc:installCli`; `ycLogs` (инструмент и
  IPC `yc:logs`) переведён на `readYcLogsText` → `yc-logs.js`. Вызовы внешнего
  `yc logging read` и поиск `yc` в PATH удалены полностью.
- **envSet/envUnix/envList:** пользовательские переменные пишутся отдельно, автоматические
  YC-переменные в `envList` помечаются «[авто: Yandex Cloud]», а `envUnset` не даёт удалить
  их вручную (значения по-прежнему не выводятся в чат — только имя и длина).
- **agent-core.js:** описание ycLogs (внутренний API, обязателен только `id`, есть
  `sinceHours`/`limit`), новый инструмент ycInstall, правило 28 в промпте.
- **index.html + app.js:** в настройках Yandex Cloud — кнопка «⬇️ Установить yc CLI»,
  статус (встроен / не установлен) и пояснение, что `yc init` не нужен.
- **preload.js:** мост `ycCliStatus` / `ycInstallCli`.

### Проверки
- smoke-тесты: **112/112** (+11 постоянных): протобаф ReadRequest/ReadResponse, разбор
  уровня/ресурса/времени, кадры gRPC, **живой gRPC-обмен по http2** (REST-группы + Read,
  проверка `Bearer` и пути метода), понятные ошибки (403 / нет групп / нет каталога),
  платформа и адреса бинаря yc, установка с подставным fetch, отказ на недокачанном файле,
  инъекция YC_TOKEN/YC_CLOUD_ID/YC_FOLDER_ID, **поведенческая проверка readYcLogsText на
  реальном коде main.js** (какой запрос уходит и как форматируется ответ), отсутствие
  вызовов внешнего CLI, связка инструменты ↔ промпт ↔ preload ↔ main ↔ HTML.
- `node --check` по всем изменённым файлам — чисто; сверка id app.js ↔ index.html — новые
  id (`btn-yc-install-cli`, `yc-cli-status`) на месте.
- OTA-бандл **1.5.25** собран; файлы сверены с диском побайтово.

## 1.5.24 — почта: отправка КП и коды подтверждения (SMTP/IMAP)

Версия включает всё из 1.5.23 плюс новую интеграцию почты.

Зачем: агент должен уметь (а) читать коды подтверждения при регистрации на сайтах и
(б) отправлять коммерческие предложения клиентам. Через браузер это плохо получается
(Google блокирует вход из автоматизированного браузера), поэтому работаем с ящиком
напрямую — по SMTP (отправка) и IMAP (чтение). Никаких внешних библиотек: только
встроенные модули node (net/tls), чтобы обновление доезжало по OTA без `bun install`.

- **src/mail.js (новый):** пресеты провайдеров (Gmail, Яндекс, Mail.ru, Outlook, Rambler)
  и их серверы; `buildMessage` (тема RFC 2047, тело base64, защита от CRLF-инъекции);
  `sendMail` (неявный TLS 465 или STARTTLS 587, AUTH LOGIN, MAIL FROM/RCPT TO/DATA);
  `listRecent` (IMAP LOGIN/SELECT/UID SEARCH/UID FETCH, разбор MIME: multipart,
  base64, quoted-printable); таблицы windows-1251 и koi8-r; `extractCode`
  (код подтверждения: числа 4–8 знаков рядом со словами «код/code/подтвержд»,
  годы и телефоны отсеиваются).
- **secrets.js:** `mailPassword` в `SECRET_KEYS` → пароль приложения шифруется
  (DPAPI/safeStorage), как остальные секреты.
- **main.js:** настройки `mailAddress/mailUser/mailFromName/mailImapHost/mailImapPort/
  mailSmtpHost/mailSmtpPort/mailStarttls/mailAllowAgentSend`, функция `mailConfig`
  (пустые серверы берёт из пресета), инструменты агента **mailSend / mailList / mailCode**,
  IPC `mail:test` (проверка входа), `mail:recent` (последние письма), `mail:testSend`
  (тестовое письмо себе). Отправка агентом по умолчанию ЗАПРЕЩЕНА (`mailAllowAgentSend`),
  как и push в GitHub. Защита: сохранение без ключа `mailPassword` не стирает пароль.
- **preload.js:** мост `mailTest / mailRecent / mailTestSend`.
- **app.js + index.html + styles.css:** вкладка «✉️ Почта» в настройках: адрес, пароль
  приложения (с глазком), имя отправителя, серверы IMAP/SMTP, кнопка «Определить по адресу»,
  чекбокс STARTTLS, чекбокс «Разрешить агенту отправлять письма», кнопки «Проверить связь»,
  «Тестовое письмо», «Последние» (список писем с найденными кодами).
- **agent-core.js:** определения mailSend/mailList/mailCode, алиасы (email/send_mail/inbox/
  mail_code и др.) и правило 31 в системном промпте: начинать с mailList, перед отправкой КП
  клиенту показывать текст и спрашивать подтверждение, пароль в чате не просить.

### Проверки
- Ядро `mail` отдельным прогоном: **34/34** (пресеты, письмо и защита от инъекции,
  реальная SMTP-сессия против поддельного сервера, только что найденный и исправленный
  баг: таблица CP1251 была без кириллицы 0xC0–0xFF — теперь письма в windows-1251
  читаются, заголовок/отправитель/тело; IMAP-сессия и разбор MIME; эвристика кода).
- smoke-тесты: **101/101** (+5 постоянных про почту, включая проверку связки
  инструменты ↔ промпт ↔ preload ↔ main ↔ настройки ↔ HTML).
- `node --check` по всем изменённым файлам — чисто; сверка id app.js ↔ index.html —
  все id почты на месте.
- OTA-бандл **1.5.24** собран; файлы сверены с диском побайтово.


## 1.5.26 — браузер «понимает» кнопки: карта страницы вместо перебора селекторов

Было: агент угадывал селекторы (page.click("text=Войти"), .btn, #submit…) — на незнакомой
странице это превращалось в перебор и в ошибки «элемент не найден».

- **src/dom-map.js (НОВЫЙ, чистая логика — тестируется без браузера):** `normText`,
  `roleOf` (button/link/textbox/checkbox/combobox/menuitem…), `accessibleName`
  (labelledby → aria-label → <label> → текст/value → placeholder → title → alt → name → id),
  `isInteractive`, `refName`/`refSelector` ("12"/"e12"/"#e12" → `[data-agent-ref="e12"]`),
  `parseQuery` (для полей `text` — это ЗНАЧЕНИЕ, а не поисковый текст; `cleanQueryText`
  снимает «ёлочки» в именах), `findMatches` (точное имя 100, имя внутри запроса 88,
  общие слова 40–60), `formatSnapshot`, `suggestText`, `actionHint`.
- **src/browser-tools.js:** новый инструмент **browserSnapshot** — карта страницы:
  ref (e1, e2…), роль, видимое имя, id/класс/placeholder, пометки «вне экрана»,
  «недоступно», «отмечено»; `filter` сужает список, `limit` ограничивает строки.
  Поиск цели для click/fill/select/wait теперь многоступенчатый:
  **ref → selector (CSS/text=/xpath=) → role+name → name/text → label/placeholder**.
  - Браузер сам проставляет элементам `data-agent-ref`; ref стабильны до перезагрузки
    страницы (повторный snapshot их не перенумеровывает), после перехода — заново.
  - Промах больше не молчит: ответ «Не нашёл «X». Похожие элементы…» со списком ref и
    готовым вызовом (`browserClick { ref: "e2" }`) — перебор селекторов не нужен.
  - `browserSelect` при неверном значении печатает реальные варианты списка.
  - `browserClick` распознаёт «intercepts pointer events» → подсказка про баннер/cookie-окно.
  - В карту НЕ собираются значения полей (пароли, коды 2FA); исключение — `value`
    у кнопок-<input>, там это и есть видимое имя.
  - `collectInPage` и `setPlaywright` экспортированы только для тестов.
- **main.js:** диспетчер `browserSnapshot`. **agent-core.js:** определение инструмента,
  алиасы (`browser_snapshot`, `page_map`, `dom`, `snapshot`), у browserClick/browserFill/
  browserSelect/browserWait добавлены args `ref`/`name`/`role`/`label`/`placeholder`
  (у click/fill/select/ wait `required` больше не требует selector), список инструментов
  в промпте и правило 21: «открыл страницу → browserSnapshot → действуй по ref».

### Проверки
- smoke-тесты: **127/127** (+15): карта с ref и фильтром, клик по имени/ref/номеру,
  имя в кавычках, несовпавшая роль (clickable) не ломает поиск по имени, промах с
  подсказками и ref, fill по label и contenteditable через
  insertText, варианты select, wait словами, а также проверка настоящего сборщика на
  мини-DOM (ref стабильны, hidden пропущен, пароль не попал в карту).
- `node --check` по всем изменённым файлам — чисто.
- OTA-бандл **1.5.26** собран; файлы сверены с диском побайтово.


## 1.5.27 — отчёт песочницы: баги Yandex Cloud, UX каталога, app-инструменты по ref

Отчёт внешнего агента разобран по пунктам; исправлено то, что действительно в коде приложения.

### Yandex Cloud — реальные баги интеграции
- **Postbox**: адрес был `postbox.api.cloud.yandex.net` — такого домена нет в DNS («fetch failed»).
  Стало `postbox.cloud.yandex.net` (проверено по документации сервиса).
- **Cloud Logging**: список запрашивался по `/logging/v1/groups`, а в API — `/logging/v1/logGroups`
  (отсюда 404, хотя эндпоинт жив: ``без токена отдаёт 401, а не «не активирован»).
- **Диагностика**: сбои делятся на «сеть/таймаут» и «ошибка API», в текст всегда подставляется
  адрес, по которому стучались (`serviceError`). Единственный сетевой сбой повторяется (2 попытки,
  пауза 700 мс); 401/403/404 не повторяются.
- **Сводный статус**: все 13 сервисов опрашивались залпом (`Promise.allSettled`) — поодиночке
  отвечают, вместе давали таймауты. Теперь пачками по 3, таймаут 25 с, обмен IAM-токена
  выполняется один раз до опроса (`resourcesStatus`, параметры `batch`/`retries`/`timeoutMs`).
- **Инструменты агента читают свежие настройки**: `ycConfig(settings)`/mailConfig/sitePasswords
  заменены на `loadSettings()` — выбранный каталог и разрешения применяются сразу, а не со
  следующего сообщения («доходило с задержкой»).

### UX (отчёт, пункты 5–7)
- Ошибка сервиса в дашборде снова видна **текстом** (`.yc-card-err` был в CSS, но не использовался):
  «⚠ ошибка API» + причина и адрес; в сводке — «⚠️ Не ответили: N».
- Список каталогов: при обновлении видно «⏳ Загрузка каталогов…», при сбое — сам текст ошибки
  («⚠️ … — повтори ↻»), пустой список объясняет причину, а не молчит.
- Разрешения агента подписаны прямо: «галочка = РАЗРЕШЕНО, пусто = запрещено».

### Windows-консоль: UTF-8 вместо CP866
- Новый `shellArgsFor(command)` подставляет `chcp 65001>nul & ` во все три места запуска через
  cmd (runTerminalCommand, spawnCollect, bgSpawn) — вывод `set | findstr`, git и сборок читается
  кириллицей, а не «кашей».

### app-инструменты: стабильные ref вместо номеров [N] (пункт 10, самый вредный)
- Было: `appClick {index: 7}` считал седьмой видимый элемент ЗАНОВО при клике — после «↻»
  нумерация сдвигалась, и клик уходил в чужой элемент (агент попал в «Секреты»).
- Стало: `src/app-ui-tools.js` собран на том же `dom-map.js`, что и браузер. Окно отдаёт карту
  (appRead): ref (e12), роль, видимое имя, `#id`/`.class`. Ref вешает сама страница
  (`data-agent-ref`) и он не меняется, пока элемент жив. Клик/ввод/выбор/ожидание принимают
  `ref`, `text`, `selector`, для заполнения — `label`/`placeholder`.
  - `index` остался только для совместимости: он работает, но ответ честно предупреждает
    «клик выполнен по НОМЕРУ» и просит взять ref. Ref устарел → клика нет, вместо него свежая карта.
  - Опасные кнопки («Удалить», «Сбросить»…) блокируются теперь и по ref/селектору (по реальному
    имени найденного элемента), а не только по тексту.
  - Значения полей в карту не собираются; пароли/токены помечаются «значение скрыто». В браузерной
    карте пароли помечены так же.
  - Пустой запрос больше не «находит» первый элемент (это заставляло клик по номеру уходить в
    случайную кнопку).
- Промпт (правило 22) и описания appClick/appFill/appSelect/appWait переписаны на ref.

### Чего в приложении не исправить (окружение песочницы)
- `installSystemPackage` бесполезен там, где нет winget/choco/scoop, а `yc`/`git` не вшиты —
  это про образ песочницы, не про код приложения. В desktop-приложении yc CLI ставится сам:
  инструмент `ycInstall` + кнопка в Настройках (bin в папке приложения, добавлен в PATH).

### Проверки
- smoke-тесты: **143/143** (+16): YC (адреса, повтор сетевого сбоя, отсутствие повтора на 403,
  пачечный опрос без залпа, классификация ошибок), подключение UTF-8 к трём местам запуска,
  свежие настройки в инструментах, видимость ошибок в UI, а также 8 тестов app-инструментов на
  мини-DOM (ref переживает перерисовку, устаревший ref не кликает, опасное блокируется, пароли
  не утекают).
- `node --check` по изменённым файлам — чисто.
- OTA-бандл **1.5.27** собран; файлы сверены с диском побайтово.


## Обновление 1.5.29 — оболочка, коды ошибок, установщики и режим «свой Chrome»

### `shell` у runCommand/startBackground (самый весомый пункт отчёта песочницы)
- Было: команды всегда шли через `cmd.exe`; PowerShell приходилось оборачивать в
  `powershell -NoProfile -Command \"...\"` — кавычки, `$` и `2>$null` ломались на границе cmd.
- Стало: `shell: "cmd" | "powershell" | "pwsh" | "bash" | "sh"` (плюс псевдонимы, в том числе
  русские). `resolveShell()` — единая точка выбора; `bgSpawn` принимает оболочку через
  opts.shell/shellArgs.
- PowerShell передаётся через `-EncodedCommand` (UTF-16LE base64) с префиксом UTF-8
  (`[Console]::OutputEncoding` + `$OutputEncoding`) — кавычки, `$`, кириллица и `2>$null`
  работают как в обычной консоли, обёртка больше не нужна.
- `bash` на Windows ищется в Git for Windows (PATH не обязателен). Если оболочки нет, в ответе
  подсказка («что установить / чем заменить»), а не безликий «код 1».

### spawnRaw: системные коды ошибок больше не теряются
- Было: `EINVAL`/`EPERM`/`EACCES` превращались в код `1` с ПУСТЫМ выводом — диагноз был
  невозможен (поэтому «getSystemInfo падает spawn EINVAL» нельзя было подтвердить по ответу).
- Стало: текстовый код сохраняется как есть, а `stderr` подменяется `err.message`, если он пуст.
  `ENOENT` по-прежнему 127 — на это опирается подсказка «команда не найдена».

### installExe: .exe / .msi / .zip
- Расширение берётся из URL (раньше имя принудительно становилось `installer.exe`, поэтому .msi
  скачивался как exe и не запускался). `.msi` → `msiexec /i ... /passive /norestart`;
  `.zip` → распаковка тем же `downloadAndExtractTo` + поиск установщика (`findInstallersIn`)
  и `run: true` для запуска. Скачивание вынесено в `downloadFileTo` (лимит 800 МБ).

### gitPublish: публикация не только на GitHub
- Новые параметры `remoteUrl` и `remoteName`: инструмент сам прописывает/обновляет remote и делает
  `push -u <remote> <branch>` — GitLab, Bitbucket, свой сервер. Ошибка пуша сопровождается разбором
  частых причин (репозиторий не создан, нужен токен, нет прав на запись).

### Режим «свой Chrome» (CDP) — пункт 5 отчёта
- Новый инструмент `browserConnect` + переработка `src/browser-tools.js`:
  `chromium.connectOverCDP` к Chrome пользователя с `--remote-debugging-port`. Если Chrome не
  запущен с отладкой — приложение запускает его само с `--user-data-dir` (это обязательно:
  с Chrome 136+ порт отладки НЕ работает на стандартном профиле — защита от кражи куки).
- Открытые вкладки пользователя подхватываются (`adopted`): агент работает в них, агент их не
  закрывает; `browserClose "all"` только отключает агента — Chrome и вкладки остаются. Новые вкладки
  создаются в контексте пользователя (иначе были бы без его входов на сайты).
- Настройки: Настройки → 🌐 Браузер агента → «Подключаться к моему Chrome (CDP)», порт и кнопка
  «🔌 Подключиться» (`browserConnect`, `browserConnectPort`, IPC `browser:connect`).
- `stop()` и выход из приложения в CDP-режиме НЕ закрывают браузер пользователя.

### Проверки
- smoke-тесты: **151/151** (+8): псевдонимы и PowerShell-кодирование, подсказка при отсутствии
  оболочки, текстовые коды spawnRaw, поиск установщика в архиве, ветки .msi/.zip, публикация вне
  GitHub, CDP на подставном playwright + живом `/json/version` (подхват вкладок, отказ закрывать
  вкладку пользователя, отключение без закрытия Chrome), связка инструмент ↔ промпт ↔ preload ↔
  main ↔ HTML, сверка id app.js ↔ index.html.
- `node --check` по изменённым файлам — чисто.
- OTA-бандл **1.5.29** собран; 32 файла сверены с диском побайтово, sha256 совпадает с манифестом.


## Обновление 1.5.30 — панель действий и автопрокрутка размышлений

### Свернуть действия агента можно в любой момент (жалоба: приходилось пролистывать вверх)
- Панель действий («Выполняю действия · N») живёт над полем ввода и при развёрнутом
  списке прокручивается внутри себя (max-height 240px). Заголовок с кнопкой ▾/▸ уезжал
  вместе со строками — чтобы свернуть, нужно было вернуться к первой строке.
- Стало: `.work-group.expanded .work-head` — `position: sticky; top: 0; z-index: 3`
  с плотным фоном (два градиента: акцентная подсветка + непрозрачная основа) и тенью,
  поэтому строки уходят ПОД заголовок. Фон обязателен: без него строки просвечивали бы
  сквозь липкую плашку.

### Размышления модели прокручиваются сами
- `.think-body` (max-height 260px) больше не стоит на месте: новая функция
  `thinkAutoScroll(body, force)` тянет блок вниз по мере роста текста.
- Если пользователь сам отлистал вверх (читает ранее написанное) — не выдёргиваем:
  слушатель `scroll` помечает `data-pinned="0"`, автопрокрутка возобновляется, когда
  он вернётся к концу. Разворот блока кнопкой ▸ сразу показывает конец размышлений.

### Проверки
- smoke-тесты: **152/152** (+1): «ход работ» — проверка правила CSS (sticky/top/z-index/
  фон) и поведенческий тест `thinkAutoScroll` на реальном срезе app.js (тянет вниз при
  росте текста; не трогает блок, если пользователь читает выше; force прокручивает).
- `node --check` по изменённым файлам — чисто.
- OTA-бандл **1.5.30** собран; файлы сверены с диском побайтово.

## Память диалогов (1.5.31): сжатые памятки контекста сохраняются локально по датам

### Зачем
Когда контекст переполняется, агент вызывает `compactRemote` и сворачивает старые шаги в
«памятку», которая живёт только внутри одного ответа (переменная в `createContextManager`) и
исчезает. Пользователь попросил: пусть эти памятки хранятся локально, по датам, чтобы можно
было спросить «посмотри, что мы делали 5-го числа» — и агент их вспомнил.

### Как сделано (по слоям)
- **`src/agent-store.js`** — новое хранилище (чистый Node, тестируется без Electron):
  `contextMemorySave / Days / Read / Search / Prune / Clear / Stats`, `redactSecrets`,
  `sanitizeMemoMessages`, `contextMemoryDir`. Файлы: `<userData>/context-memory/<ГГГГ-ММ-ДД>/`
  — `<ЧЧ-ММ-СС>-<rand>.json` (точные данные: ts, provider, model, workDir, memo, messages)
  и собранный `day.md` (человекочитаемый дневник). Запись атомарная (tmp → rename),
  дата — **локальная**, не UTC (иначе «5 сентября» уезжает на день). Автоочистка: храним
  `contextMemoryDays` (30 по умолчанию) самых свежих дней, старые удаляются.
- **`agent-core.js`** — `createContextManager` получил необязательный хук `onMemo`:
  вызывается ровно тогда, когда памятка реально создана, и получает `{ text, messages,
  provider, model, ts }`. Ошибка хука глотается и не ломает сжатие.
- **`main.js`** — `saveContextMemo(settings, entry, emit)` пишет памятку **только если**
  `settings.contextMemory === true`; в `runAi` подключено `onMemo: (m) => saveContextMemo(...)`;
  настройки `contextMemory: false` (ВЫКЛЮЧЕНО по умолчанию) и `contextMemoryDays: 30`;
  IPC `memory:stats / days / openDir / clear`.
- **Инструменты агента** — `memoryList(date?)` (список дней или памятки за день) и
  `memorySearch(query, date?, limit?)`; оба в `CORE_TOOL_NAMES` (тесный контекст — именно тот
  случай, когда память нужнее всего), в списке промпта, в правиле 24 и в `TOOL_ALIASES`.
- **UI** — вкладка «🧠 Память»: галочка (по умолчанию пусто), срок хранения, кнопки
  «📁 Открыть папку» / «🗑 Очистить», счётчик дней/памяток/КБ; плашка `memory` в чате при
  сохранении памятки.

### Решения, которые важно не потерять
- Папка лежит **вне проекта и вне OTA-бандла** (`userData`), поэтому не попадает в git и не
  уезжает на сервер; в OTA-бандл её тоже не кладём (manifest собирает только src/assets).
- **Маскируются только бесспорные секреты** (`sk-…`, `ghp_…`, `AIza…`, `ya29.…`, `Bearer …`,
  `-----BEGIN … PRIVATE KEY-----`), чтобы случайный токен не осел в дневнике. Обычный код и
  текст не трогаем — иначе память теряет ценность. Значения полей ввода из UI в дневник не
  собираются: сохраняются только роль + текст сообщений + имена вызванных инструментов.
- Настройки инструменты читают через `loadSettings()` **в момент вызова** — галочка,
  включённая в середине сессии, действует сразу (та же болезнь, что была у yc-инструментов).
- `day.md` дополнительно показывает имена инструментов (`→ ycDeploy`), иначе по дневнику
  непонятно, чем именно занимались.

### Проверки
- smoke-тесты: **158/158** (+6): настройки/инструменты/IPC/UI согласованы; сохранение,
  список дней, чтение, поиск (в т.ч. по сжатым шагам) и `day.md`; маскирование секретов;
  автоочистка, статистика и ручная очистка; пустая памятка не создаёт папок; и
  **поведенческий тест `createContextManager`** — `onMemo` зовётся при сжатии с полным
  набором исходных сообщений, не зовётся без хука и не ломает сжатие при исключении.
- `node --check` по всем изменённым файлам — чисто.
- OTA-бандл **1.5.31** собран; файлы сверены с диском побайтово.

## Оболочки (1.5.32): sh на Windows, справочник shellsStatus, честный отказ startBackground

### Что было не так
Агент в песочнице сообщил: «PowerShell работает идеально, bash не нашёлся (выполнение ушло в
cmd-эхо), Docker отсутствует». Диагноз: PowerShell — норма, Docker приложением не поставляется
(только Docker Desktop руками), а вот в оболочках нашлись три настоящих недочёта:

1. **`shell: "sh"` на Windows отдавал пустую ошибку.** `sh`/`zsh`/`dash` сводились к
   `/bin/sh`, которого в Windows нет: агент получал ENOENT **без единого слова** — в отличие
   от `bash`, у которого подсказка была. При этом `sh` в Windows живёт там же, где bash —
   в Git for Windows (`usr/bin/sh.exe`), и просто не искался.
2. **Агент узнавал о оболочках методом тыка.** Один потраченный вызов на «а вдруг bash есть».
3. **`startBackground` с отсутствующей оболочкой рапортовал «OK … PID: undefined».** `spawn`
   падает асинхронно (`error`-событие), а инструмент успевал вернуть успех с пустым PID —
   ошибка всплывала только в `backgroundOutput` позже.

### Что сделано
- `findBash()` → **`findGitShell(which)`**: ищет и `bash`, и `sh` в Git for Windows
  (`bin`, `usr/bin` — два корня × Program Files / Program Files (x86) / %LOCALAPPDATA%\Programs;
  вне Windows — PATH, затем `/bin/sh`, `/bin/bash`). Возвращает путь или `""`.
- `resolveShell` для `bash`/`sh` отдаёт **`missing: true`**, когда бинаря нет, и одинаковую
  подсказку-объяснение (`shellMissingHint`). Для `cmd` — `missing: false`; для
  `powershell`/`pwsh` — **тоже false намеренно**: Windows находит `powershell.exe` в System32
  независимо от PATH, и жёсткая блокировка дала бы ложный отказ на рабочей машине.
- `runTerminalCommand` показывает подсказку не только по `ENOENT`, но и по флагу `missing`.
- `startBackground` **предпроверяет `bgShell.missing`** и возвращает понятную ошибку с советом,
  что ставить и чем заменить, вместо «OK, PID undefined».
- Новый инструмент **`shellsStatus`**: список `cmd`/`powershell`/`pwsh`/`bash`/`sh` со статусом,
  путём, пометкой «по умолчанию» и советом по установке для отсутствующих. В ядре инструментов,
  в списке промпта, в правиле 20 и с алиасами (`shells_status`, `shells`, `check_shells`…).
- **`shellsBrief()` добавляется в САММАРИ ПРОЕКТА** (`buildProjectBrief`): агент видит строку
  «Оболочки: по умолчанию cmd; доступно: cmd, powershell (параметр shell у runCommand/startBackground)»
  сразу при старте, без отдельного вызова. Это и есть ответ на «не гадать».

### Проверки
- smoke-тесты: **162/162** (+4): `sh`/`bash` находят Git-оболочку и получают подсказку с названием
  оболочки; при отсутствии **нет молчаливого отката** в другую оболочку; найденный Git-бинарь
  подставляется, bash идёт с `-lc`; на Unix `/bin/sh` не считается отсутствующим. Отчёт
  `shellsStatus` (состав, единственная оболочка «по умолчанию», дубли не появляются), советы для
  отсутствующих, строка `shellsBrief`. Согласованность инструмент ↔ промпт ↔ ядро ↔ алиасы ↔
  САММАРИ проекта и предпроверка `startBackground` до `bgSpawn`.
- Тесты оболочек стали детерминированными: `mkHelpers` принимает подмену `fs`, поэтому
  «нет ничего на диске» проверяется без зависимости от машины.
- `node --check` — чисто; OTA-бандл **1.5.32** собран, файлы сверены с диском побайтово.

## Каталог Yandex Cloud и индикатор контекста (1.5.33)

### 🐛 Каталог исчезал при сохранении настроек (жалоба: «ИИ его не видит, хотя я вижу»)
Симптом: каталог подключён и виден в интерфейсе, но агент отвечает «каталог не выбран»;
помогало «обновить и сохранить» дважды. Причина найдена и подтверждена тестом:

1. Каталог выбирается НЕ в форме настроек, а своими IPC: `yc:setToken` (первый каталог
   при входе), автовыбор внутри `yc:status`, `yc:setFolder` (смена в списке), сброс в `yc:logout`.
2. `settings:set` сливает присланный объект интерфейса ПОВЕРХ текущих настроек
   (`{ ...prev, ...s }`), а объект интерфейса — снимок, загруженный при старте. Он приносил
   `ycFolderId: ""` и **стирал** только что выбранный каталог.
3. Интерфейс продолжал показывать каталог из своего кэша (`ycStatusCache`) — поэтому
   расхождение было незаметно, а агент читал уже пустые настройки.

**Фикс:** в `settings:set` поля Yandex Cloud (`ycFolderId`, `ycFolderName`, `ycCloudId`)
больше не берутся из присланного объекта — только из текущих настроек. Это та же защита,
что уже была у `sitePasswords` и `mailPassword`, и она безопасна: других писателей у этих
полей нет (мобильный мост их не трогает, «Выйти» идёт мимо `settings:set`).
Плюс интерфейс теперь держит свой объект настроек в синхроне (`ycStatus`, `ycSetFolder`),
чтобы не присылать устаревшее.

### 🧠 Агент всегда видит актуальный Yandex Cloud
Новое `ycBriefLine()` добавляется в **САММАРИ ПРОЕКТА** (пересобирается на каждое сообщение):
«Yandex Cloud: каталог «prod» (b1g…), облако b1g…; создание ресурсов агентом ЗАПРЕЩЕНО,
удаление ЗАПРЕЩЕНО.» Если подключён, но каталог не выбран — отдельная строка с просьбой выбрать.
Так модель не может опереться на устаревший результат `ycStatus` из истории переписки.

### 📊 Индикатор контекста больше не «упирается» в 100 %
Вопрос пользователя: «почему контекст выходит за рамки 50 000 — это специально?». Да, специально,
но показывалось это нечестно.
- `used` считается как история + схема инструментов, а **хвост (текущее сообщение и результаты
  инструментов) не сжимается никогда** — иначе разорвётся связка assistant(tool_calls) → tool
  и потеряется текущий запрос. Поэтому во время шага с крупными результатами `used` законно
  превышает бюджет; перед следующим запросом история снова обрезается (`manage()` в начале раунда).
- 50 000 — это **намеренный потолок истории** для OpenAI-совместимых моделей (реальное окно может
  быть 128k: запас оставлен под ответ и инструменты); Anthropic — 80 000, Ollama — 14 000.
- Оценка токенов — по символам (≈ len/4), для русского текста это занижение: цифра в индикаторе
  приблизительная, не точный счёт токенов модели.
- **Стало:** процент считается от бюджета и честно показывает 124 %, а не 100 %; полоска,
  как и раньше, упирается в 100 %; в подсказке прямо написано, что текущий шаг не сжимается
  и что оценка приблизительная.

### Проверки
- smoke-тесты: **165/165** (+3): обработчик `settings:set` вырезается из main.js и **исполняется**
  в песочнице с подставными зависимостями — пустой/устаревший `ycFolderId` из интерфейса
  больше не стирает каталог, при этом обычные поля и разрешения агента применяются, а защита
  паролей не сломалась (на версии до правки тест падает — проверено). Согласованность
  `ycBriefLine` ↔ САММАРИ проекта ↔ синхрон интерфейса. Переполнение индикатора: «62k / 50k · 124 %»,
  полоска 100 %, красный цвет, объяснение в подсказке.
- `node --check` — чисто; OTA-бандл **1.5.33** собран, файлы сверены с диском побайтово.

## 1.5.34 — план работ агента (todoWrite) с визуализацией

Вопрос пользователя: «можно сделать, чтобы агент составлял для себя план и действовал по нему с
визуализацией, что выполнено — как в Freebuff?». Выбран вариант 3 из трёх: **модель ведёт план,
приложение страхует**.

### Как решено (три слоя, каждый маленький)
- **Модель:** новый инструмент `todoWrite` (до 7 пунктов, статусы pending/in_progress/done/failed,
  `note` для причины сбоя). Правило 32 в промпте требует вызывать его в начале многошаговой задачи
  и **повторно после каждого шага с ПОЛНЫМ списком**. Инструмент добавлен в ядро инструментов —
  значит доступен и при тесном контексте (маленькие модели). Алиасы: `todo_write`, `todos`, `todo`,
  `plan`, `write_plan`, `update_plan`.
- **Хранилище:** план лежит в самом чате — `chat.plan = { title, source, items, updatedAt }` рядом с
  `messages`. Переживает перезапуск (тот же атомарный `saveChats`), попадает в бэкап `chats.json.bak`.
  Предыдущие планы складываются в `chat.planHistory` (последние 5) — контекст не теряется.
- **Интерфейс:** отдельный контейнер `#plan-panel` **над** панелью действий (там же, где ход работ).
  Чеклист со статусами ⬜🔄✅⚠️, счётчиком «3/7», полоской прогресса, сворачиванием по клику,
  кнопкой «✕» (уводит план в историю) и кнопкой «▶ Выполнить», если план составлен в «📋 План-режиме».

### Главное архитектурное решение: гибрид, а не «только модель»
> ⚠️ **Отменено в 1.5.36**: фолбэк на авто-шаги убран — панель показывает только план модели.
> Причина и детали — в разделе «1.5.36» ниже.
- Модель плана не дала → панель работает **на авто-шагах** из реальных вызовов инструментов
  (`tool_start`/`tool_result`): подпись «план не задан — показываю выполненные шаги». Слабые
  локальные модели (Ollama) вызывают инструменты через раз — без этого фолбэка панель исчезала бы
  ровно там, где структура нужнее всего.
- Модель план дала → показываются **её** статусы, авто-шаги не подменяют нумерацию. Но слепо
  доверять нельзя: если её текущий шаг фактически упал (`toolOk === false`), пункт помечается ⚠️
  с пометкой — панель не врёт «в работе» там, где действие уже сорвалось.
- `planRotate` на новом запросе: завершённый план уходит в историю, **незавершённый остаётся** —
  агент видит, что осталось, когда пользователь говорит «продолжай». Авто-шаги начинаются заново.

### Продакшен-мелочи
- `normalizePlanTasks` — единственная точка нормализации (её же использует main.js и sanitizeChats):
  принимает строку/массив/объект/{tasks}, JSON-строку и свободный текст, разбирает чекбоксы
  «- [x]», эмодзи-статусы, русские статусы («в работе», «готово», «ошибка»), схлопывает дубликаты,
  обрезает длину и «ровно один in_progress» (частая ошибка слабых моделей). Никогда не бросает.
- `sanitizeChats` защищён try/catch и правит поле `plan` **только если оно есть** — иначе каждый
  запуск перезаписывал бы файл истории целиком (это ловится тестом «целая история не меняется»).
- Счётчики и прогресс считаются по факту (`planProgress`), а не по заявлению модели.

### Проверки
- smoke-тесты: **176/176** (+11). План тестируется **поведенчески**: блок чистых функций вырезается
  из app.js по маркерам и исполняется в песочнице с игрушечным DOM — проверены нормализация,
  приём/замена плана модели, авто-шаги (закрытие предыдущего, ✅/⚠️ по результату), поворот плана,
  отрисовка (строки, «1/3», ширина полосы 33 %, сворачивание, «план не задан»), кнопки «▶ Выполнить»
  и «✕» (план уходит в историю, панель скрывается), а также связки: наличие инструмента и правила,
  `case "todoWrite"` в main.js + событие `plan` + обработчик в интерфейсе, веб-режим, контейнер в
  HTML выше панели действий, стили, и отдельно — что битый план в chats.json не мешает запуску.
- `node --check` — чисто; OTA-бандл **1.5.34** собран (32 файла), sha256 совпал с манифестом,
  все файлы сверены с диском побайтово.

## 1.5.35 — Yandex Cloud: логи, IAM в окружении, Postbox, скорость сводки

Отчёт агента из песочницы (6 пунктов) разобран живыми пробами по сети, а не по памяти.
Важное уточнение: песочница проверяла **1.5.29** — последний запушенный коммит; правки
1.5.31–1.5.34 до неё не доехали, поэтому пункты «каталог сбрасывается» и «bash молча ушёл в cmd»
были про уже исправленный код.

### 1) 🐛 ycLogs: чтение шло не на тот хост (главный баг)
Пробы: `logging.api.cloud.yandex.net` на `/yandex.cloud.logging.v1.LogReadingService/Read` →
`gRPC 12 unknown service`; на том же хосте `LogGroupService/List` → `gRPC 16 (Authorization header is
missing)`, то есть gRPC там живёт. В каталоге эндпоинтов Cloud Logging — это **три разных сервиса**:
`logging` (группы/экспорт/синки), `log-reading` → `reader.logging.yandexcloud.net`,
`log-ingestion` → `ingester.logging.yandexcloud.net` (запись).
- `yc-logs.js`: `readLogs` принимает `baseUrl` (REST, список групп) и `grpcBaseUrl` (gRPC, чтение) —
  это разные хосты. Если id группы известен, REST-запрос за списком не делается вовсе.
- `KNOWN_ENDPOINTS`: добавлены `log-reading` и `log-ingestion` — иначе при недоступном каталоге
  читать логи нечем.
- `main.js`: `readYcLogsText` берёт `endpoint("logging")` для REST и `endpoint("log-reading")` для gRPC.
- **Проверено живьём:** тот же вызов со исправленным хостом вернул `gRPC 5 (лог-группа не найдена):
  Log group not found` — то есть сервис нас понял и искал группу, а не «unknown service».
  С реальным токеном и существующей группой чтение работает.

### 2) 🐛 yc CLI: в YC_TOKEN клался OAuth-токен
`ycAutoEnv` подставлял `YC_TOKEN = cfg.oauth`, а yc CLI ждёт в `YC_TOKEN`/`YC_IAM_TOKEN` **IAM** — отсюда
«The token is invalid», который агент и получил, скопировав значение.
- `yandexCloud.getIamTokenInfo(oauth)` отдаёт токен **и срок жизни** (тот же кэш, что у ycList).
- `main.js`: `ycIamEnv` — снимок свежего IAM; `ycAutoEnv` кладёт его в `YC_IAM_TOKEN` **и** `YC_TOKEN`
  (только если токен не истёк и выдан тому же OAuth). Пока IAM не получен — переменных с токеном
  нет вовсе: утечки OAuth в окружение больше не происходит.
- Продление: `ycIamSync` пере-обменивает токен за 5 минут до истечения (таймер `unref`), повторы
  ограничены разом в минуту; обмен идёт фоном и никогда не ждёт команда агента.
- `ycInstall` теперь пересобирает окружение (`applyAgentEnv`) и сразу после установки, и когда CLI уже
  стоял; если IAM ещё не получен — об этом сказано прямо в ответе.

### 3) 🐛 Postbox: путь был выдуман (и это не таймаут)
Пробы: `/postbox/v1/addresses` → **404 за 120–570 мс** (маршрута нет), `/v2/email/identities` →
**403 Forbidden** (маршрут есть). По документации Postbox — это **Amazon SES-совместимый** API:
`Host: postbox.cloud.yandex.net`, авторизация `X-YaCloud-SubjectToken` с IAM **сервисного аккаунта**
(`postbox.viewer`) либо SigV4; `Authorization: Bearer` там не используется.
- `SERVICES`: `listPath: /v2/email/identities`, `listKey: Identities`, `auth: "subject"`, `query: "ses"`
  (у SES свои параметры — `PageSize`, без `folderId`).
- `listService`: заголовки и строка запроса теперь собираются по описанию сервиса (`serviceHeaders`,
  `serviceQuery`), ответ разбирается `pickList` (точное поле, затем то же имя в другом регистре, затем
  сам массив — SES отдаёт строки, каталог — объекты).
- 403 у SES-сервиса объясняется причиной: «нужен IAM-токен сервисного аккаунта с ролью postbox.viewer».
- `ycList` умеет печатать и строки (адреса Postbox), и объекты `{ id, name }`.

### 4) 🟡 Скорость сводки: таймауты больше не складываются
Замер показал ~0,5 с на каждый узел, значит «30–60 секунд» автовыбора каталога — это ожидание
таймаутов: каталог эндпоинтов 8 с + обмен IAM 20 с + облака 20 с + каталоги 20 с = до 68 с.
- `endpoint()` больше **не ждёт** каталог эндпоинтов: выверенный `KNOWN_ENDPOINTS` отдаётся сразу
  (20 мс по замеру), каталог прогревается в фоне (не чаще раза в 5 минут) и используется для id,
  которых в KNOWN нет.
- `yc:status`: обмен токена один раз, затем облака и каталоги идут **параллельно**, когда каталог уже
  известен.
- `listClouds`/`listFolders`: таймаут 12 с вместо 20 и повтор сетевых сбоев (`retryNet`).
- Сводка по 13 сервисам: пачки по 3 по-прежнему, но таймаут 12 с и без повторов — карточка со сбоем
  вместо минут ожидания (серийный вызов сохранил 25 с и 2 попытки).

### Проверки
- smoke-тесты: **182/182** (+6). Новое поведение проверено поведенчески: два хоста логирования
  (живой http2-сервер для чтения + подставной REST для групп), отсутствие REST-запроса при известном
  id группы, мгновенный `endpoint()` при «висящем» каталоге, сборка env (IAM в `YC_IAM_TOKEN`/`YC_TOKEN`,
  отсутствие OAuth, просроченный и «чужой» снимок не подставляются), SES-путь Postbox с заголовком и
  понятным 403, короткий таймаут сводки и параллельные облака/каталоги.
- Живые пробы по сети (без токена) подтвердили и диагноз, и фикс: `gRPC 12 unknown service` →
  `gRPC 5 Log group not found`, Postbox 404 → 403 на SES-пути.
- `node --check` — чисто; OTA-бандл **1.5.35** собран, sha256 совпал с манифестом, файлы сверены с диском.


## 1.5.36 — панель плана только из todoWrite; План-режим действительно даёт модели инструмент

Вопрос пользователя: «а почему он не создаёт план? почему пропускает? и если он не создаёт план, то не
надо показывать тогда вообще это — а ход действий у нас уже есть над полем ввода сообщений».

### Что убрано (по просьбе)
- **Авто-шаги больше не питают панель плана.** Функция `planAutoStep` удалена вместе с вызовом из
  `tool_start`; `planAutoResult` переименована в `planToolOutcome` и оставлена только как страховка
  плана модели (упавший шаг → ⚠️). Подпись «план не задан — показываю выполненные шаги», заголовок
  «Ход работы» и мёртвый стиль `.plan-hint` удалены. Ход действий и так виден в панели работы над
  полем ввода — второй список дублировал её и выглядел ошибкой интерфейса.
- **Старые авто-планы из `chats.json` не показываются**: `renderPlanPanel` игнорирует `source: "auto"`,
  а `sanitizeChats` при загрузке такие записи отбрасывает (`plan = null`). История чатов не ломается.
- `planRotate`, `PLAN_AUTO_MAX` и упоминания авто-режима вычищены.

### Настоящая причина, почему модель пропускала план
- Правило 32 было **мягким** («начинай с todoWrite») и стояло в длинном списке — модели просто шли
  работать. Формулировка переписана: план — **ОБЯЗАТЕЛЬНЫЙ первый шаг** многошаговой задачи, вызывать
  **до** чтения файлов и команд; названо и исключение (одно короткое действие/ответ без инструментов).
- **Найден реальный баг режима «📋 План-режим»**: там `activeTools = []` — список инструментов был
  пуст, поэтому модель физически не могла вызвать `todoWrite`, план приходил текстом, панель оставалась
  пустой, а кнопка «▶ Выполнить» (она появляется только при плане модели) — недостижимой. Теперь в
  План-режим уходит ровно один инструмент: `AgentCore.PLAN_MODE_TOOL_DEFINITIONS` (только `todoWrite`),
  он же используется в запросе (`tools: activeTools`). Режимный текст промпта обновлён.
- **Защита от обхода**: в цикле выполнения инструментов `if (planMode && c.name !== "todoWrite")` —
  прочие вызовы не выполняются даже если модель их прислала (в ответ модели уходит понятный отказ,
  UI не засоряется шагом).

### Проверки
- smoke-тесты: **183/183** (+1, обновлены 5). Новый тест «План-режим: модель получает ровно todoWrite,
  остальные вызовы не выполняются» проверяет и значение `PLAN_MODE_TOOL_DEFINITIONS` (исполняется),
  и обе точки в `main.js`, и наличие запрета на выполнение прочих инструментов. Тесты авто-шагов
  переписаны в проверки их отсутствия (включая «в `app.js` не осталось следов авто-режима»).
- **Тесты проверены на старом коде**: с прежним `app.js` (1.5.35 из HEAD) сьют падает на срезе блока
  плана, а с временно возвращённым `planMode ? []` — падает именно тест План-режима.
- `node --check` — чисто; OTA-бандл **1.5.36** собран, sha256 совпал с манифестом, файлы сверены с диском.

## 1.5.37 — окна поверх страницы: диалоги, force-клик, JS на странице, слои

Повод — реальный случай: агент упёрся в экран согласия Google Cloud
(«Welcome Misha Pimashin! … You must accept these terms of service to continue»).
Он видел кнопку «Dismiss» баннера (ref e4), но НЕ видел галочку согласия и кнопку
«Agree and continue». Четыре пути к одному диалогу — и все четыре упирались.

### Диагноз (не по памяти — по коду)
- **Карта теряла диалог при обрезке.** Консоль Google — Angular: диалог живёт в
  `.cdk-overlay-container`, который дописывается в КОНЕЦ `<body>`. `collectInPage`
  собирал до 400 элементов, а `formatSnapshot` показывал первые 60 → элементы диалога
  физически не попадали в вывод агента. Это и был «не вижу чекбокс».
- **Прозрачный ввод чекбокса отбрасывался.** Angular Material рисует стилизованный
  квадратик, а настоящий `<input type=checkbox>` держит с `opacity: 0`. Сборщик
  отбрасывал такие элементы (правило «opacity 0 = мусор»).
- **Клик не имел второго шанса.** На перекрытом элементе Playwright бросал
  «intercepts pointer events», и инструмент сразу сдавался.
- **Скриншот возвращался data URL** — vision-модель на него не смотрела (нет файла),
  а в контекст агента уходили десятки тысяч токенов.

### Что сделано
- **Карта (`collectInPage` + `collectMap` + `formatSnapshot`).** Обход с заходом в
  **shadow DOM**; определение overlay-контейнеров (`.cdk-overlay-pane`,
  `[role=dialog]`, `[aria-modal]`, `mat-dialog-container`, окно перевода Google…)
  с человеческим именем диалога; элементы слоя идут **первыми** и **не отрезаются
  лимитом**; прозрачные чекбоксы берутся в карту с пометкой «скрытый ввод — клик с
  force»; в шапке — предупреждение «⚠️ Поверх страницы открыт диалог («Welcome») — N
  элементов», в конце — подсказки про force/browserOverlays/browserEval.
- **Клик (`click`).** Четыре способа по очереди: обычный клик → `force: true` →
  `el.click()` из DOM → клик мышью по координатам центра. В ответе видно, какой
  способ сработал, и **какой слой перекрывал** элемент (`elementFromPoint`).
- **browserEval { script }** — JS на странице: выражение оборачивается в `return`,
  код со своим `return` выполняется как есть, результат приводится к тексту и
  обрезается по `maxChars`. Это «панацея» для любых overlay.
- **browserDOM { selector | ref }** — outerHTML + текст элемента, поиск с заходом в
  shadow DOM (отладка незнакомых слоёв).
- **browserOverlays { dismiss, acceptTerms }** — список слоёв с классификацией
  (terms / cookie / translate / noise / dialog), элементы с ref. `dismiss: true`
  скрывает окно перевода Google и нажимает только безопасные формулировки
  («Не сейчас», «Понятно», «Dismiss», крестик) — **юридические кнопки («Принять
  всё», «Я согласен») не нажимаются никогда**. `acceptTerms: true` — осознанное
  подтверждение согласия (галочка + кнопка «Agree/Принять/Продолжить»).
- **browserScreenshot** — PNG сохраняется в файл (по умолчанию временная папка
  `ai-agent-shots`), путь возвращается, файл показывается пользователю, а если
  настроено зрение — скриншот разбирает vision-модель. **Если модель не ответила —
  это не блокер**: агент получает честное сообщение и идёт по DOM
  (`browserSnapshot / browserDOM / browserEval`). По просьбе агента всё это
  доступно и без зрения вообще.
- **Промпт:** правило 21 учит порядку действий при перекрытиях, правилу «работай
  сначала с диалогом поверх страницы» и запрету молча подтверждать юридические
  согласия. В список инструментов добавлены `browserEval, browserDOM, browserOverlays`.

### Проверки
- smoke-тесты: **197/197** (+14). Новое проверено поведенчески на мини-DOM и
  подставном Playwright: диалог первым и не режется лимитом (5 строк при 70 кнопках),
  прозрачная галочка в карте с пометкой, обход shadow DOM, классификация слоёв,
  очистка помех нажимает «Не сейчас», но НЕ «Принять все» и не кнопки вне слоя,
  `acceptTerms` не нажимает «Не согласен», все четыре способа клика (обычный, force,
  DOM, мышью) с названным слоем-перекрытием, обёртка `return` в browserEval,
  browserDOM с лимитом/промахом/shadow-поиском, сохранение скриншота в файл,
  предупреждения о помехах и согласии в карте.
- **Тесты проверены на сломанном коде**: с убранной сортировкой диалога и без
  force-клика падают три теста (карта, force-клик, связка) — значит проверки реальные.
- `node --check` — чисто; OTA-бандл **1.5.37** собран, sha256 совпал с манифестом,
  файлы сверены с диском побайтово.

## 1.5.38 — почему приложение «жевало» при печати (производительность интерфейса)

Жалоба: «приложение начало тормозить, особенно при вводе сообщений». Причина нашлась
не в модели и не в сети, а в оформлении + рендере стрима. Три источника нагрузки:

1. **Анимированный фон под «стеклом».** Слой `body::before` (туманность) бесконечно
   дрейфовал (`nebulaDrift 48s infinite` + `will-change: transform`), а НАД ним лежат
   панели с `backdrop-filter` (шапка blur(16px), сайдбар и панели blur(20px), композер,
   пузыри blur(8px), чипы, оверлеи — 32 правила). Пока фон под ними движется, браузер
   обязан заново размывать каждый такой элемент **в каждом кадре**, даже когда
   пользователь ничего не делает. Дрейф убран → фон статичный, блюры кэшируются
   (выглядит так же: градиенты, сетка и стекло остались).
2. **Пузырь ответа перерисовывался на КАЖДЫЙ чанк модели.** `case "chunk"` делал
   `b.innerHTML = msgHtml(seg.content)` — на длинном ответе это десятки раз в секунду
   пересобирает сотни узлов и пересчитывает раскладку. Теперь текст копится в данных,
   а DOM обновляется не чаще одного кадра (`queueBubbleRender`, requestAnimationFrame);
   финальный рендер делает `finishStream`. Так же и `text_override`.
3. **Прокрутка и `scrollHeight` на каждое событие.** `scrollBottom()` на каждый чанк и
   `autoResize()` (чтение `scrollHeight`) на каждое нажатие клавиши заставляют браузер
   синхронно пересчитывать раскладку большой ленты. Оба переведены на кадр:
   `scrollBottomSoon()` (стрим, размышления) и rAF внутри `autoResize`.

### Что менять не надо
- Оформление и разметка не тронуты: градиенты, стекло, свечение, анимации кнопок
  (sheenSlide) и логотипа остались. Убран только бесконечный дрейф фона под blur-панелями
  и невидимое размытие под пузырём (фон пузыря непрозрачен на ~93%).
- Ключевые кадры `nebulaDrift` оставлены в CSS — если понадобится вернуть дрейф,
  достаточно снять комментарий, но тогда лучше заодно упростить backdrop-filter у панелей.

### Проверки
- smoke-тесты: **201/201** (+4): обработчик chunk использует очередь кадра (и не пишет
  innerHTML сам), размышления не дёргают прокрутку каждый токен, очередь копит текст и
  рисует последнее состояние ровно за один кадр (+ отложенная прокрутка схлопывается в
  кадр), `autoResize` откладывается до кадра, фон не анимируется и у пузыря нет
  `backdrop-filter`. Проверка поведения идёт на реальном срезе `app.js` с мини-DOM
  и подставным requestAnimationFrame.
- `node --check` по `app.js` и `test/smoke.test.js` — чисто; баланс скобок в
  `styles.css` сверен (1007/1007).
- OTA-бандл **1.5.38** собран.

### Если всё ещё тормозит (следующие шаги, по убыванию эффекта)
- Ограничить длину ленты в DOM: рендерить последние N сообщений + «показать раньше»
  (сейчас при переключении чата строятся все сообщения целиком).
- `saveChats`: рендерер отдаёт в главный процесс весь объект истории (структурное
  клонирование на каждый сейв, раз в 1.5 c во время стрима) — можно передавать готовую
  строку JSON и не печатать файл с отступами.
- Для очень больших чатов — виртуальный список (`content-visibility: auto` на `.msg`
  даст эффект бесплатно, проверить на реальной машине).

## 1.5.39 — браузер: агент делает «сразу», а не ищет селекторы

Жалоба: модель (в песочнице тестируется GLM 5.3) не может сразу сделать нужное в
браузере — перебирает селекторы и варианты. Причины и что сделано:

1. **Мгновенный провал вместо ожидания.** `resolveTarget` смотрел на страницу ОДИН раз:
   если SPA ещё не дорисовала кнопку, модель получала ошибку и тратила ходы на
   browserWait и повторный snapshot. Теперь ожидание встроено: 3 с по умолчанию
   (`timeout` задаёт своё), опрос каждые 200 мс; по ref — 800 мс (ref после перехода
   просто устаревает). Ответ при провале по-прежнему несёт похожие элементы с ref.
2. **Не искали во фреймах.** Локаторы работали только в главном фрейме, поэтому вход
   через iframe, платёжные и капча-виджеты были для агента невидимы. Теперь поиск идёт
   по всем фреймам (главный + вложенные), в ответе видно «(фрейм https://…)», и действие
   выполняется внутри нужного фрейма. `frameList/frameLabel`, поиск в `resolveTarget`.
3. **Много ходов на простое действие.** `browserFill` получил `submit: true` (ввёл и
   сразу Enter), а новый инструмент **browserAct** делает цепочку шагов ОДНОЙ командой:
   `goto` (открыть адрес), `click`, `fill` (+submit), `press`, `wait` (мс), `waitFor`
   (текст), `back`, `scroll`, `eval`, `read`, `snapshot`. Первый сбой останавливает
   цепочку и объясняет причину (`stopOnError: false` — продолжать). Шаг понимает и
   «человеческие» формы: `{"click":"Войти"}`, `{"field":"Почта","text":"a@b.c"}`, `{"ref":"e2"}`.
4. **Мелочи, которые экономили по ходу:** `browserFill` принимает `field` как синоним
   подписи/имени поля; `browserWait` умеет паузу без элемента (`{ ms: 1500 }`); клик,
   открывший новую вкладку (target=_blank), подхватывает её и делает активной
   (`adoptNewPages`); в интерфейсе появились иконки/подписи browserAct ⚡, browserEval 🧪,
   browserDOM 🧩, browserOverlays 🪟; в промпте — блок «БЫСТРЫЙ ПУТЬ» (сначала карта,
   действуй по ref/имени, известную последовательность — одним вызовом browserAct).
   Алиасы: `browser_act`, `act`, `steps`.

### Заодно (нашлось тестом)
- `listPages()`: у `Browser` playwright метод `pages()` асинхронный, у `BrowserContext` —
  синхронный. Из-за этого подхват вкладок падал с «pages is not iterable». Теперь список
  различает оба случая, добавлен `allPages()` для асинхронного пути.

### Проверки
- smoke-тесты **210/210** (+9, все поведенческие на подставном Playwright): клик по кнопке,
  которой ещё нет (появляется через 250 мс), клик по элементу во вложенном фрейме (в ответе
  «фрейм»), submit у browserFill, цепочка browserAct из 5 шагов (порядок клик → ввод+Enter →
  клавиша), остановка на первом сбое с подсказками, мусор в steps, пауза `browserWait { ms }`,
  цепочка, начатая с `goto`, связка инструмента с main.js/интерфейсом/промптом.
- **Проверено на сломанном коде**: с выключенным поиском по фреймам тест фрейма падает —
  значит проверка реальная (после проверки код возвращён).
- `node --check` по изменённым файлам — чисто; OTA-бандл **1.5.39** собран.

## 1.5.40 — панель плана появляется и тогда, когда модель пишет план текстом

Жалоба: «он план составляет… но панели нету с маленькими чекбоксами где помечается галочкой
что выполнено а что нет». Панель есть и работает, но питалась ТОЛЬКО инструментом `todoWrite`.
Слабые модели (в песочнице — GLM 5.3) план структурой не присылают: пишут его текстом ответа
(«План: 1. … 2. …»), поэтому чеклист оставался пустым.

### Найдено (два бага)
1. **Веб-версия в План-режиме отправляла ПУСТОЙ список инструментов** — `tools: planMode ? [] :
   TOOL_DEFINITIONS` в web-цикле app.js. В десктопе это уже починили (main.js шлёт
   `PLAN_MODE_TOOL_DEFINITIONS`), а браузерный путь остался со старым обнулением: модель
   физически не могла вызвать `todoWrite` → план приходил текстом → панель пустая.
2. **Текст ответа панель не питал вообще.** Даже когда план был написан словами, интерфейс
   его игнорировал.

### Что сделано
- **Разбор плана из текста** (app.js, блок «План работ»): `planLinesFromText` / `planTitleFromText` /
  `planFromText`. Заголовок («План», «План работ», «План действий», «Шаги», «Порядок действий»,
  «Todo», с `**\*\*`, `#` и двоеточием) + список пунктов («1.», «- », «•», «- [x]»), либо блок
  строк-чекбоксов ✅/⬜/🔄/⚠️ без заголовка. Пункты идут в тот же `normalizePlanTasks`, что и
  данные `todoWrite`, поэтому лимит (7), статусы и чистка маркеров общие.
- **Приоритет — план модели.** `planFromText` не трогает план из `todoWrite` (`source: "model"`);
  когда модель присылает структуру, текстовый план уходит в `planHistory`. Повторный разбор того
  же текста статусы не сбрасывает (сравниваются пункты).
- **Галочки двигает работа.** У текстового плана модель статусов не присылает, поэтому
  `planRoundStarted(chat, segId)` вызывается из `ensureSegmentForText`: новый сегмент ответа
  (текст/размышления после действий) = новый раунд → предыдущий пункт «done», следующий
  «in_progress». Один пункт на раунд (защита `advancedFor`), провал инструмента по-прежнему
  отмечает `planToolOutcome` («failed»), а `planTextFinish` на событии `done` закрывает
  незакрытый пункт. План модели текстовый прогресс не трогает — там статусы ведёт сама модель.
- **План из текста хранится как `source: "text"`** и переживает перезапуск: `sanitizeChats`
  больше не выдаёт его за «model» (и по-прежнему выбрасывает legacy «auto»).
- **Связки:** `tool_start` и `done` разбирают текст ответа (`runTextOf` → `planFromText` →
  `renderPlanPanel`); в веб-версии результат `todoWrite` в План-режиме честно говорит «жди команды
  Выполнить», а не «продолжай со следующего пункта».

### Проверки
- smoke-тесты **216/216** (+5): текст «План: 1. …» становится панелью (счётчик 0/4, заголовок,
  чистые пункты), повторный разбор не сбрасывает статусы, галочки идут по раундам (сбой не
  двигает вперёд, `planTextFinish` закрывает шаг), обычный ответ планом НЕ становится
  (нумерованный список без заголовка, «План такой: …» в прозе, один пункт, одиночный ✅),
  блок чекбоксов признаётся планом, план модели важнее текстового, связки событий
  (tool_start/done/ensureSegmentForText) и веб-путь с `PLAN_MODE_TOOL_DEFINITIONS`.
- **Проверено на сломанном коде** (три мутации): отключённый разбор текста → падают 3 теста,
  `planTextAdvance(chat, false)` вместо `true` → падает тест раундов, «любая строка = пункт»
  → падает тест ложных срабатываний. Код возвращён, 216/216.
- `node --check` по app.js и smoke.test.js — чисто; OTA-бандл **1.5.40** собран.

## 1.5.41 - prokrutka, navedeniye, set, ozhidaniye pokoya i spravochniki po saytam

ZHaloba: polovina elementov byla za ekranom, menu ne raskryvalos, posle klika gadal chto otvetil server, 30 minut bluzhdaniy po Google Cloud. Vosem konkretnykh instrumentov iz wishlist - realizovany vse.

Chto sdelano (kritichno + uskoryaet):

1. browserScroll - prokrutka stranitsy i vnutrennikh konteynerov (spiski API, tablitsy, vypadayushchiye menyu), plyus prokrutit do elementa. Krutit nastoyashchim kolesom myshi (lenivyye lenty podgruzhayutsya), po neobkhodimosti programmo; yesli stranitsa ne sdvinulas (SPA s vnutrennim skrollom) - govorit chto nuzhno ukazat container. V otvete - chto vidno v kadre SEYCHAS s ref: spisok elementov + podskazka vnukh ekrana eshche N, poetomu agent mozhet klikat srazu bez povtornoy karty.

2. browserHover - navedeniye myshi (nastoyashchee cherez Playwright, fallback v DOM-sobytiya). Posle navedeniya - kakie NOVYYE elementy poyavilis (tekst + ref): agent vidit raskroye menu/podskazku i klikaet po nim srazu.

3. browserNetwork - chto stranitsa REALNO otpravila i chto otvetil server (metod, URL, status, content-type, telo otveta do 4KB dlya JSON/text). Statika otsleyivayetsya po umolchaniyu; all: true - vklyuchaya. Zhurnal odayet NOVOYE s proshlogo vyzova i ochishchayetsya - agent sprashivayet srazu posle deystviya i vidit oshibku 401/403/500 s tekstom tela otveta.

4. waitForIdle - zhdyot kogda DOM perestanet menyatsya i set opusteyet (Angular/React pererisovki). V otvete - skolko mutatsiy i zaprosov bylo, skolko zhдал. Posle etogo browserSnapshot dayet aktualnuyu kartu, ref ne ustareyut.

5. Spravochniki po saytam (agentGuide) - vstroyennye (src/agent-guides/*.md) + izuchennye agentom (userData/agent-guides/). V shapke faila <!-- sites: console.cloud.google.com --> pri browserOpen sayt avtomaticheski poluchayet podskazku. Posle USPESHOGO prokhoda agent mozhet sokhranit marshrut. Sozdanы gaidы: google-cloud.md (proekt -> API -> klyuch, steny soglasiya, pryamye URL) i github.md (repositorii, tokeny, PR, poisk po t). Staryy readFile teper ishchet i izuchennye spravochniki.

6. Avto-vision na skrinshote - browserScreenshot VSEGDA razbiraetsya vision-modelyu kogda ukazana model i klyuch (bolshe ne trebuyetsya galochka Zrenie). Vopros: chto vidno, chto klikabelno, chto meshayet, chto za predelami ekrana. Pri otsutstvii klyucha - chetkaya podskazka kak vklyuchit.

7. Kniga UI-patertnov v prompte (pravilo 33) - Material-select != select (klik -> sloyi -> punkt po tekstu), avtokomplit (vvvel 2 bukvy -> zhdyom -> podskazka klikom/strelki), dlinnye spiski (iskat cherez filtr a ne skrollit), prozrachnye chekboxy (opacity: 0), data-pikery/derevya (scroll do elementa -> klik), dialogi poverkh stranitsy (rabotat s nimi pervym). Pravilo 34 - spravochniki i pamyat marshrutov.

8. Yadro instrumentov (tesnyy kontekst) - v CORE dobavleny: browserOpen, browserSnapshot, browserClick, browserFill, browserAct, browserScroll, browserHover, browserScreenshot, browserNetwork, waitForIdle, browserEval, browserOverlays, agentGuide. Raneye pri <26K tokenov brauzernye instrumenty voobche ne shlis.

Svyazki i provodka: main.js - cases + auto-hint po spravochniku + readFile chitayet izuchennye gaidy; agent-core.js - opredeleniya + aliasy + pravila 33-34; app.js - ikonki i podpisi; browser-tools.js - osnova + in-page funktsii.

Proverki: smoke-testy 228/228 (+12); mutatsionnaya proverka bodies:false -> test teryayet telo otveta; node --check chisto; OTA-bandl 1.5.41, sha256 sovpal, 32 fayla svereny.

## 1.5.42–1.5.45 — ускорение агента, фикс «[object Promise]» и монохромный чат

Пользователь: «он открывает достаточно медленно всё… есть варианты ускорить его действия», затем
разбор из 7 пунктов с приоритетом «эффект/риск». Сделаны шесть безопасных (батчинг, кэш промпта,
JPEG-скриншоты, живая PowerShell, ожидание событий, порог компакции), плюс отдельно поставленный
фикс ошибки vision и ранее запрошенный чёрно-белый чат без тяжёлых эффектов.

### 1. Батчинг независимых read-only инструментов (main.js)
- Новое множество `PARALLEL_SAFE_TOOLS` — только чтение без побочных эффектов и без диалогов
  (readFile, listDirectory, searchFile/Project, gitStatus/Log/Diff, listProcesses, checkUrl,
  webSearch/Fetch, memoryList, agentGuide, vaultList и т.п.).
- В `runAi`: если раунд целиком состоит из таких вызовов, они идут через `Promise.all` (сначала все
  `tool_start`, затем все `tool_result`), результаты так же обрезаются до 8000 символов. Любой
  пишущий/интерактивный инструмент возвращает строгую последовательную очередь — порядок и
  подтверждения не меняются.
- Промпт: правило 35 (не тратить раунды на мелочи; не объединять зависимые вызовы и инструменты
  с побочными эффектами).

### 2. Кэш префикса промпта (agent-core.js)
- `cacheableProvider(provider, base, model)` — точки кэша только там, где провайдер их понимает:
  Anthropic напрямую и OpenRouter для Claude/Gemini. Строгим OpenAI-совместимым API поле не
  отправляем (иначе 400).
- `withCacheOnFirstSystem(msgs)` — `cache_control` на ПЕРВОМ system-сообщении (стабильный префикс
  сессии: САММАРИ ПРОЕКТА + рабочая директория). У Anthropic кэш покрывает и блок tools — точка
  ставится на последнюю схему инструмента, а system уходит массивом блоков.

### 3. Скриншоты в JPEG (main.js, app-ui-tools.js, browser-tools.js)
- `encodeShot(img, args)` (main.js): длинная сторона ужимается до 1440 px, JPEG q72 по умолчанию,
  `png:true`/`format:"png"` — точный PNG для OCR мелкого текста. Используется в `screenshotCapture`,
  `screenshotDesktop` и `screenshotUrl`.
- `saveScreenshotPng(buf, baseName, mime)` пишет расширение по mime (`.jpg`/`.png`).
- `browser-tools.js` `screenshotFile` → `type:"jpeg", quality` (png при `png:true`/`fullPage`), mime
  возвращается в результате и в data URL. `app-ui-tools.js` — та же логика для окна приложения.

### 4. Живая сессия PowerShell (src/win-ps.js + main.js)
- `src/win-ps.js` (новый): один долгоживущий `powershell.exe`, скрипты читаются из stdin в base64,
  вывод между маркерами (`__AI_PS_BEGIN__/END/EXIT`), рукопожатие до первой команды, простой 5 мин,
  после провала повтор не раньше чем через 5 мин. Любой сбой → `{ noSession: true }`.
- `psScript(script, ms)` — сессия, иначе прежний разовый `powershell.exe -Command` (поведение
  инструментов не меняется ни в одном сценарии). `cachedPs(key, ttl, fn, isBad)` +
  `invalidatePsCache(prefix)`: `getSystemInfo` (CIM) — 30 с, `listProcesses` (tasklist) — 2 с,
  `registryRead` — 5 с. Инвалидация: `killProcess` чистит `proc:`, `registryWrite` — `reg:`.

### 5. Ожидание событий вместо фиксированных пауз (browser-tools.js)
- `waitUntil(fn, timeoutMs, pollMs)` — опрос условия с жёстким потолком; `readScrollY(page)`.
- Применено: `resolveTarget` и `wait` (адаптивный опрос 80/100 мс → 400 мс вместо фиксированных
  200/400), `scrollPage` (ждём сдвиг прокрутки), `wheelAt` (ждём изменение позиции + короткая
  страховка на инерцию), `hover` (ждём ПОЯВЛЕНИЯ новых элементов, а не 400 мс вслепую).

### 6. Порог компакции с запасом (main.js)
- `histBudget = Math.max(1500, Math.floor((budget - toolsWeight) * 0.85))` — 15% окна остаётся
  резервом, чтобы сжатие успевало сработать ДО переполнения (раньше история могла упереться в
  лимит между раундами).

### 7. Фикс «[object Promise]» в vision (agent-core.js + main.js)
- `fmtError(e)` (новый экспорт): Error → message; промис → «Promise вместо ошибки (в коде забыт
  await)»; объект → JSON (до 500 символов). Подставлен в `catch` у `executeTool`, в батчинг-ветке и в
  сообщениях describeImageRemote/generateImageRemote.
- `readApiError(res)` асинхронная и читает тело: вызовы теперь `await readApiError(res)` ДО
  `res.json()` (без await в текст ошибки попадал сам промис).
- `normalizeAuxBase(url)`: `generativelanguage.googleapis.com` → `/v1beta/openai` (у Gemini
  OpenAI-совместимый путь живёт только там; «голый» /v1 давал 404).

### 8. Монохромный чат без тяжёлых эффектов (src/renderer/monochrome.css, styles.css, index.html)
- Новый слой `monochrome.css` подключается ПОСЛЕ styles.css: глобально гасит `backdrop-filter`
  (32 объявления, до blur(24px) — главный источник «жевания» при стриминге), `text-shadow`,
  `box-shadow`; выключает бесконечные декоративные анимации (логотип, блик, туманность, скан-линия)
  и убирает их псевдоэлементы; плоские поверхности вместо градиентов и неона.
- Сознательно оставлено: мгновенные микро-отклики на наведение (цвет/граница) и мигание
  индикаторов состояния (курсор стриминга, точки «думаю»/«в работе»), фокус-кольца — доступность.
- Токены styles.css переведены в строгую чёрно-белую палитру (#0a0a0b … #f4f4f5), theme-color — #0a0a0b.

### Проверки
- smoke-тесты **239/239** (+11: батчинг и правило 35, JPEG/PNG-скриншоты и mime, резерв компакции,
  кэш промпта (Claude — да, строгий OpenAI — нет), ожидание событий, три теста живой PowerShell
  (рукопожатие, откат, проводка в справки и инвалидация кэша)).
- `node --check` по main.js, win-ps.js, browser-tools.js, app-ui-tools.js, agent-core.js, app.js — чисто.
- OTA-бандл **1.5.45** собран (`node scripts/make-ota.js --version 1.5.45`); manifest и bundle сверены
  с диском побайтово: 36 файлов, расхождений нет, лишних файлов вне бандла нет.
- package.json приведён к 1.5.45 (раньше бандл убежал вперёд кода — теперь версия кода, бандла и
  вложенного package.json совпадают).
- Пункт 3 из разбора (роутер инструментов: 146 → ~40 схем) НЕ делался осознанно — он самый
  рискованный и по плану идёт последним, с обязательным запасным ходом «полный список по запросу».
  Динамический отбор уже есть (`selectTools`: все инструменты при окне ≥ 26k, иначе ядро).

## 1.5.46 — кэш промпта не срывается динамикой, метрики токенов в «Консоль»

Разбор шёл под API-провайдеров; пользователь задал приоритет: **свой OpenAI-совместимый →
потом локальный (Ollama) → потом всё остальное**. Это только порядок: механизмы общие.

### Что нашлось (цифрами)
- Шапка запроса у API-провайдеров ВСЕГДА максимальная: `selectTools(budget >= 26k)` отдаёт все
  146 схем (~22 000 токенов) — у API окна ≥26k практически всегда. Плюс системный промпт
  28 598 символов (~7 950 токенов). Итого ~30 000 токенов в КАЖДОМ раунде (до 25 раундов ×
  5–15 с TTFT). «Ядро» (при окне <26k) — 63 схемы, ~11 200 токенов, и в нём НЕТ ни одного
  git-инструмента.
- Точка кэша стояла на ВСЁМ первом system-сообщении, а в нём склеены статичный `SYSTEM_PROMPT`
  и динамический «паспорт проекта» (`buildProjectBrief`: дерево до 80 записей, скрипты, начало
  README). Дерево меняется при любом создании/переименовании файла, а кэш блоков у Anthropic/
  OpenRouter — единица целиком: промах обнулял весь кэш, то есть ~30k токенов считались заново
  почти каждый виток. (Для автоматического префикс-кэша OpenAI/DeepSeek/Groq эта же раскладка
  безвредна — там важен совпадающий префикс токенов.)
- `usage` из ответов НЕ читался вообще: ни токенов, ни попаданий в кэш — то есть все
  оптимизации контекста проверялись на веру.

### Что сделано
1. **Кэш накрывает только статичный префикс** (agent-core.js): `splitStaticSystem(text, staticText)`
   + `anthropicSystem(sysText, cacheKind, staticText)`; `withCacheOnFirstSystem(msgs, staticText)`
   для OpenRouter (Claude/Gemini). Динамика (рабочая директория, паспорт проекта, режим плана,
   подсказка после клонирования) уходит СЛЕДУЮЩИМ блоком без `cache_control`. main.js передаёт
   `staticSystem: SYSTEM_PROMPT` в `buildChatRequest`. Без границы поведение прежнее (один блок).
2. **Токены и кэш** (agent-core.js): `stream_options: { include_usage: true }` для
   OpenAI-совместимых — только по флагу (Anthropic/Ollama его не понимают и получать не должны);
   `onUsage` в `consumeProviderStream` (OpenAI-совместимые — `usage` в финальном чанке,
   Anthropic — `message_start`/`message_delta`, Ollama — `prompt_eval_count`/`eval_count`) и
   `normalizeUsage` (`prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` /
   `cache_read_input_tokens` → единый вид `{prompt, completion, cached}`).
3. **Откат для строгих серверов** (main.js): 400/422 с упоминанием stream_options → флаг гасится
   на весь запуск, раунд повторяется; отказ ВНУТРИ стрима ловится в авто-повторе по тексту ошибки.
   То есть незнакомый параметр не может сломать работу — максимум один лишний запрос.
4. **Строка метрик в «Консоль»** на каждый раунд: `раунд N/25 · схем 146 (~22026 т.) ·
   токены 29042→512 · кэш 26880 (93%) · TTFB 1.2 с · всего 3.4 с`. Проводка: `termEmit({type:
   "metrics"})` → app.js `onTermEvent` → `termServerAppend` с классом `.ts-metrics` (стиль в
   styles.css, табличные цифры).

### Проверки
- smoke-тесты **245/245** (+6: граница статичного префикса, два блока у OpenRouter+Claude,
  блоки system + кэш схем у Anthropic, stream_options только у OpenAI-совместимых,
  нормализация usage трёх провайдеров, проводка метрик и оба отката stream_options).
  Тест поймал ошибку в самом тесте: в `SYSTEM_PROMPT` есть фраза «САММАРИ ПРОЕКТА» (правило,
  объясняющее этот блок) — маркером динамики она быть не может, заменили на `/home/user` и 📁.
- `node --check` по main.js, agent-core.js, app.js — чисто.
- OTA-бандл **1.5.46**, package.json и версия бандла совпадают.

### Что дальше (по приоритету API → локальный → остальные)
1. **Роутер инструментов** (146 → ~40 схем ≈ 6–7k токенов) — главный рычаг: и деньги, и TTFT.
   Обязательно: канонический порядок БЕЗ сортировки по релевантности (иначе рушим кэш и
   переиспользование префикса) + три предохранителя (авто-добавление схемы по имени при вызове,
   мета-инструмент `findTools`, чекбокс «все инструменты» с авто-расширением при ошибке).
   Строку со 144 именами инструментов из промпта НЕ удалять — это страховка роутера.
2. **Промпт-диета** 7.9k → ~4.5k: правило 21 «Браузер» (1 383 токена), правила 33–35 (1 072),
   YC (287) → в `src/agent-guides/` (механизм `agentGuide` уже есть). Номера правил сохранять —
   на них ссылаются тесты.
3. **Честный бюджет**: из `histBudget` вычитать системный промпт (`fixedWeight`), а не только
   схемы; при нехватке резать инструменты, а не историю; git-минимум в `CORE_TOOL_NAMES`.
4. **Ollama последним**: `options.num_ctx` (сейчас НЕ передаётся вовсе, а `modelWindow` для Ollama
   всегда 0 → внутренний бюджет 14 000 врёт против реального окна 2048–4096), `keep_alive`
   (дефолт 5 мин выгружает модель между раундами), реальное окно через `POST /api/show`.

## 1.5.47 — роутер инструментов (146 схем → база + группы)

Было: в КАЖДОМ раунде уходили все схемы (~24.7k токенов только на инструменты; плюс системный
промпт ~8k и история). API-провайдеры с окном ≥ 26k всегда получали полный набор — это и деньги,
и время до первого токена. Теперь:

1. **Реестр групп** (`agent-core.js`): 37 базовых схем + 13 групп (`git`, `browser`, `system`,
   `project`, `files`, `terminal`, `notes`, `mail`, `vault`, `app`, `preview`, `ota`, `cloud`).
   Реестр покрывает все схемы ровно один раз (тест это проверяет).
2. **`routeTools({ text, sticky, forceAll, maxTokens })`** — чистая функция: база + группы,
   активированные словами запроса, липкие на всю задачу. Порядок схем ВСЕГДА канонический
   (иначе промахивается кэш префикса из 1.5.46). Группа, не влезшая в потолок, попадает в
   `dropped` (видно в «Консоли», не теряется молча).
3. **Проводка в `runAi`**: пересборка набора в начале каждого раунда, липкие группы, метрика
   раунда показывает число групп и срезанные группы.
4. **Предохранитель A** — модель вызвала реальный инструмент вне набора → его группа
   добавляется на ходу и попадает в следующий запрос (+строка в «Консоль»).
5. **Предохранитель B** — мета-инструмент `findTools` (в базе всегда): поиск по имени/описанию
   и по ключевым словам групп, русские запросы («запуш в github», «отправить письмо»), включает
   найденные группы целиком. `searchTools` детерминирован (канонический порядок внутри группы).
6. **Предохранитель C** — чекбокс «Отправлять все инструменты» (`settings.sendAllTools`):
   аварийный режим, когда модель «не видит» нужное.
7. **Честный бюджет** — вес системного промпта вычтен из бюджета истории и виден в индикаторе
   контекста; при тесном окне один раз в «Консоль» уходит понятное предупреждение.

Замеры после правки: база ~6.1k токенов (37 схем) вместо ~24.7k (147) — экономия ~75% на тихой
задаче; группа «браузер» (~5k) включается только когда речь о сайтах. Тесты: 252/252.

Осталось по плану: промпт-диета (8k → ~4.5k), Ollama (`num_ctx`, `keep_alive`, окно через
`/api/show`), и проверка Anthropic/G4F после разделения system-блоков.

## 1.5.48 — этап 4 (промпт-диета) и этап 5 (честный бюджет + git в ядре)

### Этап 4: правила уехали в справочники, промпт похудел на четверть
- `SYSTEM_PROMPT`: **28 046 → 20 282 символа (≈7 791 → 5 634 токена, −28%)**. Цель плана была
  ~4.5k — недобрали: в промпте остались уже сами рабочие правила, а не справки; дальше это
  только удаление поведения, поэтому остановились на 5.6k.
- Что сжато и куда переехало (номера правил сохранены — на них ссылаются тесты):
  - 21 «Браузер» (была самой большой, ~1.4k токенов) → `src/agent-guides/browser.md`: быстрый
    путь, слои/диалоги, прокрутка, сеть, скриншот+зрение, интерфейсы сайтов (Material-select,
    автокомплиты, длинные списки, прозрачные чекбоксы, дата-пикеры), входы/пароли/сессии
    (vaultFill, browserConnect), капча и 2FA.
  - 33 «интерфейсы сайтов» и 34 «справочники» → browser.md, раздел «Интерфейсы сайтов».
  - 20 «Windows и системные операции» → `src/agent-guides/system.md`.
  - 22 «своё окно приложения» → `src/agent-guides/app.md`.
  - 28 «Yandex Cloud» → `src/agent-guides/yc.md`.
  - 35 «батчинг» в гайд НЕ уезжал (нужен каждый раунд) — переписан короче, смысл тот же.
- **Ничего не потеряно**: сверено, что каждая уехавшая фраза есть в гайде (browserConnect,
  «vaultFill подставляет логин и пароль прямо в форму», «вызови shellsStatus», «номер [N]
  устаревает при любой перерисовке», «внутренним API … Cloud Logging», «НЕ скролль вручную»,
  «opacity: 0», «Дата-пикеры», «terms of service) молча не подтверждай»).

### Авто-подключение справочников (чтобы диета не стоила модели контекста)
- `main.js`: карта `GROUP_GUIDES = { browser, system, app, cloud }`. Когда группа включается
  роутером, её гайд один раз за задачу добавляется system-сообщением ПОСЛЕ системного промпта
  (`guideNotes` + `messages: [canonical[0], ...guideNotes, ...canonical.slice(1)]`), в «Консоль»
  идёт строка «📘 Подключён справочник …», а история диалога не засоряется.
- Стоимость: гайд приходит только вместе со своей группой (browser ~4k токенов и только когда
  задача про сайт) вместо 1.4k в каждом запросе у всех.

### Этап 5: честный бюджет и git в ядре
- `systemWeight = estimateTokens(SYSTEM_PROMPT)` вычитается из бюджета истории
  (`histBudget = (budget − toolsWeight − systemWeight) × 0.85`) и виден в индикаторе контекста
  (`used = histTokens + toolsWeight + systemWeight`, поле `system` уходит в UI). Раньше
  индикатор занижал заполнение на ~6k и сжатие срабатывало позже, чем нужно.
- Один раз за запуск — понятное предупреждение в «Консоль», если схемы + промпт занимают >90%
  окна (иначе агент «тупеет» без объяснений).
- `CORE_TOOL_NAMES` (тесное окно <26k): добавлены `gitStatus, gitDiff, gitLog, gitCommit,
  gitBranch, gitPush, gitPull, gitInit` — приложение про репозитории, а на узком окне git
  исчезал целиком; `findTools` теперь в ядре всегда (иначе узкий набор нечем расширить).

### Проверки
- smoke-тесты **252/252**. Восемь тестов искали переехавший текст прямо в `SYSTEM_PROMPT` и
  падали. Введён хелпер `modelPrompt()` = `SYSTEM_PROMPT` + автоподключаемые справочники (список
  берётся из `GROUP_GUIDES`, отсутствие файла гайда — падение теста); на него переведены проверки
  app-инструментов, vault, YC, shellsStatus, browserConnect, слоёв поверх страницы, browserAct и
  книги UI-паттернов. Тест падает, если гайд не подключён или текст из него пропал, — то есть
  проверяет РЕАЛЬНЫЙ контекст модели, а не только исходник agent-core.js.
- `node --check` по всем JS бандла (25 файлов) — чисто (внутри `make-ota`).
- OTA-бандл **1.5.48**. Важно: бандл 1.5.47 содержал только 4 старых гайда — четыре новых
  (`app.md`, `browser.md`, `system.md`, `yc.md`) в него не попадали, то есть агент не получил бы
  из справок ни строчки. Пересобрано: **40 файлов, 8 гайдов**; диск и бандл сверены побайтово
  (0 расхождений), sha256 манифеста пересчитан и совпадает. `package.json` = версия бандла = 1.5.48.

### Что дальше
1. **Ollama** (последним по приоритету пользователя, но локальная модель уже подключена):
   `options.num_ctx` сейчас НЕ передаётся, а `modelWindow` для Ollama всегда 0 — внутренний бюджет
   14 000 врёт против реального окна 2048–4096; `keep_alive` (дефолтные 5 мин выгружают модель
   между раундами); реальное окно через `POST /api/show`.
2. Проверка Anthropic/G4F после разделения system-блоков в 1.5.46 (кэш + два блока).
3. Ужимать промпт ниже 5.6k — это уже удаление поведения, а не справок: обсуждать отдельно.


## 1.5.49 — Anthropic и G4F после разделения system на два блока (проверка 1.5.46)

Проверялось, как ведут себя оба конца спектра после того, как в 1.5.46 статичный префикс
промпта отделили от динамики, а в 1.5.48 к запросу добавились справочники групп.

### Anthropic — порядок верный, подтверждено тестами
- `systemText()` склеивает ВСЕ system-сообщения в один текст (промпт + паспорт проекта +
  справочники + служебные заметки), `messagesForProvider("anthropic", …)` выкидывает system из
  `messages`, `anthropicSystem()` режет склейку по границе `SYSTEM_PROMPT`: точка кэша ровно на
  статике, динамика и справочники — вторым блоком без неё.
- Заметка «⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА» (main.js добавляет её в середину диалога) тоже уходит в
  верхнеуровневый `system` — Anthropic system внутри `messages` не принимает. Проверено тестом.
- Ничего не теряется: справочники и паспорт проекта присутствуют в блоке-хвосте; точек кэша
  в запросе ровно две (статичный system + последняя схема инструмента), лимит Anthropic — 4.

### G4F — нашли реальный риск и закрыли
- Проблема: справочники (1.5.48) добавляют до четырёх system-сообщений ПОДРЯД, а строгие
  OpenAI-совместимые серверы (g4f, Yandex AI Studio, свои сборки-прокси) ждут system в начале
  диалога и часто одним сообщением. То есть диета промпта могла обернуться 400 у G4F.
- Решение: `mergeLeadingSystem(messages)` в agent-core.js — склеивает ИДУЩИЕ ПОДРЯД ведущие
  system в одно сообщение с разделителем `\n\n` (тем же, что у Anthropic). Текст, порядок и
  границы не меняются, поэтому автоматический кэш префикса OpenAI/DeepSeek/Groq продолжает
  попадать (тот же префикс токенов), а форма запроса возвращается к «одна шапка» из 1.5.47.
  Одиночный system и служебные заметки в середине диалога не трогаются; исходный массив
  сообщений не мутируется.
- Подтверждено: у g4f-запроса один ведущий system (промпт + паспорт + справочники), `provider`
  уходит отдельным полем (маршрут «Провайдер:модель»), модель — без префикса, поля кэша
  (`cache_control`) и `stream_options` в запрос не попадают.
- OpenRouter+Claude: ведущие system склеиваются, затем первый блок делится на статичный
  (с точкой кэша) и хвост — точка кэша по-прежнему ровно одна.

### Проверки
- smoke-тесты **255/255** (+3: Anthropic со справочниками и служебной заметкой; G4F — один
  ведущий system, маршрут провайдера, отсутствие полей кэша и `stream_options`, неизменность
  исходного массива; OpenRouter со справочниками — одна точка кэша).
- Живой прогон против реальных Anthropic и G4F НЕ выполнялся: в этой среде нет ключей и не
  запущен g4f (порты 1337/8080 не отвечают). Проверка структурная — по телу запроса, который
  собирает `buildChatRequest`; запустить живой тест можно кнопкой «▶ Проверить» в настройках
  G4F (там логи видны в консоли приложения).
- OTA-бандл **1.5.49** (40 файлов, 8 гайдов), диск и бандл сверены побайтово, sha256 сошёлся.
  `package.json` = версия бандла.

### Что дальше (без изменений)
1. **Ollama**: `options.num_ctx` не передаётся, `modelWindow` = 0 (бюджет 14 000 врёт против
   окна 2048–4096), нет `keep_alive`, реальное окно через `POST /api/show`. Заодно решить, надо
   ли склеивать ведущие system и для Ollama: шаблоны части моделей читают только ПЕРВЫЙ system.
2. Справочники в Anthropic лежат в НЕкэшируемом хвосте (они идут после динамического паспорта
   проекта) — если понадобится, можно переставить так, чтобы промпт → справочники → паспорт, и
   тогда справочник тоже кэшируется. Сейчас выгода небольшая, поэтому не трогали.


## 1.5.50 — Ollama: реальное окно, нужный num_ctx и модель не выгружается между раундами

Последний пункт плана (пользователь ставил локальную модель третьей по приоритету, но она уже
подключена, и без этого агент на ней работал «вслепую»).

### Что было не так
- `contextBudget("ollama")` возвращал выдуманные 14 000 токенов, а `modelWindow()` отвечал 0 для
  всего, кроме OpenAI-совместимых. То есть реальное окно локальной модели приложение не знало.
- В `/api/chat` не уходили ни `num_ctx`, ни `keep_alive`. Ollama брала СВОЙ дефолт контекста
  (2048, в новых сборках 4096) и **молча** резала запрос, где только системный промпт ~5.6k и
  схемы инструментов ~6k: агент терял начало промпта и историю, а выглядело это как «модель
  тупая». Модель вдобавок выгружалась из памяти через 5 минут (дефолт `keep_alive`), и каждый
  раунд после паузы платил за повторную загрузку.

### Что сделано
1. `ollamaModelInfo(s, model)` (agent-core.js) — `POST /api/show`, кэш 10 минут:
   - окно = `<arch>.context_length`, где arch берётся из `general.architecture` (у старых сборок
     ключа архитектуры нет — ищем любой ключ с суффиксом `context_length`). Именно ключ
     архитектуры, а не максимум по всем: у мультимодальных моделей рядом лежит
     `gemma4.audio.context_length`, и максимум подменил бы окно модели окном энкодера;
   - `capabilities` → знаем про `tools` и `vision` (поля нет у старых сборок — тогда честно
     считаем, что НЕ знаем, и молчим: ложное предупреждение хуже молчания);
   - `parameters` → `num_ctx` из Modelfile (запасной источник окна).
2. `modelWindow()` теперь знает про Ollama (окно из `/api/show`).
3. `ollamaNumCtx(budget, window)` — сколько токенов просить: бюджет + 4096 на ответ и
   tool-результаты, но НИКОГДА больше реального окна. Без бюджета (0) параметр не отправляем —
   уменьшать окно модели без причины нельзя.
4. Запрос `/api/chat`: `options.num_ctx`, `keep_alive: "30m"` и один ведущий system
   (`mergeLeadingSystem` — шаблоны части моделей читают только первый system).
5. main.js: сохраняет реальное окно (`modelWin`) и передаёт его в сборку запроса; «пол» бюджета
   больше не может превысить окно (у модели с окном 2048 пол в 3000 гарантировал переполнение на
   каждом запросе); один раз в «Консоль» уходит предупреждение, если модель не умеет вызывать
   инструменты — иначе агент молча «разговаривал бы» и ничего не делал.

### Проверки
- smoke-тесты **259/259** (+4: окно из `/api/show` с кэшем и отсутствием ложного предупреждения
  на старых сборках; расчёт `num_ctx` (не больше окна, без бюджета — ничего); тело запроса
  `/api/chat` с `num_ctx`/`keep_alive`/одним system; wiring в main.js).
- Поля сверены с официальной документацией Ollama: `/api/show` принимает `model` и отдаёт
  `capabilities`, `parameters`, `model_info`; `keep_alive` (дефолт `5m`) и `options` (в том
  числе `num_ctx`, дефолт 2048) — валидные параметры `/api/chat`.
- **Живой прогон против Ollama не выполнялся**: в этой среде сервер не запущен (порт 11434 не
  отвечает), поэтому проверка структурная — по телу запроса, который собирает `buildChatRequest`.
  Настроек в интерфейсе не добавлялось: окно и `num_ctx` выводятся автоматически.
- OTA-бандл **1.5.50** (40 файлов, 8 гайдов), диск и бандл сверены побайтово, sha256 сошёлся.

### Что дальше
Пунктов плана не осталось. Кандидаты на будущее (по желанию): показывать окно модели и `num_ctx`
в метрике раунда; вынести `keep_alive` в настройки; учитывать серверный `OLLAMA_CONTEXT_LENGTH`.


## 1.5.51 — панель плана: план из размышлений, живое дописывание, видно текущий шаг

Жалоба: «план так и не показывается, как у тебя или у Replit… в размышлении он пишет о плане, а я
не вижу, как он ему следует и какой этап выполнил». Панель питалась ТОЛЬКО инструментом
`todoWrite` и текстом ответа — а модели (особенно локальные) формулируют план в размышлениях:

```
Продолжаю. Нужно запустить проект. По анализу: это Express + React + Vite + Drizzle ORM…
План уже составлен. Сейчас нужно:
1. Проверить .env, package.json, как сервер стартует
2. Решить вопрос с БД — сервер рассчитан на PostgreSQL + Drizzle
```

Тут сразу два промаха: размышления в разбор не попадали вовсе, а заголовком считалась только
ОТДЕЛЬНАЯ строка «План:» — фраза «…Сейчас нужно:» не подходила. Панель оставалась пустой.

### Что сделано
1. **Размышления — часть текста запуска**: `runTextOf()` теперь склеивает и `thinking`, и
   `content` каждого сегмента. Разбор работает и когда план написан только в рассуждениях.
2. **Разбор на стриме, а не только на вызове инструмента**: `tryPlanFromRunText()` вызывается на
   `chunk`, `thinking`, `tool_start` и `done`. Внутри дешёвый гейт (меньше двух переводов строк —
   регекспы не гоняются), поэтому на каждом куске стрима разбор не идёт.
3. **Заголовок в конце фразы** (`PLAN_TAIL_RE`): «План уже составлен. Сейчас нужно:», «Дальше по
   шагам:», «Теперь надо:» — ключевое слово обязательно, иначе любой абзац «что нужно:» со списком
   выглядел бы планом. Требование «≥2 пунктов» и запрет на список без заголовка сохранены
   (тест «обычный ответ панелью не становится» проходит как раньше).
4. **Живое дописывание пунктов**: пока модель печатает список, очередной кусок стрима даёт тот же
   план с добавленным пунктом — это НЕ новый план. Такой план в историю не убирается, а статусы уже
   пройденных пунктов сохраняются (иначе галочки прыгали бы назад на каждом куске).
5. **Видно текущий этап**: в свёрнутой панели появился чип с текущим шагом
   («🔄 Починить хост» + счётчик 1/3, стиль `.plan-active`), а первый пункт становится «в работе»
   сразу с первым вызовом инструмента, а не после конца раунда.

### Проверки
- smoke-тесты **264/264** (+5: план из размышлений на реальном тексте из жалобы, размышления внутри
  `runTextOf`, гейт по строкам, дописывание пунктов без засорения истории и без сброса галочек,
  текущий шаг в свёрнутой шапке, старт работы). Игрушечная среда теста плана дополнена
  `session`/`runSegments` — раньше срезанный блок плана их не видел.
- `node --check` по app.js и тестам — чисто; `make-ota` проверил все 25 JS бандла.
- OTA-бандл **1.5.51**: диск и бандл сверены побайтово, sha256 сошёлся, `package.json` = версия бандла.
- **Визуально в приложении не проверял**: окно Electron в этой среде не поднять. Проверка — на
  игрушечной DOM-панели и по исходникам; живой вид панели стоит глянуть в приложении на том же
  запросе про Express + Vite + Drizzle.

### Что дальше
Пунктов плана не осталось. Кандидаты на будущее (по желанию): показывать ход текстового плана
точнее (по вызовам инструментов, а не по раундам); кнопка «свернуть/развернуть» по умолчанию
свёрнута после завершения плана; показывать окно модели и `num_ctx` в метрике раунда.


## 1.5.52 — вход с телефона: мост не отдавал монохром, кнопка «Подключиться» уезжала под клавиатуру

### Что болело
Пользователь: «кнопка "Подключиться" после ввода поля пропала, на телефоне не работает; сделай страницу входа компактнее и красивее».

Две отдельные причины.

1. **Кнопка была недоступна из-за клавиатуры.** Оверлей `#mobile-gate` создавался с фиксированной
   центровкой (`position:fixed; inset:0; display:flex; align-items:center; justify-content:center`).
   На телефоне экранная клавиатура уменьшает видимую область, а `inset:0` считает её от полного окна:
   карточка оставалась отцентрованной по невидимой высоте, поле ввода уезжало вверх, а кнопка — за
   нижнюю границу (в iOS Safari — под клавиатуру). Дотянуться до неё было нечем: «кнопка пропала».
2. **Мобильный мост не отдавал половину интерфейса.** В `handleHttp` был жёсткий список файлов
   (index.html, styles.css, app.js, agent-core.js, markdown.js, mobile-api.js, bootstrap.js) — в нём
   не было `monochrome.css` и `highlight.js`. Телефон получал «неоновую» тему 2100 вместо монохрома,
   а без highlight.js молча терялась подсветка кода (в app.js вызов `window.Highlight` защищён).

### Что сделано
- `src/mobile-bridge.js`: список файлов вынесен в `STATIC_FILES` и дополнен `monochrome.css` и
  `highlight.js`; `handleHttp` проверяет `STATIC_FILES.has(safe)`. Отдача по-прежнему только из
  `renderer` и только по basename — `/../package.json` → 404 (закреплено тестом).
- `src/renderer/mobile-api.js`: гейт переписан. Вместо инлайн-стилей — один инжектируемый
  `<style id="mobile-gate-css">` (классы `mg-*`, плоский монохром в тон приложения: фон #0a0a0b,
  карточка #141417, светлая кнопка).
- **Клавиатура больше не перекрывает кнопку:** высота оверлея связывается с
  `visualViewport.height/.offsetTop` (`syncGateViewport`, слушатели resize/scroll + resize/orientationchange),
  карточка центрируется через `margin:auto` в скроллируемом `.mg-wrap` (min-height:100%) — при любой
  видимой высоте остаётся достижимой; добавлены `env(safe-area-inset-*)` и `-webkit-overflow-scrolling:touch`.
- **Автоподключение с шестой цифрой:** обработчик `input` чистит нецифры и при 6 цифрах сам отправляет
  PIN (задержка 220 мс, `gateBusy` защищает от повторной отправки) — кнопка нужна лишь как запасной
  путь. Плюс `enterkeyhint="go"`, `inputmode="numeric"`, `type="tel"`.
- **Компактнее и понятнее:** логотип-плитка + название + одна строка подсказки, поле моношрифтом с
  умеренным трекингом, кнопка с `touch-action:manipulation`, статус и ошибка двумя компактными
  строками, внизу — адрес ПК и кнопка «Переподключиться» (пересоздаёт сокет, когда сменился Wi-Fi).
- **Состояния:** `setGateBusy` (кнопка гаснет и подписывается «Соединяюсь…» / «Проверяю PIN…»),
  `resetPinField` после неверного PIN (раньше шесть уже введённых цифр блокировали набор новых),
  отдельное сообщение при `auth_err {lock:true}` («Вход заблокирован на 5 минут»), `connect()` не
  поднимает второй сокет, если соединение уже живо.

### Проверки
- smoke-тесты **268/268** (+4): мост реально отдаёт `/monochrome.css` и `/highlight.js` (живой HTTP
  на свободном порту, проверка содержимого и 404 на `/../package.json`); три проверки страницы
  входа — клавиатуробезопасная раскладка, автоподключение/чистка PIN/`enterkeyhint`, состояния
  (сброс поля, блокировка, «Переподключиться», busy-состояние кнопки).
- Структурная сверка разметки и CSS разовым скриптом: все классы/id из HTML описаны в стилях,
  скобки сбалансированы, ключевые правила на месте.
- **Вживую в браузере/на телефоне не проверял**: в этой среде нет бинарника Chromium для Playwright
  (окно Electron тоже не поднять). Смотреть на телефоне: Настройки → «Мобильный доступ» →
  `http://<IP-ПК>:9090` — компактная карточка, поле, кнопка, внизу адрес и «Переподключиться»;
  при появлении клавиатуры кнопка остаётся на экране, а после шестой цифры вход идёт сам.
- Версия: `package.json` → 1.5.52, OTA-бандл пересобран (диск и бандл сверены побайтово).

### Мелочи на будущее
- Подсказка «установить на главный экран» (beforeinstallprompt) прямо на странице входа.
- QR-код с адресом моста в настройках ПК — чтобы не набирать IP руками.
- Показывать на гейте имя ПК (hostname), а не только адрес.

## 1.5.53 — Yandex Cloud вглубь: контейнер как в консоли (`ycContainer`)

### Проблема
Интеграция была «витриной»: `ycList` показывал счётчики и имена, `ycCreate`/`ycDelete` создавали и удаляли,
`ycDeploy` собирал Docker и деплоил. Зайти ВНУТРЬ ресурса было нельзя — ни обзора, ни настроек, ни ревизий,
хотя именно так работает консоль YC: «Обзор» → «Редактор» → «Создать ревизию» → «Ревизии» → «Логи».
Отдельно: `containerInfo` отдавал только `id/name/url/status`, а `ycDeploy` всегда пересобирал образ,
не давая ни выбрать существующий контейнер, ни изменить настройки ревизии.

### Что сделано
- **`src/yandex-cloud.js` — глубокий слой Serverless Containers:** `getContainer` (полный объект:
  описание, метки, folderId, createdAt, статус, URL), `updateContainer` (PATCH с `updateMask` —
  перечисляются ТОЛЬКО изменяемые поля, иначе сервис сбрасывает остальные), `listRevisions`,
  `getRevision`, `rollbackContainer`, `revisionSummary` (байты → МБ, `30s` → 30, режим http/task),
  `revisionToDeployOpts` (префилл новой ревизии из активной).
- **`deployContainerRevision` расширен до полного набора:** `command`/`args`/`workingDir` (переопределение
  ENTRYPOINT/CMD), `connectivity.networkId`, `provisionPolicy.minInstances`, `secrets` Lockbox,
  `logOptions` (folderId/logGroupId/minLevel/disabled), `scalingPolicy`, `mounts` и `storageMounts`,
  `runtime: task`, `asyncInvocationConfig`. Границы сервиса зажаты в коде: память 128 МБ–8 ГБ кратно 128 МБ,
  таймаут 1–600 с, доля ядра у многоядерной ревизии принудительно 100%.
- **Новый инструмент `ycContainer`** с `action`: `overview` | `revisions` | `revision` | `deploy` |
  `rollback` | `update`. Один schema (~715 токенов) вместо шести — база промпта не растёт, группа `cloud`
  теперь 8 схем / ~2.1k токенов и подключается только по облачной задаче. Контейнер ищется по имени или id.
  `deploy` берёт настройки активной ревизии и переопределяет тем, что передано (env ДОБАВЛЯЕТСЯ,
  `envReplace: true` — замена набора).
- **Третье разрешение `allowUpdate`** («Разрешить агенту менять контейнеры»): чекбокс в
  Настройках → Yandex Cloud, выключен по умолчанию. Чтение (`overview`/`revisions`/`revision`) доступно
  всегда; `deploy`/`rollback`/`update` без него возвращают объяснение, а не молчаливую попытку.
  `ycStatus` теперь сообщает и про это право.
- **Бонус по производительности:** `waitOperation` больше не спит 2 секунды ПЕРЕД первой проверкой —
  операция часто уже завершена, и пауза была гарантированной на каждом создании/удалении/деплое.
- Справочник `src/agent-guides/yc.md` переписан под контейнерный сценарий (вкладки, префилл, ограничения),
  правило 28 промпта и список инструментов дополнены `ycContainer`.

### Сверка с API (не по памяти)
Методы и поля проверены по REST-справочнику Yandex Cloud: `Container.Get`, `Container.Update`
(тело `{updateMask, name, description, labels}`), `Container.Rollback`
(`POST /containers/v1/containers/{id}:rollback`, тело `{revisionId}`), `Container.DeployRevision`
(`POST /containers/v1/revisions:deploy`), `Container.ListRevisions` (`GET /containers/v1/revisions` —
именно так, а не `/containers/{id}/revisions`, как казалось по аналогии), `Container.GetRevision`
(`GET /containers/v1/revisions/{containerRevisionId}`).
Важно: **метода удаления ревизии в API нет** — в списке методов сервиса только `Rollback`, поэтому
«удалить ревизию» агенту не обещаем.

### Проверки
- smoke-тесты **274/274** (+6): сводка ревизии (байты/длительность/режим/секреты/монтирования), префилл
  (добавление и замена переменных, переопределения), тело запроса `revisions:deploy` (ресурсы, команда,
  аргументы, сеть, секреты с отбраковкой неполных, монтирования, режим task, уровень логов, границы
  таймаута и памяти), адреса (GET/PATCH/:rollback, маска только изменяемых полей), пустая ревизия без NaN,
  согласованность инструмента с разрешением и интерфейсом.
- **Вживую против Yandex Cloud не проверял**: в этой среде нет OAuth-токена и каталога, поэтому проверка
  структурная (адреса и тела запросов + разбор ответов). Реальную проверку делает пользователь в приложении:
  дашборд Yandex Cloud → контейнер.
- Версия: `package.json` → 1.5.53, OTA-бандл пересобран (диск и бандл сверены побайтово).

### Дальше по плану
Этап 2 — панель контейнера в интерфейсе (вкладки «Обзор», «Ревизии», «Логи», «Настройки» + кнопка
«Создать ревизию» с превью изменений); этап 3 — реестр образов и тегов; этап 5 — вызов контейнера
(`:invoke`) и метрики.

## 1.5.54 — телефон и ПК это ОДНО приложение: полная поверхность API, общая история, рабочий сайдбар

### Проблема
Мобильная версия вела себя как отдельное приложение:
- на телефоне Yandex Cloud был «не подключён», хотя на ПК каталог уже выбран, и вход
  предлагалось делать заново; часть полей настроек не подтягивалась;
- гамбургер открывал пустоту: в Настройки и к списку чатов с телефона было не попасть;
- ответ, полученный с телефона, появлялся на ПК только после перезапуска окна.

### Причины (найдены в коде)
1. **Мобильная копия API отставала от preload на 41 метод.** `src/renderer/mobile-api.js`
   зеркалит preload вручную, и в ней не было всего блока Yandex Cloud (`ycStatus`,
   `ycSetToken`, `ycFolders`, `ycSetFolder`, `ycSetPermissions`, `ycLogout`, `ycResources`,
   `ycCreate`, `ycDelete`, `ycDeploy`, `ycLogs`, `ycCliStatus`, `ycInstallCli`), почты,
   памяти диалогов, OTA, браузерного профиля, G4F и git-операций. Любой вызов
   `api.ycStatus()` на телефоне был `undefined` → «не подключено», войти нельзя.
2. **CSS прятал сайдбар на телефоне.** В `@media (max-width: 720px)` стояло
   `#sidebar { display: none }` (и то же для панели проекта), а выезжающая панель
   с `#sidebar.open` живёт в блоке `max-width: 900px`. `display:none` побеждал:
   кнопка-гамбургер переключала класс, но показывать было нечего — вместе с меню
   пропадали чаты и «Настройки».
3. **История чатов не сообщала о себе.** Файл истории общий, но `chats:save` от
   телефона просто писал его: окно на ПК продолжало показывать свою копию в памяти
   до перезапуска.
4. **Service worker залипал на старом коде.** Имя кэша было неизменным
   (`ai-agent-mobile-v1`), а статика отдаётся по stale-while-revalidate: телефон мог
   неделями работать на СТАРОМ app.js — исправления до него не доезжали.

### Что сделано
- **Полная поверхность API на телефоне:** в `mobile-api.js` добавлены все 44 метода
  (YC, почта, память, OTA, браузерный профиль и CDP, G4F, `gitPull`/`gitUnstage`/`gitRm`),
  плюс `onChatsReload`. Телефон теперь читает ТО ЖЕ состояние, что и ПК (токен, каталог,
  переменные агента, чаты) — «отдельного приложения» больше нет.
- **Тест-предохранитель:** smoke-тест сравнивает `api.*` из app.js с ключами mobile-api.js
  и проверяет, что каждый `invoke("канал")` существует в `main.js` — отставание копии
  теперь ловится сразу.
- **Синхронизация истории:** `chats:save` извещает остальных клиентов событием
  `chats:reload` (своё окно не извещается — `sender.id` совпадает), а интерфейс
  перечитывает файл и перерисовывает список чатов. Перезагрузка пропускается, если
  идёт свой прогон агента или есть несохранённые правки (`session || chatsSavePending`).
- **Чужой прогон не подмешивается в свой чат:** события `ai:event` помечаются источником
  (`from: "mobile" | "desktop"`). Раньше ответ, запущенный с телефона, дописывался в
  открытую на ПК переписку. Теперь ПК показывает подсказку и получает готовый результат
  через `chats:reload`.
- **Сайдбар на телефоне:** убрано `display:none` из блока `max-width: 720px`, у выезжающей
  панели явно выставлен `display:flex` — гамбургер снова открывает чаты, поиск и
  «Настройки» (кнопка настроек остаётся внизу панели: список чатов прокручивается).
- **Кэш service worker версионирован:** имя кэша = `ai-agent-mobile-<версия приложения>`,
  старые кэши удаляются — после обновления телефон получает свежий интерфейс.
- **Починены кнопки панели изменений:** `api.runCommand` (несуществующий метод) заменён на
  реальные IPC `git:unstage` (снять из индекса) и `git:rm` (удалить файл: `git rm -f`,
  а для неотслеживаемого — с диска); добавлен `git:pull` (`--ff-only`, чтобы не ловить
  молчаливый merge-конфликт), которого не было ни в preload, ни в main.

### Проверки
- smoke-тесты **279/279** (+5): живой WebSocket — авторизация, вызов `settings:get` и
  `yc:status` возвращают состояние ПК (включая токен и переменные агента), события
  доходят рассылкой; живой `/sw.js` — в кэше есть версия приложения; поверхность API
  покрывает все вызовы интерфейса и все каналы существуют в main.js; `chats:reload`
  и защита от подмешивания чужого прогона на месте; CSS сайдбара на телефоне больше
  не прячет панель.
- **Вживую на телефоне не проверял**: в этой среде нет браузера (Chromium для Playwright
  не установлен, окно Electron не поднять). Проверка транспорта — настоящим WebSocket
  против настоящего моста, интерфейса — по исходникам и структурными проверками.
- Версия: `package.json` → 1.5.54, OTA-бандл пересобран (диск и бандл сверены побайтово).

### Замечание по безопасности
Мобильный мост отдаёт на телефон те же настройки, что видит ПК, включая секреты
(OAuth-токен Yandex, API-ключи, переменные агента) — единственная защита это PIN и
локальная сеть. Если это лишнее, стоит отдавать на телефон урезанный набор настроек.


## 1.5.55 — длинный чат больше не «глупеет», кнопка «Продолжить контекст» переносит задачу

### Проблема
Когда чат переполнялся сообщениями, агент переставал нормально работать: он не видел
предыдущих шагов и отвечал так, будто задача только что началась. Кнопка «Продолжить
контекст предыдущего чата» тоже переносила пустоту.

### Причины (найдены в коде)
1. **История резалась в интерфейсе по полному бюджету.** `sendMessage` в `app.js`
   перед отправкой вызывал `AgentCore.trimConversation(history, contextBudget(...))`,
   а `trimConversation` считала накопление С НАЧАЛА: на чате длиннее бюджета срез
   прижимался к последнему user-сообщению — в main уходило ОДНО сообщение. Сжатие в
   памятку (`compactRemote`) не срабатывало: ему нужна голова диалога (≥ 4000 токенов),
   а её уже не было. Агент работал вслепую.
2. **Служебные заметки чата не попадали в контекст.** Сборка истории пропускала всё,
   кроме `user` и непустых `assistant`, — поэтому перенос задачи из другого чата
   (роль `system`) и заметки о восстановлении после сбоя модель вообще не видела.
3. **Кнопка «Продолжить контекст» переносила только последний ответ** (до 3000 символов)
   и заголовок чата: ни запроса пользователя, ни хвоста диалога.

### Что сделано
- **`trimConversation` считает с конца**: бюджет расходуется на свежие сообщения, старое
  уходит в памятку. Текущий виток (последнее user-сообщение и всё после него) остаётся
  целым, последнее сообщение сохраняется всегда, осиротевшие tool-сообщения по-прежнему
  вычищаются (иначе 400 wrong_api_format).
- **История отправляется в main целиком** (без предварительной обрезки в интерфейсе):
  теперь сжатие видит всю голову диалога и делает настоящую памятку. Обрезка по бюджету
  модели и компакция остаются в `main.js` (`ctxManager.manage` + `histBudget`), где
  уже вычтены system-промпт, схемы инструментов и справочники.
- **В контекст вернулись служебные заметки чата** (`role: "system"`): перенос задачи,
  восстановление прерванного ответа, авто-переключение подключения. Ведущие system
  по-прежнему склеиваются в один (`mergeLeadingSystem`), т.е. форма запроса не меняется.
- **Кнопка «Продолжить контекст»** собирает `buildContinuationContext`: последний запрос
  пользователя, последний ответ агента и хвост диалога, ограничено ~6000 символов.

### Проверки
- Тесты: +3 (длинный чат сохраняет свежий хвост и первое сообщение — user; история уходит
  целиком и со system-заметками; кнопка переносит запрос/ответ/хвост).


## 1.5.58 — настройки компактнее: категории слева, поиск сверху, «Сохранить» на виду

### Проблема
Настройки были плоским столбиком: 9 «таблеток» в 2–3 строки, панель 600px,
подписи над полями, всё в один прокручиваемый поток. Секции разделялись
линиями, а футер с «Сохранить» лежал ВНУТРИ прокрутки — чтобы сохранить
изменения, надо было домотать до низа. Найти одну настройку среди ~60 полей
можно было только перебором вкладок.

### Что сделано (в духе Replit)
- **Раскладка в две колонки:** слева категории с иконкой, названием и коротким
  пояснением, справа — содержимое. Окно расширено до 1040px и 88vh.
- **Категории по группам:** «Агент» (Модель, Зрение, Проект и GitHub, Секреты),
  «Интеграции» (Yandex Cloud, Почта, Мобильный), «Данные» (Память, Self-update).
  Активная категория — подсветка и полоса слева.
- **Поиск по всем настройкам:** строка в шапке ищет по подписям, подсказкам и
  placeholder'ам сразу во всех вкладках, показывает совпавшие поля единым списком
  (несовпавшие секции скрываются), раскрывает свёрнутые карточки, где есть
  совпадение, и честно говорит «ничего не найдено». Поля прячутся ТОЛЬКО своим
  классом `sfilter-hide` — служебный `.hidden` (например у `#mobile-fields`)
  не трогается. Esc в поле очищает поиск, а не закрывает окно.
- **Футер вне прокрутки:** «Проверить подключение» и «Сохранить настройки» теперь
  в фиксированной нижней полосе, а сообщение о результате — рядом с ними.
- **Секции — карточки** (фон `--bg-card`, скругление, тонкая рамка) вместо
  разделительных линий; поля, подписи, чекбоксы и аккордеоны стали плотнее.
- **Вкладка запоминается** на сессию: кнопка «Настройки» открывает ту, где ты
  остановился. Где нужна конкретная вкладка («Настройки: модель», «выбрать
  модель», «Дашборд», версия в статус-баре) — она передаётся явно. Заодно убран
  старый баг: `onclick = openSettings` передавал в функцию объект события как
  имя вкладки, из-за чего вкладка могла «слетать» в модель.
- **Заодно починена незакрытая разметка:** `.settings-panel` и `#settings-overlay`
  не закрывались (браузер догадывался сам, и всё после настроек оказывалось внутри
  оверлея).
- **Телефон:** категории складываются в горизонтальную прокручиваемую полосу,
  поиск уходит на всю ширину, подписи категорий прячутся.

### Проверки
- Тесты: +4 (раскладка и 9 категорий с подписями, футер вне прокрутки, поиск и
  его предохранители, запоминание вкладки).
- OTA-бандл пересобран.
## 1.5.59 — панель плана видит план локальной модели (размышления Ollama) и терпимее к markdown

### Проблема
Пользователь: «всё равно модель создаёт план, а планировщик не появляется отдельным, как в Replit».
Модель план печатала, но панель-чеклист над полем ввода оставалась пустой.

### Причины (найдены в коде)
1. **Рассуждения Ollama не читались вообще.** В `consumeProviderStream` для провайдера `ollama`
   читалось только `message.content`. Thinking-модели (qwen3, deepseek-r1, gpt-oss) кладут
   размышления отдельным полем `message.thinking` — они пропадали целиком. А локальные модели
   формулируют план именно там (`tryPlanFromRunText` разбирает и `thinking`, и ответ), поэтому
   у пользователя с локальной моделью в панель не попадало ничего.
2. **Часть провайдеров шлёт `delta.reasoning`** (не `reasoning_content`) — OpenRouter, vLLM и
   некоторые прокси. Это поле тоже игнорировалось.
3. **Разбор плана был слишком строгим к markdown.** Пункты, разделённые пустой строкой
   («loose list»), обрывали план на первом же пункте. Заголовок, заканчивающийся на `**`
   («**Сейчас нужно:**» — после двоеточия закрывающая разметка), не распознавался. Пункты
   «Шаг 1:», «Этап 1.», «А)» и заголовок с ведущим маркером списка («- **План:**») планом
   не считались.
4. **Список вовсе без заголовка** («Задача разбивается на этапы. 1. … 2. … 3. …») не попадал
   в панель, хотя это ровно тот план, которого ждёт пользователь.

### Что сделано
- `src/renderer/agent-core.js`: у Ollama читается `message.thinking` → `onThinking`; у
  OpenAI-совместимых добавлено поле `reasoning` (если `reasoning_content` нет).
- `src/renderer/app.js` — разбор плана:
  - `collectPlanItems` тянет пункты через пустые строки (пустая строка внутри списка больше не
    считается концом плана), предел `PLAN_TEXT_MAX` сохранён;
  - в `PLAN_ITEM_RE` добавлены «Шаг N:», «Этап N.», «Step N», буквенная нумерация «А)» — в обоих
    регистрах (модели пишут «Шаг» с большой буквы, первый заход на этом и спотыкнулся);
  - `PLAN_HEAD_RE` пропускает ведущий маркер списка/блокквота (`- **План:**`);
  - `PLAN_TAIL_RE` допускает закрывающую жирную разметку после двоеточия;
  - новый `PLAN_WORD_RE` + порог в 3 пункта: список БЕЗ заголовка признаётся планом только при
    планирующем слове в тексте («план», «шаг», «этап», «дальше», «осталось», «todo»). Обычные
    отчёты со списком («Что сделано: 1. … 2. … 3. …» и «Вот результаты: …») планом не становятся
    — это закреплено тестом.
- `tryPlanFromRunText`: при ПЕРВОМ появлении плана показывается тост
  «📋 Модель составила план — чеклист над полем ввода» (дальнейшие уточнения плана тост не
  повторяют: панель легко не заметить, но спамить им нельзя).

### Проверки
- Тесты: **291/291** (+2). Среди новых: живая NDJSON-строка Ollama с `message.thinking` доходит
  до `onThinking` вместе с текстом и счётчиками; `delta.reasoning` у OpenAI-совместимых тоже
  пробрасывается; разбор плана на реальных форматах markdown (пустые строки, жирный заголовок в
  конце фразы, «Шаг N:», «Этап N.», «А)», список без заголовка) и два отрицательных примера
  (обычный отчёт и перечисление результатов планом не становятся); тост о появлении панели.
- Разбор плана прогнан отдельным скриптом на 12 образцах текста (включая пользовательский
  «План уже составлен. Сейчас нужно: …») — 11 распознаны планом верно, «обычный абзац с
  перечислением» планом не признан.
- **Вживую в окне приложения не проверял**: Electron в этой среде не поднять. Панель и тост
  проверены по исходникам и на тестах; живой вид стоит глянуть на локальной модели —
  при размышлениях план должен появиться в чеклисте сразу, ещё до первого действия.
- Версия: `package.json` → 1.5.59, OTA-бандл пересобран (диск и бандл сверены побайтово).
## 1.5.60 — левая рельса как в Replit: быстрые панели плюс сворачиваемый список чатов

### Проблема
Пользователь: «сделай боковую левую панель так же, как в Replit».

Слева был один столбец на 268px: логотип, «Новый чат», «Продолжить контекст», поиск,
список чатов, «Настройки». Всё в одной плоскости, скрыть список чатов нельзя, а панели
(консоль, превью, облако, файлы) жили только кнопками в шапке справа.

### Что сделано
- **Рельса (`#rail`) — узкая колонка 54px слева**, как в Replit: логотип сверху, разделитель,
  иконки с подсказками (чаты, консоль, превью, файлы проекта, Yandex Cloud), внизу — «Новый
  чат» и «Настройки». Рельса остаётся на месте, когда панель чатов свёрнута, — именно она
  возвращает её обратно.
- **Сворачивание панели чатов**: иконка «Чаты» на рельсе сворачивает/разворачивает панель,
  кнопка «‹» в шапке панели делает то же. Состояние запоминается в `localStorage`
  (`sidebarCollapsed`) — привычка «работаю без списка» не сбрасывается при запуске.
  Свёрнутая панель уезжает (`width: 0` + `overflow: hidden`, плавно 0.18 с).
- **Иконки рельсы нажимают кнопки шапки** (`proxy(id, btnId)` → `b.click()`), поэтому поведение
  ровно то же, включая проверки «консоль только в ПК-приложении» и тосты. Дублировать логику
  панелей не пришлось.
- **Подсветка синхронна**: `syncRail()` переносит активное состояние с кнопок шапки на иконки
  рельсы (и наоборот — панель, открытая из шапки, подсвечивает свою иконку). Вызывается при
  открытии/закрытии нижней панели, переключении панели проекта и сворачивании списка чатов.
- **Точка состояния Yandex Cloud продублирована** на иконку облака в рельсе (`#rail-cloud-dot`):
  `ycSetHeaderDot` теперь обновляет обе.
- **Логотип переехал в рельсу** — шапка панели чатов стала текстовой («AI Developer Agent» /
  «Рабочее пространство») с кнопкой сворачивания справа, как заголовок панели в Replit.
- **Телефон не тронут:** рельса скрывается (`#rail { display: none }` в блоке 900px), панель
  остаётся выезжающей по гамбургеру, а `#sidebar.collapsed` в мобильном блоке принудительно
  возвращает ей ширину 276px и `overflow: visible` — свёрнутость из широкого окна не должна
  ломать выезд с телефона.

### Проверки
- Тесты: **294/294** (+3). Живая логика рельсы прогнана на игрушечном DOM: старт с развёрнутой
  панелью и подсвеченными «Чатами», сворачивание иконкой (панель уезжает, состояние
  запоминается, подсветка снимается), разворот кнопкой в шапке, иконка панели нажимает кнопку
  шапки и подсвечивается вместе с ней, повторный клик снимает подсветку, `syncRail` подхватывает
  панель, открытую из шапки, «новый чат» реально создаёт чат, свёрнутость восстанавливается при
  запуске, а на ширине 500px «Чаты» открывают выезжающую панель вместо сворачивания.
  Плюс статические проверки: все иконки в разметке, у каждой есть цель нажатия, рельса стоит
  между началом `#app` и списком чатов, мобильные правила на месте.
- Разметка: `<div>` 301/301 — баланс; дублей `id` нет; скобки в `styles.css` и `monochrome.css`
  сбалансированы.
- **Вживую в окне приложения не проверял**: Electron в этой среде не поднять. Логика проверена
  на настоящем коде из `app.js` (не по строкам), вид — структурно.
- Версия: `package.json` → 1.5.60, OTA-бандл пересобран (диск и бандл сверены побайтово).
## 1.5.61 — преграды из отчёта песочницы: лимит 429, ленивые списки, формат вызовов

### Откуда задача
Прогон «найти человека и проанализировать переписку» агент закончил сам, с честным разбором
семи преград. Худшая из них — по его же оценке — не инструменты браузера, а лимит провайдера:
**429 съедал ~60% времени** («2 шага → пауза → 2 шага»). Дальше по стоимости: ленивая подгрузка
списка диалогов (~2 хода), глобальный поиск людей ВК, отдавший «рекомендации» (~4 хода),
ленивая история переписки (~3 хода), окно поверх страницы (1 ход), неверный формат первого
`browserAct` (1 ход) и неверный порядок действий (глубокий поиск людей вместо поиска внутри
мессенджера, ~4 хода).

### Что сделано
**1. Лимит 429 больше не роняет раунд (главное).**
- `agent-core.js`: `rateLimitInfo(status, headers, detail)` читает паузу откуда угодно —
  заголовок `Retry-After`, `x-ratelimit-reset-*`, текст («Please retry in 12.3s»,
  «try again in 2 minutes», `retryDelay: "7s"`) — и достаёт частоту («8 requests per minute»).
- `agent-core.js`: `createRateLimiter()` — держатель темпа: узнали частоту → расставляет
  запросы по времени ЗАРАНЕЕ (не бьём в лимит вслепую); получили 429 → запоминает паузу.
- `main.js`: один держатель на провайдера+модель; перед запросом выдерживается пауза
  (в «Консоль» уходит «⏳ Держу темп провайдера: пауза N с»), а 429 теперь ждёт указанное
  время и **повторяет тот же раунд** (до 3 раз, «⏳ Лимит провайдера (429): жду N с (1/3)»).
  Порядок проверок сохранён: сначала совет по токенному лимиту Groq (там повтор
  бессмысленен — лимит по токенам, а не по запросам).

**2. Ленивая подгрузка списков и историй.**
- `browser-tools.js`: `loadAllScroll` + режим `browserScroll { loadAll: true }`. Крутит, пока
  появляется новое содержимое, и останавливается сам (два «пустых» шага подряд = конец списка),
  потолок 40 шагов, работает и по странице, и по внутреннему контейнеру (`container`),
  `how: "up"` — для истории переписки. `read: true` добавляет текст страницы (для чтения).
- **Ошибка, найденная на своих же тестах:** «рост» сначала считался по позиции прокрутки —
  тогда список считался растущим до самого низа и цикл не остановился бы сам. Теперь рост
  определяется ТОЛЬКО содержимым (высота документа/контейнера + длина текста); это закреплено
  отдельным тестом.
- В ответе честно сказано, чем кончилось: «дальше пусто — это конец списка» / «упёрся в предел
  N шагов — вызови ещё раз».
- Схема `browserScroll` дополнена `loadAll` и `read` (без этого модель не может их передать).

**3. Терпимость к формату вызова.**
- `browserAct`: один объект-шаг превращается в массив (частая ошибка), принимаются имена
  `steps`/`actions`/`script`/`step`/`commands`/`pipeline`, мусор в массиве отбрасывается,
  а текст ошибки говорит, что именно пришло («получено: steps…»).
- Строка вместо объекта-шага больше не «клик наугад»: `Enter`/`Escape`/`PageUp` — клавиша,
  `goto <url>`/URL — переход, остальное — клик по видимому тексту.

**4. Справочники (порядок действий — самая дорогая ошибка, ~4 хода).**
- `agent-guides/browser.md`: догрузка ленивых списков вынесена в раздел про прокрутку + правило
  «в списке нет нужного» почти всегда значит «не догружен»; в быстром пути `scroll` заменён на
  `loadAll`.
- `agent-guides/vk.md`: новый раздел «Где искать человека» — сначала поиск ВНУТРИ мессенджера
  («Поиск по чатам и сообщениям»), глобальный поиск людей только потом, и то, что выдача
  «рекомендаций» без нужной фамилии = пустой поиск, а не список кандидатов. Плюс пункты про
  ленивый список диалогов (~15 видимых чатов) и ленивую историю переписки, и переписан шаг
  чтения длинной истории на `loadAll` вместо ручных `PageUp`.

### Чего НЕ делал
- **Окно поверх страницы** (преграда №3, 1 ход): это не DOM-слой внутри страницы, и карта уже
  показывает диалоги честно («⚠️ Поверх страницы открыт диалог …»). Отдельного механизма для
  всплывающих окон ОС не добавлял — случай редкий и уже стоил всего один ход.
- **Темп в браузерном (не Electron) пути отправки** — держатель поставлен там, где работает
  приложение на ПК (`main.js`). Если понадобится и для мобильного/браузерного режима — скажи.

### Проверки
- Тесты: **299/299** (+5): разбор паузы из заголовка/текста/частоты и отсутствие выдуманной
  паузы; держатель темпа реально ждёт и помнит паузу после 429; в `main.js` темп держится
  заранее, 429 повторяется, счётчик сбрасывается на успехе, а совет по токенному лимиту стоит
  РАНЬШЕ повтора; цикл догрузки останавливается сам на трёх сценариях (кончилось / пусто /
  предел шагов) и позиция прокрутки не считается ростом; `browserAct` принимает объект-шаг и
  строки (`Enter` → клавиша, `goto …` → переход, текст → клик, пустая строка → не шаг).
- **Вживую против ВК и против лимитирующего провайдера не проверял**: в этой среде нет ни
  аккаунта, ни браузера, ни ключа. Проверка — на живом коде (держатель темпа и цикл догрузки
  прогнаны настоящими вызовами на игрушечной странице) и по исходникам.
- Версия: `package.json` → 1.5.61, OTA-бандл пересобран (диск и бандл сверены побайтово).

## 1.5.62 — выросший чат: агент больше не «пишет что-то и отключается»

### Откуда задача
Пользователь: «когда чат вырос, он уже не может делать никакие действия — напишет что-то и
отключается». Проверил: главную причину (история схлопывалась в интерфейсе до одного
сообщения) закрыл ещё 1.5.56, но **именно этот симптом остался** — и вот почему.

### Что нашлось
**1. Текст без вызова инструментов = конец прогона, даже если работа не закончена.**
В цикле (`main.js`) раунд без `tool_calls` завершает задачу. Предохранитель был ровно один и
срабатывал **только на пустом** тексте (`reportRetried`). Но на выросшем/сжатом контексте слабая
модель (особенно локальная) чаще отвечает **непустым** текстом вида «осталось сделать X, сейчас
проверю» — и прогон на этом заканчивался. Со стороны это и есть «напишет что-то и отключается».

**2. Одиночного сжатия контекста не хватало.** `createContextManager` делал компакцию строго
один раз за прогон (`if (!compacted)`). На длинной задаче (браузер, обход страниц) контекст
переполняется повторно, и дальше шла молчаливая обрезка головы `trimConversation` — вместе с
целью задачи. Агент терял, зачем всё это делает.

**3. Лимит раундов падал без объяснения.** `throw ... «Превышено максимальное число раундов»`
(25) не говорил, что делать дальше, хотя работа на диске цела и контекст можно продолжить.

### Что сделано
**1. Предохранитель «план не закрыт — это не финал»** (`main.js`).
- Сводка последнего `todoWrite` запоминается на прогон: `activePlanSummary = {total, done, failed}`
  (сбрасывается на старте, чтобы план прошлого прогона не влиял).
- Раунд без вызовов инструментов, где `done + failed < total`, — больше не финал: модели уходит
  сообщение «Ты ответил текстом, но план работ не закрыт: X из Y готово… не описывай, что
  осталось, а ВЫПОЛНЯЙ» и цикл продолжается. В «Консоль» — «📋 План не закрыт (2 из 5 пунктов) —
  прошу агента продолжить делом (попытка 1/2)».
- Ограничение: **не больше 2 повторов** за прогон (иначе цикл). Есть выход для невыполнимого
  пункта: разрешено отметить его `failed` через `todoWrite` и перейти к следующему.
- В режиме плана предохранитель выключен (`!planMode`): там агент должен ждать команды, а не
  «продолжать делом».
- Порядок сохранён: пустой текст по-прежнему идёт к просьбе об итоговом отчёте, а не к этому
  предохранителю — работа остаётся в приоритете над отчётом.

**2. Сжатие контекста стало повторяемым и накопительным** (`agent-core.js`).
- До **3 сжатий за прогон** (`compactCount`/`COMPACT_LIMIT`) вместо одного.
- Предыдущая памятка **скармливается в следующее сжатие** вместе с новыми сообщениями:
  раньше повторное сжатие потеряло бы всё, что уже было свёрнуто в неё. Сеть не тратится зря —
  `compactRemote` сам возвращает `null` без запроса, если голова мала (< 4000 токенов).
- Каждое сжатие видно в чате плашкой «🧠 Контекст сжат…».

**3. Лимит раундов объясняет, как продолжить:** «…(Действия на диске сохранены.) Напиши
«продолжай» — агент получит тот же контекст и продолжит с текущего места».

### Чего НЕ делал
- **Не поднимал `maxRounds`** (25): это плата за каждый раунд у платного провайдера, и причина
  обрыва была не в лимите. Теперь лимит хотя бы честно объясняется и продолжается кнопкой.
- **Не убирал рассказ модели между действиями** — по разбору из прошлого ответа это даёт копейки,
  а раунды не сокращает. Настоящие рычаги — батчинг read-only (уже есть), кэш промпта, роутер.

### Проверки
- Тесты: **304/304** (+5). Из них живой прогон `createContextManager` с подменённой сетью:
  сжатие вызывается больше одного раза и **второй запрос содержит памятку от первого**
  (накопление), но не больше трёх — то есть лимит работает. Остальные — структурные:
  предохранитель привязан к «нет вызовов инструментов», проверяет незакрытые пункты, ограничен
  двумя повторами, уходит модели через `canonical.push`, выключен в режиме плана; `todoWrite`
  пишет сводку плана; текст лимита раундов говорит, что работа сохранена и как продолжить.
- **Вживую в окне приложения не проверял** — Electron здесь не поднять. Проверка структурная и на
  живом коде (менеджер контекста прогнан настоящими вызовами).
- Версия: `package.json` → 1.5.62, OTA-бандл пересобран (диск и бандл сверены побайтово).

## 1.5.63 — агент снова работает с окном приложения: «продолжай» больше не выбивает схемы

### Что было не так (регрессия роутера, 1.5.42+)
Пользователь: «до каких-то предыдущих правок он лазил по приложению и всё делал, а сейчас не может,
хотя модель та же». Причина найдена в роутере инструментов (ускорение №3), а не в модели:

1. `routerTask` в main.js собирался **только из 3 последних сообщений пользователя**. На «продолжай»
   (одно слово без ключевых слов) ни одна группа не совпадала — в том числе группа `app`, в которой
   живут `appRead/appClick/appFill/appSelect/appPress/appWait/appScreenshot`.
2. Схема `appRead` исчезала из запроса, но модель звала её **по памяти из истории**.
3. Срабатывал предохранитель A (main.js): «🔧 «appRead» вне набора схем — добавляю группу «app»» —
   группа включалась **посреди прогона**.
4. Набор схем менялся между раундами → **префикс запроса другой** → у бесплатного пула провайдера
   запрос «холодный» → `503 cache_only_cold` («cache-only admission rejected a cold… request»).
   То же самое делало сжатие контекста. До 1.5.42 все 146 схем уходили всегда — поэтому проблемы не было.

Итог: круг «обрыв → продолжай → снова обрыв», и агент не мог работать в UI приложения.

### Что сделано
- **`routerTaskText(messages, opts)`** (agent-core, новая чистая функция, экспортирована): текст для
  роутера собирается из **истории** — до 12 реплик (user + assistant), по 1200 символов на реплику,
  потолок 6000 символов; новейшее в начале, при обрезке теряется старое, а не текущая задача. main.js
  теперь использует её вместо разбора трёх фраз. Цена — ноль (считается локально).
  Смысл: на «продолжай» роутер видит саму работу («окно приложения», «appRead») и **с первого раунда
  нового прогона** собирает тот же набор групп, что был в прошлом → префикс стабилен, кэш попадает.
- Ключевые слова группы `app` расширены: «окна/окном приложени», «свою/наше/моё прилож»,
  «панель/панели приложени».
- **`coldCacheInfo(status, detail, attempt)`** (agent-core, новая чистая функция, экспортирована) +
  ветка в main.js: 503/502/529 и отказы со словами `cache_only`/`overloaded`/`unavailable`/`capacity`
  **повторяют ТОТ ЖЕ раунд** с растущей паузой (4 → 10 → 20 с, максимум 3 раза), а не падают сырым JSON.
  История при повторе не переписывается — повтор может попасть в кэш. 429/402/400 и обычный 500
  («internal error») в эту ветку не попадают: у них свои правила. После исчерпания повторов —
  человеческое объяснение («подожди 10–30 с и напиши «продолжай», либо другая модель/тариф; смена
  ключа внутри того же бесплатного пула не поможет»). Счётчик сбрасывается на успешном ответе.

### Проверки
- Тесты: **306/306** (+2). Среди новых — живые: `routerTaskText` на истории «работа с окном
  приложения → продолжай» даёт группу `app` и схему `appRead` (а одна фраза «продолжай» — нет, как и
  было), тихая история групп не тянет, пустая/битая история не ломает, длинная обрезается
  детерминированно; `coldCacheInfo` разбирает точный JSON из отчёта пользователя, пауза растёт и
  упирается в потолок, 429/402/400/500 не перехватываются. Плюс структурные: main.js правда берёт
  текст роутера из истории, сбрасывает оба счётчика на успехе, имеет ветку повтора и понятный текст.
- Живой прогон: «продолжай» после UI-задачи → группы `browser, app`, схем 67 (~13k токенов),
  `appRead` на месте; на одной фразе — 37 схем (~6k) и `appRead` нет (так и было до правки).
- Версия: `package.json` → 1.5.63, OTA-бандл пересобран (диск и бандл сверены побайтово).

### Про то, что НЕ трогали
Задача **не** в размере контекста (одна карта окна ≈2–2.5k токенов, при входе режется до 8k символов).
Причина — смена префикса запроса: набор схем на ходу + сжатие. Поэтому по-прежнему важно не «меньше
читать окно», а держать стабильный префикс. Если бесплатный пул режет вообще всё, что не из кэша,
спасёт только повтор/другая модель.
## 1.5.64 — панель плана не появлялась: ReferenceError на «голом» имени функции ядра

### Как нашли
Живой прогон в настоящем Chromium (`scripts/live-ui.js`): поток провайдера подменён, модель «пишет»
план текстом. Текст в чат приходил, а панель плана — нет. Инструментированный `app.js` (в отдаваемый
файл добавляется экспорт внутренних функций) показал: `planFromText` доходит до нормализации пунктов и
падает на `normalizePlanTasks is not defined`.

### Причина
`normalizePlanTasks` живёт в ядре (`agent-core.js`, экспорт) и попадает в `app.js` только как
`const AgentCore = window.AgentCore`. А в трёх местах он вызывался **голым именем** (строки 421, 609, 701):

- `planFromText` — текст плана от модели (главный путь: локальные модели пишут план в размышлениях);
- `planFromModel` — план через инструмент `todoWrite`;
- `sanitizeChats` — загрузка плана вместе с чатом (там есть try/catch, поэтому молча терялся только план).

`ReferenceError` бросался внутри обработчика куска потока (`onAiEvent` → `tryPlanFromRunText`), улетал в
`consumeProviderStream` и **гасился молча**: ни ошибки пользователю, ни панели. Отсюда и ощущение
«модель создаёт план, а планировщика нет».

### Почему не поймали раньше
Стенд в `test/smoke.test.js` сам передавал `normalizePlanTasks: AgentCore.normalizePlanTasks` в область
видимости исполняемого среза — то есть подменял ровно то, чего в реальном окне нет. Тест был зелёным,
приложение — нет.

### Что сделано
- Три вызова → `AgentCore.normalizePlanTasks(...)`.
- Стенд больше не подсовывает нормализатор (и `sanitizeChats` получает `AgentCore`, а не голое имя).
- **Новый страж** в тестах: для каждой функции, экспортированной ядром, сканируется `app.js` — голый вызов
  (без `AgentCore.`) валит тест. Это закрывает весь класс ошибок, а не один случай.
- **`scripts/live-ui.js` + `bun run test:live`** — живой тест интерфейса, который такие ошибки видит.

### Проверки
- Структурные тесты: **307/307** (+1 страж).
- Живой тест в Chromium: **32/32**. Панель плана появляется вживую в обоих путях — текстом (3 пункта,
  счётчик `0/3`, тост про чеклист) и через `todoWrite` (2 раунда к модели). Рельса, настройки с поиском,
  сворачивание списка чатов, мобильные 390×844 — зелёные; ошибок JS нет (единственный 404 —
  `/bootstrap.js`, его отдаёт только мост телефона, это ожидаемо).
- Версия: `package.json` → 1.5.64, OTA-бандл пересобран (диск и бандл сверены побайтово).

### Десктопное окно тоже проверено вживую (Xvfb)
Окно Electron в песочнице поднимается, если доустановить GTK: `apt-get install -y libgtk-3-0 libnotify4
libxss1 libxtst6 libsecret-1-0` (остальные библиотеки уже приходят с playwright chromium). Запуск:

```
xvfb-run -a -s "-screen 0 1440x900x24" node_modules/electron/dist/electron . \
  --no-sandbox --disable-gpu --remote-debugging-port=9333
```

дальше Playwright `chromium.connectOverCDP("http://127.0.0.1:9333")` — и видно настоящее окно с preload:
рельса, `window.api` (100 методов), ядро прямо в окне (роутер по истории → группа `app` + `appRead`,
`coldCacheInfo` на 503). Прогон: **11/11**, консоль чистая. Важно: для тестового запуска ставить
`AI_AGENT_OTA_ROOT` во временную папку — иначе приложение на старте подхватит локальный `ota/` и начнёт
самообновляться.

Чего живой прогон всё ещё не покрывает: реальные файловые/git-операции и настоящий провайдер (в тесте поток
подменяется локально, ключей и сети к провайдеру нет).

### Ещё одна находка живого теста: 404 на /bootstrap.js
`index.html` грузит `bootstrap.js`, а файла не было ни в Electron, ни в веб-превью (по этому пути его отдаёт
только мост телефона). Каждый запуск писал в консоль `Failed to load resource (ERR_FILE_NOT_FOUND)`.
Добавлена пустая заглушка `src/renderer/bootstrap.js`: маркер `window.__mobileBridge` по-прежнему ставит
только мост, поэтому `mobile-api.js` в Electron и веб-превью остаётся no-op, а консоль чистая.

### Итог по версиям
`package.json` → **1.5.64**, OTA-набор пересобран (40+1 файлов, диск и бандл сверены побайтово).
Живые проверки: веб-режим **32/32**, десктопное окно **11/11**, структурные тесты **307/307**.

## 1.5.65 — генерация картинок: один адрес вместо селектора, честная ошибка, сквозной живой тест

### Что было не так (жалоба: «ошибка пустая, не пойми что»)
`generateImageRemote` знала ТОЛЬКО протокол OpenRouter: `POST {base}/images` и обязательный
`data[0].b64_json` в ответе. Ключ и адрес при этом общие со зрением (`auxConfig`), отдельного
подключения для генерации не было. Поэтому: OpenRouter работал, а OpenAI (`/images/generations`) и
Gemini (`/v1beta/openai/images/generations`) — нет. В ошибке печаталось только тело ответа, без кода и
адреса: у Gemini 404 с пустым телом давал строку «Ошибка генерации изображения: . Проверь ключ…».

### Что сделано в ядре (agent-core.js)
- **Провайдер по адресу, без селектора:** `imageHostKind(url)` + `imageProviderLabel(url)`.
  OpenRouter → `/images`; OpenAI / Azure / Gemini → `/images/generations`; Яндекс AI Studio →
  `foundationModels/v1/imageGenerationAsync` + опрос `operations/<id>`; localhost:7860 →
  `/sdapi/v1/txt2img` (A1111). Незнакомый хост (свой прокси/шлюз) — порядок попыток универсальный.
- **Перебор протоколов с памяткой:** при ответе из `IMAGE_WRONG_PROTOCOL` (400/404/405/406/415/501)
  пробуем следующий путь; удачный вариант запоминается в `_imageKindByHost` (host → kind) и больше не
  перебирается. Повтор того же пути с другим `response_format` не делается, если путь уже дал 404.
- **Ответ принимается и как `b64_json`, и как `url`** (некоторые OpenAI-совместимые отдают ссылку);
  `mediaType` берётся из ответа либо определяется по сигнатуре файла. Ядро возвращает
  `{ b64, mediaType, ext, label }` — base64, а не Buffer: тот же код работает в браузере.
- **`size` только там, где он точно допустим:** у `dall-e-3` и `gpt-image-1` разные наборы значений,
  поэтому подставляем проверенное, а Gemini и прочим не шлём вовсе.
- **`normalizeAuxBase` достраивает версию пути** для известных хостов: OpenAI → `/v1`,
  OpenRouter → `/api/v1`, Gemini → `/v1beta/openai` (раньше URL без версии давал 404 на несуществующий
  `/images/generations`). Чужие пути не трогаем.
- **Честная ошибка:** код, адрес, модель, список испробованных путей и тело ответа — всё в тексте.

### Что сделано в интерфейсе
- `main.js`: файл пишется из `img.b64` (`Buffer.from(..., "base64")`), в отчёте агенту — медиатип и
  название провайдера; в ошибке подсказка с адресом и моделью.
- Настройки: подпись `#vision-detect-hint` («Генерация картинок: Gemini (OpenAI-совместимо) — путь к API
  приложение подбирает само»), перерисовывается на ввод адреса; в подсказках — примеры моделей по
  каждому провайдеру. Никаких новых полей и переключателей.

### Проверки
- Структурные тесты: **314/314** (+7 по изображениям: определение по адресам, тела запросов, `size`,
  перебор и памятка, разбор `url`, текст ошибки).
- Живой веб-прогон (`bun run test:live`): **42/42** — четыре сценария через подменённый прокси
  (Gemini, OpenRouter, незнакомый шлюз, полный отказ). Намеренные 404 сценариев гасятся функцией
  `isFakeProviderFailure` (хосты `*.live.test`), поэтому проверка «нет ошибок страницы» остаётся строгой.
- Живой сквозной тест десктопа (`bun run test:live:desktop`): **11/11** — настоящее окно Electron,
  инструмент `generateImage` через IPC, реальный PNG на диске, путь запроса `/v1/images/generations`
  и отсутствие лишних попыток.

### Итог по версиям
`package.json` → **1.5.65**, OTA-набор → **1.5.67** (41 файл, диск и бандл сверены побайтово, sha256 сошёлся).
`scripts/live-desktop.js` в OTA-набор не входит (он живёт только в репозитории — бандл зеркалит
`src/`, `assets/`, `package.json`, `server.js`).

## 1.5.66 — роли чата и роль «Менеджер»: дела, сроки, напоминания

Кнопка «Ассистент» из приветственного экрана превратилась в **роли**, которые держатся
весь диалог, а не одно сообщение. Первая роль — **Менеджер**: личный список дел со сроками.

### Что появилось
- **Роль у каждого чата** (кнопка «📋 Менеджер» у поля ввода → панель ролей): Разработчик,
  Ассистент, Менеджер, Исследователь. Роль хранится в чате и уходит в системный промпт
  блоком «РЕЖИМ …» на каждом раунде, поэтому модель не «забывает» её через две реплики.
- **Роль выбирает инструменты.** У роли свой набор групп роутера (у Менеджера — `tasks`,
  `notes`, `mail`, `system`), так что в запрос уходит меньше схем, а агент не тянется к
  `git`/`cloud`/`project`.
- **Чипы роли** — короткие вопросы в один клик («Что у меня на сегодня?», «Что просрочено?»,
  «Спланируй неделю»). Чипы с `send: true` отправляются сразу.
- **Дела и сроки** (`src/agent-store.js`): `taskAdd / taskList / taskUpdate / taskDone /
  taskDelete`, группа `tasks` в реестре инструментов. Срок разбирается по-человечески:
  ISO, «15.09», «завтра 14:00», «в пятницу», «через 2 недели», «через час». Хранятся в
  `userData/tasks.json` — вне проекта.
- **Панель «Дела»** (кнопка в рельсе со счётчиком «горит сегодня + просрочено»): группы по
  срокам, добавление, отметка выполнения, правка, удаление. Сводка дел подставляется
  Менеджеру в промпт сразу — чтобы он не гадал и зря не звал `taskList`.
- **Напоминания о сроке**: раз в минуту проверяем дела и напоминаем за 15 минут до срока —
  системным уведомлением и тостом в ленте. Один раз на срок; отключается галочкой в настройках.
  В интервал добавлен тестовый ускоритель `AI_AGENT_TASK_REMINDER_MS`.

### Найдено живыми тестами (не видели структурные)
- **Уведомление завершало процесс.** В контейнере без D-Bus `new Notification().show()`
  убивает приложение, а напоминание — фон: он обязан выживать. Появился `canNotify()`:
  на Linux уведомляем только при настоящем D-Bus-адресе, иначе молча пропускаем.
- **Живой тест десктопа обрывался на 5-й секунде.** Оказалось, это самообновление:
  `findCandidate` смотрит и папку `ota/` рядом с кодом, видит бандл новее установленного и
  делает `relaunch()` → `app.exit(0)` — окно закрывается без `before-quit`, будто «само».
  Теперь при переопределённом `AI_AGENT_OTA_ROOT` (живые тесты) репозиторная `ota/` не
  подмешивается. В самом приложении поведение не изменилось.
- **Окно держит собственную копию настроек.** После `settings:set` через IPC (не через форму
  настроек) копия в окне остаётся старой: роль/чипы видели «модель не выбрана». В живом тесте
  страница перезагружается после записи настроек; роли, дела и напоминания проверяются уже
  в настроенном окне.

### Проверки
- Структурные тесты: **318/318** (+4 по делам: разбор сроков, CRUD, панель и сводка,
  однократность напоминаний).
- Живой веб-прогон (`bun run test:live`): **43/43** (рельса теперь 8 иконок — добавилась «Дела»).
- Живой сквозной тест десктопа (`bun run test:live:desktop`): **31/31** — настоящее окно
  Electron: генерация картинки (PNG на диске), дело через приложение, панель и счётчик,
  панель ролей, роль в системном промпте (тело запроса), сводка дел и схемы `taskList`/`taskAdd`
  в промпте, напоминание о сроке ровно один раз и отметка `remindedAt` в `tasks.json`.

### Итог по версиям
`package.json` → **1.5.66**, OTA-набор → см. `ota/manifest.json` (диск и бандл сверены
побайтово, sha256 сошёлся).

## 1.5.67 — панель «Дела» переделана: сводка, фильтры, быстрые сроки

Панель менеджера была длинной колонкой полей (название + срок + приоритет + кнопка в одну
строку) и плоским списком. Переделана в рабочий экран: сверху видно состояние, в середине —
быстрый ввод, ниже — дела по срокам.

### Что изменилось
- **Шапка со сводкой.** Заголовок «Дела и сроки» + строка «Активных · просрочено · сегодня ·
  завтра» одним взглядом; кнопка обновления рядом.
- **Фильтры-плитки со счётчиками**: Все / Просрочено / Сегодня / Завтра / На неделе / Без срока.
  Клик сужает список до одной группы, активная плитка подсвечена, просроченное — красным.
  Если в выбранном фильтре дел не осталось, панель сама возвращается к «Все» (а не выглядит
  пустой без причины).
- **Компактный ввод**: название и кнопка «＋» в одной строке, срок и приоритет — во второй,
  ниже — **быстрые сроки** («через час», «сегодня вечером», «завтра 10:00», «в пятницу»,
  «через неделю»). Клик подставляет срок, а если название уже написано — сразу добавляет дело.
- **Строка дела** стала двухслойной: галочка → название → под ним строкой срок (🕒 / ⚠ при
  просрочке) и метки проекта и приоритета («важное»/«мелкое»). Действия (🗑) показываются при
  наведении, поэтому список не пестрит иконками.
- **Пустое состояние объясняет, что делать** — вместо одной серой строки иконка, заголовок и
  подсказка с примером просьбы агенту; отдельный текст, когда пусто из-за фильтра.
- **Выполненные** — раскрывающаяся секция под списком со счётчиком и стрелкой.

### Проверки
- Структурные тесты: **318/318**.
- Живой веб-прогон (`bun run test:live`): **43/43**.
- Живой сквозной тест десктопа (`bun run test:live:desktop`): **43/43** (+12 к панели) —
  настоящее окно Electron: пустое состояние, шесть фильтров, счётчики в плитках, фильтр
  «Просрочено» показывает только просроченное, возврат к «Все», метки проекта и приоритета,
  быстрый срок подставляет значение, **панель и её блоки не переполняются по ширине**.
  На время проверки фильтров напоминания выключаются — иначе просроченное дело дёрнуло бы тост
  и сломало бы проверку «напоминание приходит ровно один раз».

### Итог по версиям
`package.json` → **1.5.67**, OTA-набор → см. `ota/manifest.json` (диск и бандл сверены
побайтово, sha256 сошёлся).

## 1.5.68 — лимит провайдера (429): прогон ждёт сам, «продолжай» больше не нужен

Симптом: провайдер отвечает `429 You have reached the request limit[z-ai/glm-5.3-free]:
Maximum 8 requests within 1 minutes`, агент замолкает, и пользователь вынужден писать
«продолжай» руками. Причина была не в модели, а в двух мелочах.

### Почему оно останавливалось
1. **Окно лимита не разбиралось.** `rateLimitInfo` понимал «8 requests per minute», но не
   «within 1 minutes» и не «10 запросов в минуту»: частота оставалась нулевой, а пауза бралась
   наугад — 5 с. При лимите «8 запросов в минуту» пять секунд не помогают ничем.
2. **Предел в 3 попытки.** `rateRetries < 3` — три паузы по 5 с, дальше прогон падал с ошибкой,
   и раунд терялся. Отсюда и «надо что-то написать, чтобы он снова заработал».

### Что сделано
- **Окно лимита разбирается по-настоящему**: «8 requests per minute», «Maximum 8 requests within
  1 minutes», «30 requests in 1 minute», «10 запросов в минуту», «60 requests per hour».
  Если время повтора провайдер не назвал, ждём целое окно — после него счётчик обнулится.
- **Ждём сами, до потолка.** Вместо трёх попыток — общий бюджет ожидания
  (`RATE_WAIT_BUDGET_MS`, по умолчанию 10 минут, переопределяется `AI_AGENT_RATE_WAIT_MS`).
  Тот же раунд повторяется, история не переписывается. Бюджет не даёт прогону висеть вечно:
  когда он исчерпан, ошибка прямо говорит, сколько ждали.
- **Пользователь видит, что происходит**: заметка «⏳ Лимит провайдера на запросы: жду 60 с и
  повторю сам (попытка 2), лимит ≈8 запросов/мин. Писать ничего не нужно.» уходит **тостом**,
  а не только строкой в «Консоль» (новый тип события `notice`). После долгой паузы — «▶ Продолжаю».
- **Веб-режим тоже.** В `webSend` (превью и телефон) обработки 429 не было вовсе — прогон
  падал сразу. Теперь там та же логика ожидания.
- **Темп держится заранее**: узнав частоту, `rateLimiter` расставляет запросы по времени
  (при 8/мин — раз в 7,5 с), поэтому 429 после первого раза почти не повторяется.

### Проверки
- Структурные тесты: **318/318** (+5 разборов окна лимита, обновлён тест «429 не роняет раунд»,
  добавлены проверки веб-режима).
- Живой веб-прогон (`bun run test:live`): **43/43**.
- Живой сквозной тест десктопа (`bun run test:live:desktop`): **49/49** — добавлен шаг 9:
  подменённый провайдер отдаёт **два настоящих 429** с текстом z-ai/glm и `Retry-After: 1`,
  и проверяется, что прогон не упал, сам повторил запрос (3 обращения вместо 1) и показал
  пользователю заметку об ожидании.

### Итог по версиям
`package.json` → **1.5.68**, OTA-набор → см. `ota/manifest.json` (диск и бандл сверены
побайтово, sha256 сошёлся).

## 1.5.69 — консоль Yandex Cloud: карточка ресурса и связанные объекты

### Что было
В панели «Облако» было видно только СПИСОК ресурсов сервиса (сети, контейнеры, реестры,
сервисные аккаунты). Зайти внутрь ресурса, как в настоящей консоли Yandex Cloud, было
нельзя: у сети не посмотреть подсети, у контейнера — ревизии, у аккаунта — ключи.

### Что сделано
- Новый модуль **`src/yc-console.js`** (чистый Node, без Electron) и пара к нему:
  **`src/renderer/yc-console.js`** + **`src/renderer/yc-console.css`**. Интерфейс только
  рисует то, что уже подготовил главный процесс: подписи полей, значения и таблицы
  форматируются в одном месте.
- **Обзор ресурса** — все поля из ответа API человеческим языком: подписи по-русски,
  даты «01.08.2026 10:00 · 1 мес назад», размеры «128 МБ (134217728)», метки «env: prod»,
  образ — адресом. Плюс мягкое уточнение через GET по id (ошибка не ломает карточку).
- **Связанные объекты** — плитки со счётчиками: у сети подсети / группы безопасности /
  таблицы маршрутизации, у контейнера — ревизии, у реестра — образы, у сервисного
  аккаунта — статические и API-ключи, у секрета — версии, у DNS-зоны — записи. По клику
  раскрывается таблица с осмысленными колонками.
- **Честность вместо пустого списка.** Если связи нет в API, плитка помечается «!» и
  объясняет причину. Если форма пути неочевидна — варианты пробуются по очереди и
  сработавший запоминается (Cloud DNS — только вторая форма; у IAM 403 по «по сервисному
  аккаунту» откатывается на список по каталогу).
- Единственное действие — **откат контейнера на ревизию** («сделать активной»), и только
  при включённом в настройках «Разрешить агенту менять контейнеры».

### Проверки
- Структурные тесты: **323/323** (+5 по консоли: подписи и значения, «N дней назад»,
  скрытие служебных полей, таблицы связей, согласованность реестра с сервисами).
  Заодно тест сводки дел сделан детерминированным: `tasksBrief` получил необязательный
  момент расчёта, иначе он падал при переходе настоящих часов через срок «сегодня 23:00».
- Живой веб-прогон (`bun run test:live`): **43/43**.
- Живой сквозной тест десктопа (`bun run test:live:desktop`): **49/49**.
- **Новый живой тест консоли** (`bun run test:live:yc`): **27/27** — настоящее окно Electron
  против подменённого Yandex Cloud API: карточка открывается из списка сервиса, поля и
  связи считаются, чужая сеть не попадает в подсети, недоступная связь честно объяснена,
  DNS читается второй формой пути, ключи сервисного аккаунта — добором после 403, откат
  запрещён без разрешения и выполняется с ним (на нужный путь `POST ...:rollback`).

### Итог по версиям
`package.json` → **1.5.69**, OTA-набор → см. `ota/manifest.json` (диск и бандл сверены
побайтово, sha256 сошёлся).

## 1.5.70 — политика инструментов, журнал действий и сужение секретов

### Что было
Знание «что опасно» жило в трёх местах сразу: регулярка опасных команд в `main.js`,
набор `DANGEROUS_TOOLS` из трёх имён и россыпь чекбоксов в настройках. Из-за этого
не было ни профилей автономности, ни журнала: понять потом, что и с чьего разрешения
делал агент, было нельзя. Плюс реальная дыра: `agentEnv` подмешивался в окружение
ЛЮБОЙ команды агента — включая `env`/`printenv`, то есть модель могла одной строкой
вывести в чат все пароли и ключи пользователя.

### Что сделано
- **Новый модуль `src/tool-policy.js`** (чистый Node, без Electron) — одна точка правды:
  у каждого из 153 инструментов есть `capability` (что делает) и `risk`
  (low / medium / high), оттуда же берутся подтверждения. 49 capability: `files.write`,
  `terminal.execute`, `git.push`, `browser.account`, `vault.fill`, `cloud.deploy`,
  `self.update` и т.д. Незнакомый инструмент не блокируется, но помечается `unknown`
  и попадает в журнал — видно, что про него забыли.
- **Подтверждения по риску.** Прежние три (`killProcess`, `registryWrite`, `installExe`)
  сохранены, добавлены пять действительно необратимых и раньше не спрошенных:
  `installSystemPackage`, `runCommandAsAdmin`, `otaRollback`, `browserClearProfile`,
  `checkpointRollback`. Там, где защита уже есть своим чекбоксом (`gitPush`, `mailSend`,
  `ycCreate`/`ycDelete`/`ycDeploy`, `browserConnect`), второй диалог НЕ добавляется.
- **Новый модуль `src/audit-log.js`** — журнал действий: JSONL в `userData/audit.log`,
  сдвиг файла на 2 МБ, запись никогда не бросает (журнал не имеет права ломать прогон).
  Пишутся подтверждения и отказы, риск medium/high и незнакомые инструменты; чтение файлов
  и мелочи вроде дел — нет. Формат: время, инструмент, capability, риск, решение, исход,
  аргументы и результат-сводка.
- **Секретов в журнале нет — и это проверено живьём.** Первая версия писала текст
  результата, и живой тест поймал утечку: `printenv MY_KEY` честно печатает значение,
  а журнал его сохранял. Теперь журнал хранит только исход (`ok` / `error` / `denied`)
  и короткую заметку об ошибке, а значения переменных агента передаются в журнал
  списком (`audit.setSecrets`) и вырезаются по подстроке из любой строки. Ключи и токены
  вырезаются ещё и по виду (`sk-`, `ghp_`, `AIza`, `ya29.`, `eyJ…`), `TOKEN=…` — по имени.
- **Секреты больше не отдаются всем подряд.** Команда, которая только печатает окружение
  (`env`, `printenv`, `set`, `env | grep`, `export -p`, `Get-ChildItem Env:`,
  `cat /proc/self/environ`), получает только PATH. Явный запрос конкретной переменной
  (`printenv MY_KEY`) работает как раньше — это осознанное действие, и оно видно
  в переписке. Служебные пробы (поиск программы в PATH, проверка версии) секретов
  не получают вовсе.
- **Настройки:** чекбокс «Вести журнал действий агента» (включён по умолчанию, рядом
  с разрешением на `git push`).
- Регулярка опасных команд переехала в политику — знание об опасности больше не раздвоено.

### Проверки
- Структурные тесты: **329/329** (+6 по политике и журналу: покрытие всех инструментов
  ядра в обе стороны, решения о подтверждении и отсутствие двойных диалогов, опасные
  команды и дампы окружения, редакция секретов, поведение журнала, привязка `main.js`
  к политике).
- Живой сквозной тест десктопа (`bun run test:live:desktop`): **61/61** (+12) —
  в настоящем окне Electron: переключатель журнала на месте и включён, опасный
  инструмент (`killProcess`) спрашивает разрешения, отказ НЕ выполняет действие
  и попадает в журнал как `denied` с риском high и capability `system.process.kill`,
  команда-дамп окружения не показывает значение переменной агента, а явный запрос
  её показывает; журнал на диске: каждая строка разбирается как JSON, значения
  секрета в файле нет.
- Заодно тесты дел перестали зависеть от календаря: `tasksAdd` получил необязательный
  момент расчёта (как `parseDue`/`humanDue`/`tasksList`), иначе «завтра 14:00»
  переставало совпадать с ожиданием после перехода суток.

### Итог по версиям
`package.json` → **1.5.70**, OTA-набор → см. `ota/manifest.json` (диск и бандл сверены
побайтово, sha256 сошёлся).

## 1.5.71 — деплой: рецепты сборки, состояние проекта и самолечение

### Что было
Деплой жил двумя копиями одного кода: тело инструмента `ycDeploy` в агенте и IPC
`yc:deploy` для кнопки. Обе делали одно и то же по-своему, и обе заканчивались на
«ревизия создана — значит всё хорошо». Что было не так по существу:

- **Dockerfile сочинялся на ходу.** Тип проекта угадывался по трём признакам, а для
  Vite-проекта в образ копировались исходники и запускался `npm run dev` — то есть в
  прод уезжал dev-сервер. `.dockerignore` не было вообще, а вместе с ним в образ
  мог попасть `.env` с секретами.
- **Успех проверялся по тексту вывода.** «error» в логах успешной сборки давал ложный
  провал, а `Successfully built` где-то в чужой строке — ложный успех.
- **Никакой истории.** Каждый деплой затирал `:latest`, ничего не записывалось: после
  перезапуска приложения агент не знал, что уже создано, какая ревизия в проде и на что
  откатываться. Откат на прошлую версию был невозможен технически — образ-то один.
- **Проверки после выката не было.** «Задеплоено» означало лишь «ревизия создана».
  Упавшее приложение узнавал пользователь, а не приложение.

### Что сделано
- **`src/deploy-recipes.js`** — выверенные рецепты под тип проекта: Vite/React, Next.js,
  Nuxt, CRA, Node-сервер, Python (FastAPI/Flask/Django/Streamlit), Go, статика. Рецепт даёт
  команды установки и сборки, порт, пути проверки здоровья, многоэтапный Dockerfile и
  `.dockerignore`. Статику раздаёт nginx со слушателем на `$PORT` (Serverless Containers
  передаёт порт переменной окружения), а не dev-сервер. `.env` в образ не попадает никогда,
  pnpm/yarn/bun ставятся в образ явно, а несуществующие файлы зависимостей не копируются.
  Свой Dockerfile проекта всегда в приоритете и не перезаписывается.
- **`src/cloud-state.js`** — состояние облака проекта в `.cloud/`: `project.json`,
  `infrastructure.json`, `deployments.json`. Запись атомарная (tmp + rename), битый JSON
  откладывается в `.bak` и о потере сообщается, а не проглатывается. Нумерация деплоев как
  в консоли (#1, #2, #3…), значения секретов не сохраняются — только ключи.
- **`src/deploy-engine.js`** — детерминированный конвейер из 12 стадий: проверка окружения →
  определение проекта → локальные проверки (зависимости, сборка, тесты) → Dockerfile и
  `.dockerignore` → реестр → вход → сборка → загрузка → контейнер и доступ → ревизия →
  проверка → история. Зависимости внедряются, поэтому движок проверяется живьём на
  подменённых Docker и API.
  - код выхода команды, а не слова в выводе; IAM-токен уходит в `docker login` через stdin
    (в аргументах он был бы виден в списке процессов);
  - **образ получает тег с номером деплоя** (`:d17`), иначе откат указывал бы на тот же
    `:latest`;
  - **проверка после деплоя** — HTTP по путям рецепта с повторами (холодный старт),
    401/403 объясняется словами «публичный доступ не настроен», а не «ошибка»;
  - **самолечение:** если приложение не отвечает, движок откатывает контейнер на прошлую
    рабочую ревизию и проверяет её. Не получилось — так и говорит, без вранья про успех;
  - каждая стадия пишется в историю сразу: закрыли приложение посреди деплоя — видно, где
    остановились.
- **Одна точка правды вместо двух копий.** Кнопка (`yc:deploy`), IPC `deploy:run` и
  агентский инструмент `ycDeploy` идут через `runCloudDeploy` → движок. Своя копия деплоя
  из `main.js` удалена вместе со старым генератором Dockerfile (файл стал меньше, а логика
  переехала в модули). Новые IPC: `deploy:state`, `deploy:run`, `deploy:rollback`,
  `deploy:health`; `ycStatus` теперь рассказывает агенту состояние `.cloud` проекта.
- **Панель «Деплой»** (`src/renderer/deploy-panel.js` + `deploy-panel.css`) — новая вкладка
  правой панели, кнопка на рельсе и в шапке: рецепт проекта до запуска, текущий выкат
  (#номер, статус, адрес, образ, ревизия, время, HTTP проверки), стадии прогона с отметками,
  история с кнопками «открыть»/«откатить», просмотр логов контейнера, кнопки «Задеплоить»,
  «Откатить» и «Проверить адрес». Откатившиеся деплои видны в истории («откатились на #1»).

### Проверки
- Структурные (`bun run test`): **341/341** (+12: рецепты по семи типам проектов, секреты в
  образе, атомарность состояния, стадии и откат движка, отсутствие дублирующей логики).
- Живой веб-прогон (`bun run test:live`): **44/44** (проверка числа иконок рельсы обновлена).
- Живой сквозной тест десктопа (`bun run test:live:desktop`): **61/61**.
- Живой тест консоли YC (`bun run test:live:yc`): **27/27**.
- **Новый живой тест деплоя** (`bun run test:live:deploy`): **29/29** — настоящее окно Electron
  против подменённых Yandex Cloud и `docker` в PATH: рецепт виден до запуска, прогон кнопкой
  доходит до Production, адрес проверяется по-настоящему, состояние ложится в `.cloud`, секрет
  из `.env` не попадает ни в состояние, ни в переменные контейнера, а сломанный выкат движок
  сам откатывает и проверяет; кнопка «Откатить» работает отдельно.

### Итог по версиям
`package.json` → **1.5.71**, OTA-набор → см. `ota/manifest.json` (диск и бандл сверены
побайтово, sha256 сошёлся).

### Что осталось из плана
1. `main.js` и `agent-core.js` — 470 и 350 КБ: распускать по швам, иначе вставлять новое вслепую.
2. Секреты выдавать конкретному инструменту, а не всем командам сразу.
3. Перед дорогими ресурсами — оценка стоимости и подтверждение.
4. Шаблоны проектов (лендинг, API, бот): LLM выбирает шаблон и правит, а не пишет с нуля.

## 1.5.73 — стоимость облака: цена видна ДО создания

### Что было
Агент умел создавать ресурсы в Yandex Cloud (одним чекбоксом разрешения) и выкатывать
контейнеры, но не знал, сколько это стоит. Пользователь узнавал цену из счёта. Для
ресурсов, которые тарифицируются за время работы и за запросы, это худший вариант:
счёт растёт незаметно, а «попробовать» и «оставить на неделю» стоят по-разному.

### Что сделано
- **`src/yc-costs.js`** — тарифы, взятые из официальной документации (источник указан
  в каждом, дата — «сентябрь 2026», ₽ с НДС): контейнеры (3,79 ₽ за ГБ×час RAM, 5,69 ₽
  за vCPU×час, 18,97 ₽ за млн вызовов), реестр (0,004575 ₽ за ГБ×час), Object Storage
  (0,0033 ₽ за ГБ×час), Cloud DNS (0,0592 ₽ за зону×час), Lockbox (0,0274 ₽ за версию×час),
  исходящий трафик (первые 100 ГБ бесплатно). **Придуманных цен нет:** где тариф за
  единицу не подтверждён (YDB — плата за Request Units), числа не будет вовсе, будет
  ссылка на прайс и калькулятор.
- **Формула контейнера считается как в документации** и сверена с их примерами расчёта
  (2 ГБ / 0.2 vCPU / 3 млн вызовов → 1 061,34 ₽ — совпало до копейки). Бесплатный пакет
  вычитается: 100 тыс. вызовов в месяц укладываются в ноль.
- **Три сценария вместо одной цифры** — тихий сайт, живой сайт и «работает круглосуточно».
  Последний показывает, почему держать сайт включённым всегда плохо: на дефолтной ревизии
  (256 МБ, 1 vCPU) это ≈ 4 713 ₽ в месяц против 210,21 ₽ за миллион вызовов.
- **Платного без согласия не бывает.** В интерфейсе цена показывается в диалоге создания
  (согласие — нажатие «Создать» после цифры), у агента платный ресурс не создаётся без
  `confirm: true`, а до него инструмент возвращает цену и просьбу спросить пользователя.
  Бесплатный ресурс (сеть VPC) создаётся без лишних вопросов.
- **Новый инструмент `ycCosts`** — агент может посмотреть цену до создания: сводка по всем
  ресурсам плюс предупреждение о дорогом, что мы не создаём (ВМ 24/7, managed-базы,
  публичные адреса и NAT, трафик сверх 100 ГБ).
- **Панель «Деплой»** показывает стоимость ревизии до запуска — по тем же параметрам, что
  уходят в деплой: их теперь хранит один источник правды `REVISION_DEFAULTS` в
  `deploy-engine.js`, а не копия в оценке.

### Проверки
- Структурные: **352** (было 344) — арифметика сверена с примерами из документации,
  бесплатный пакет, покрытие всех создаваемых ресурсов, отсутствие выдуманных чисел,
  один источник правды по параметрам ревизии.
- Живой тест консоли YC: **38 ✅ / 0 ❌** (было 27) — цена считается заранее, видна в диалоге
  создания, без согласия запрос на создание **не уходит вообще**, с согласием ресурс
  создаётся, бесплатный — без вопросов.
- Живой тест деплоя: **40** (было 38) — стоимость ревизии и предупреждение о круглосуточной
  работе видны в панели до запуска.

### Попутно
- Живой тест консоли кликал по дашборду после фиксированной паузы и падал, если окно
  поднималось медленнее. Теперь он ждёт состояние (карточки, кнопку «Создать»), а не время.

## 1.5.72 — выкат проверяется настоящим браузером

### Что было
После деплоя приложение проверяло адрес только запросом: HTTP 200 по «/» — и всё,
«задеплоено». Но 200 отдаёт и пустая страница: если сборка положила в образ разметку
без скриптов, nginx честно отвечает 200, а пользователь видит белый экран. Ошибки
в консоли, не прошедшие запросы к своим же скриптам и исключения на странице не
видел никто. В плане это пункт «Browser должен стать частью deployment loop».

### Что сделано
- **`browser-tools.auditPage(url)`** — аудит страницы в браузере агента: слушает
  консоль и ошибки страницы, копит не прошедшие запросы, снимает скриншот и закрывает
  вкладку. Возвращает данные, а не текст — решение принимает отдельный модуль.
  Playwright-код остался там, где Playwright и так живёт.
- **`src/deploy-check.js`** — правила «страница действительно работает», чистые и
  тестируемые без браузера: белый экран (нет текста и нет элементов в #root) — провал;
  5xx, 404 и 401/403 (публичный доступ не настроен) — провал с объяснением; ошибки
  консоли и упавшие запросы — замечания, а не повод откатывать работающий сайт.
- **Стадия `browse` в движке деплоя** — после проверки адреса и до записи в историю.
  Провал страницы уходит в тот же путь, что и провал адреса: откат на прошлую рабочую
  ревизию и повторная проверка. Скриншот сохраняется в `.cloud/screenshots/d<номер>.png`
  (папка не растёт: держим последние 20).
  - **Если не поднялся сам браузер — деплой НЕ откатывается:** это ограничение проверки,
    а не поломка выката. Стадия тогда честно сообщает «пропущено» и пишет предупреждение.
  - После отката страница смотрится ещё раз; результат хранится отдельно
    (`browserCheckAfterRollback`) и не отменяет уже сделанный откат.
- **Агент видит результат**: `ycDeploy` сообщает, что увидел браузер, а `ycStatus` —
  состояние облака проекта из `.cloud`.
- **Панель «Деплой»**: блок «Страница в браузере» (код, длина текста, заголовок, число
  ошибок консоли), замечания списком и кнопка скриншота — картинка читается по просьбе
  через `fsReadImage`, без нагрузки на панель. Сообщение при откате теперь называет
  **причину**, а не только факт отката, иначе непонятно, что чинить.

### Проверки
- Структурные (`bun run test`): **344/344** (+3: правила проверки страницы, стадия в
  движке с откатом и скриншотом, честный пропуск без браузера).
- Живой веб-прогон (`bun run test:live`): **44/44**.
- Живой тест десктопа (`bun run test:live:desktop`): **61/61**.
- Живой тест консоли YC (`bun run test:live:yc`): **27/27**.
- **Живой тест деплоя** (`bun run test:live:deploy`): **38/38** — теперь сайт отдаёт
  настоящую страницу с ошибкой в консоли, и в живом окне проверяется: стадия «Проверка в
  браузере» видит заголовок и текст, ошибка консоли показана как замечание, скриншот
  сохранён и открывается в панели, а **белый экран при HTTP 200** приводит к откату — этого
  запросом по адресу не увидеть.

### Итог по версиям
`package.json` → **1.5.72**, OTA-набор → см. `ota/manifest.json` (диск и бандл сверены
побайтово, sha256 сошёлся).

### Что осталось из плана
1. `main.js` и `agent-core.js` — распускать по швам: новое вставляется вслепую.
2. Секреты выдавать конкретному инструменту, а не всем командам сразу.
3. Перед дорогими ресурсами — оценка стоимости и подтверждение.
4. Шаблоны проектов (лендинг, API, бот): выбирать и править вместо письма с нуля.

## 1.5.74 — первый шов в ядре: Yandex Cloud вынесен из main.js

### Что было
В плане пункт «распустить main.js и agent-core.js по швам» стоял первым не случайно:
main.js — 470 КБ и 8206 строк, agent-core.js — 350 КБ, app.js — 378 КБ. Внутренних
швов-разделов в файлах нет, поэтому новая логика вставлялась поиском по тексту, а
правки вроде «поправить подпись теста» уже не проходили обычной заменой — приходилось
писать патч-скрипты. При этом знание про Yandex Cloud было размазано по трём слоям
одного файла: агентские инструменты, служебные функции и 16 IPC-каналов, вперемешку с
почтой, памятью диалогов и деплоем.

### Что сделано
- **`src/yc-service.js`** (новый) — служебный слой Yandex Cloud: `ycConfig`,
  `ycRequireAuth`, поиск контейнера и его ревизий, подробности ревизии, чтение логов
  Cloud Logging внутренним API, статус и установка встроенного yc CLI, карта типов
  ресурсов. Модуль ничего не знает про окно, IPC и агента: зависимости приходят
  аргументами — та же конвенция, что у `createDeployEngine`.
- **`src/yc-ipc.js`** (новый) — все 16 каналов `yc:*`: авторизация и каталог, права
  агента, дашборд, обзор консоли, ревизии и откат, ресурсы, стоимость, создание и
  удаление, логи, yc CLI. `yc:deploy` намеренно остался мостом в main.js: это конвейер
  деплоя, а не облачный API.
- **main.js: 8206 → 7767 строк** (−439). На месте прежнего блока — короткое подключение:
  фабрика, разбор имён и регистрация моста. Все агентские инструменты и деплой видят
  те же имена, что и раньше, поэтому их код не менялся ни на строку.
- Тесты, которые читают исходники как текст, больше не ищут облачный код в main.js:
  добавлен `backendSrc()` (main.js + вынесенные модули), а тест среза кода логов читает
  `yc-service.js`. Сами проверки не ослаблены — изменился адрес кода, не смысл.

### Проверки
- Структурные: **355** (было 352) — три новых теста: в main.js каналов и помощников
  больше нет, служебный слой работает **без main.js** (конфигурация, ошибка 401, разбор
  аргументов строкой и объектом, строка и подробности ревизии), каналы отвечают на моках.
- Живой тест консоли YC: **38 ✅ / 0 ❌** — каналы, вынесенные в модуль, работают в настоящем
  окне: создание ресурсов, дашборд, права агента.
- Живой тест деплоя: **40 ✅ / 0 ❌**; живой десктоп: **61 ✅ / 0 ❌**; живой веб: **44/44**.

### Попутно
Новый тест сразу вскрыл две неточности: каналов в мосте 16, а не 17 (`yc:deploy` остался
мостом), и `ycRevisionDetails` требует поля `storageMounts` и `mounts` — без них функция
падала на `.length`. Второе — реальный хрупкий контракт: теперь он зафиксирован тестом.

### Что осталось из плана
1. Дальше резать `main.js` (7767 строк) и `agent-core.js` (5322 строки): следующий
   очевидный шов — почта (`mailConfig` + каналы) и деплой-мост.
2. Секреты выдавать конкретному инструменту, а не всем командам сразу.
3. Перед дорогими ресурсами — оценка стоимости и подтверждение: **сделано**.
4. Шаблоны проектов (лендинг, API, бот): LLM выбирает шаблон и правит, а не пишет с нуля.

## 1.5.75 — второй и третий шов: деплой-мост и почта

### Что было
После выноса Yandex Cloud в `main.js` остались ещё два чужих по смыслу блока:

- **деплой-мост** — запуск команды с кодом выхода, события стадий, сводка состояния
  проекта, браузерная проверка и пять каналов, втиснутые между почтой и файловой
  панелью;
- **почта** — сборка конфигурации подключения (пресеты Gmail/Яндекс/Mail.ru/Outlook/
  Rambler) и три канала, разнесённые по файлу: конфигурация в одном месте, каналы —
  за полторы тысячи строк от неё.

### Что сделано
- **`src/deploy-ipc.js`** (новый, 281 стр.) — обвязка вокруг чистого конвейера:
  `runCapture` (настоящий код выхода процесса, ввод через stdin), `deployEmitter`,
  `cloudDeployBrief`, `deployBrowserAudit`, `runCloudDeploy` и пять каналов
  (`yc:deploy`, `deploy:state`, `deploy:run`, `deploy:rollback`, `deploy:health`).
- **`src/mail-ipc.js`** (новый, 100 стр.) — конфигурация подключения и три канала
  (`mail:test`, `mail:recent`, `mail:testSend`). Протокол остаётся в чистом
  `src/mail.js`, внешних зависимостей не добавилось.
- **`main.js`: 8206 → 7502 строки** за два выпуска (вместе с Yandex Cloud). В этом
  выпуске убрано 284 строки: 221 — деплой, 75 — почта (минус короткие подключения).

### Два решения по существу
- **Живые окно и отправитель событий.** В деплой-мосте две вещи нельзя передать
  значением: активный отправитель событий агента (`activeEmit`) и окно (`mainWindow`)
  меняются по ходу работы приложения. Передали функциями (`getEmit`, `getWindow`):
  копия значения «застыла» бы на `null` и панель деплоя перестала бы получать стадии.
- **Почта без сети без настроек.** Тест проверяет, что при пустых настройках не уходит
  НИ ОДИН запрос: интерфейс получает понятное «укажи адрес почты», а не таймаут.

### Проверки
- Структурные: **362** (было 355) — семь новых тестов: границы модулей, код выхода
  процесса (`exit 0`, `exit 3`, таймаут → 124, «error» в выводе при коде 0 — не провал),
  ввод через stdin, события стадий и итога, откат в итоге, конфигурация почты из пресета,
  каналы почты без единого сетевого запроса.
- Живой тест деплоя: **40 ✅ / 0 ❌** — кнопка деплоя идёт через новый модуль, панель
  получает стадии, откат сломанного выката работает.
- Живой десктоп: **61 ✅ / 0 ❌**; живой тест консоли YC: **38 ✅ / 0 ❌**; живой веб: **44/44**.

### Что осталось из плана
1. `main.js` — 7502 строки: следующий шов — файловая панель (`fs:*`) и git (`git:*`),
   это больше двух тысяч строк одним куском.
2. `agent-core.js` (5321 строка): провода провайдеров и планировщик — там почти нет
   общего состояния, шов проще, чем в main.js.
3. Секреты выдавать конкретному инструменту, а не всем командам сразу.
4. Шаблоны проектов (лендинг, API, бот).

## 1.5.76 — четвёртый шов: файловая панель и git

### Что было
После выноса облака, деплоя и почты в `main.js` остался самый крупный чужой блок:
десять каналов файловой панели и семнадцать git-каналов — четыре с половиной сотни
строк, втиснутых между деплоем и жизненным циклом приложения.

### Что сделано
- **`src/fs-ipc.js`** (224 стр.) — каналы файловой панели: карта папки, чтение файла
  и картинки, создание файла и папки, запись, удаление, импорт перетащенных файлов,
  открытие в проводнике и ссылок в системном браузере. Список бинарных расширений
  отдаётся наружу (`BINARY_EXT`): по нему агент решает, стоит ли вообще открывать файл,
  и второй копии этого списка больше нет.
- **`src/git-ipc.js`** (285 стр.) — семнадцать git-каналов: сведения о репозитории,
  статус, журнал и подробности коммита, pull/push, индексация и отмена, откат файла и
  всего коммита, diff, коммит и клон. Запуск git остаётся в main.js: им пользуются и
  агентские инструменты, и деплой — дублировать его нельзя.
- **`main.js`: 7502 → 7076 строк** (в этом выпуске −426).

### Найдено и исправлено
- **Три зависимости, которые не были внедрены**: `git:commit` звал `stageAllSafe`,
  а `git:rm`/`git:diff` — `fs` и `path`. Такая ошибка не видна ни проверке
  синтаксиса, ни тестам, которые не ходят в эту ветку: она падает у пользователя при
  первом коммите. Чтобы это не повторилось, в тесты добавлен **страж**: он сверяет все
  вынесенные модули с именами main.js и падает, если модуль ссылается на то, чего ему
  не передали (свойства вида `obj.path` при этом не считаются ссылкой).
- **`git:diff` проверял путь сам, в обход общего правила.** Остальные git-каналы зовут
  `gitRelFile`, а diff считал путь руками — и на файл ВНЕ рабочей папки отвечал
  «не в git», попутно сообщая его размер. Мелочь, но правило должно быть одно: теперь
  diff идёт тем же помощником, что и `git:rm`.
- **Живой тест десктопа снимал события сразу после `sendMessage`** и падал, если
  результат инструмента приходил позже: картинка уже лежала на диске, а тест говорил
  «инструмент не отработал». Теперь он ждёт результат, а не фиксированную паузу.

### Проверки
- Структурные: **365** (было 362) — страж зависимостей, файловая панель (бинарные
  файлы, отклонение имён «..» и «a/b», границы рабочей папки, отказ открывать
  `file:///`) и git-панель (путь вне папки, пустое сообщение коммита, клон с
  неподдерживаемым протоколом, запись состояния агента сеттерами).
- Живой десктоп: **61 ✅ / 0 ❌**; живой веб: **44/44**; живой тест деплоя: **40 ✅ / 0 ❌**;
  живой тест консоли YC: **38 ✅ / 0 ❌**.

### Где мы по разрезанию ядра
`main.js` прошёл путь **8206 → 7076 строк** (−1130) за три выпуска: облако, деплой,
почта, файлы, git. Всего вынесено **шесть модулей** общим размером 1400 строк, каждый
со своими тестами в plain-node.

### Что осталось из плана
1. `main.js` — 7076 строк: самый крупный оставшийся кусок — агентские инструменты
   (`executeTool`, около двух тысяч строк) и системный промпт.
2. `agent-core.js` (5321 строка): провода провайдеров и планировщик — там почти нет
   общего состояния, шов проще.
3. Секреты выдавать конкретному инструменту, а не всем командам сразу.
4. Шаблоны проектов (лендинг, API, бот).

## 1.5.77 — пятый шов: реестр инструментов подключён к окружению main.js

### Что было не так (нашёл живой прогон, не тесты)
При выносе `executeTool` из `main.js` тела 154 обработчиков переехали побайтово, но
часть имён осталась «свободной»: в `main.js` такие имена брались из окружающей области
видимости, а в своём модуле их просто нет. Проверка синтаксиса молчит, а тесты не
заходили в эти ветки — падало у пользователя и только в конкретном инструменте.
**Генерация изображений не работала вовсе**: `auxConfig is not defined`.

### Что сделано
- **57 имён переданы в модуль** (`src/agent-tools.js` + вызов `createAgentTools` в `main.js`):
  `auxConfig`, `describeImageRemote`, `generateImageRemote` — вспомогательная модель;
  `stripAnsi`, `spawnCollect`, `spawnRaw`, `explainExit`, `installSystemPkg`, `downloadFileTo`,
  `findInstallersIn`, `downloadAndExtractTo`, `runAsAdmin`, `envPathInfo`, `findProgram`,
  `runProgVersion`, `psScript`, `cachedPs`, `invalidatePsCache`, `refreshEnvFromOS` — терминал;
  `userDataDir`, `agentStore`, `emitTasksChanged` — дела и заметки;
  `app`, `clipboard`, `desktopCapturer`, `execFile` — окно и система;
  `audit`, `persistUndo`, `loadPersistedUndo`, `codeIndex`, `unifiedPatch`, `refactorRenameFiles`,
  `findSymbolReferences`, `bgWaitFor`, `encodeShot`, `ycCosts` и облачные `ycConfig`,
  `ycFindContainerByRef`, `ycActiveRevision`, `ycJsonArg`, `ycRevisionLine`, `ycRevisionDetails`,
  `readYcLogsText`, `ycCliStatus`, `ycCliInstall`, `runCloudDeploy`, `cloudDeployBrief`.
- **Три изменяемых значения получили мост с сеттерами** (`activeRunUndo`, `lastUndoLog`,
  `activePlanSummary`): их не только читают, но и записывают. Шесть строк писали напрямую
  в обход моста — откат правок падал с `activeRunUndo is not defined`.

### Найдено попутно
- **Комментарий с двоеточием внутри `require`-блока склеивал имена**: построчный разбор
  терял `auxConfig` — поэтому прежний страж пропуск и не увидел. Комментарии теперь
  убираются внутри разбираемого блока, а `require` может переноситься на много строк.
- **Страж стал точным и переехал в `test/backend-wiring.js`**: вырезает строки, регулярки,
  комментарии; своими считает параметры (включая `catch`, стрелки, `for-of`), объявления
  функций и ключи `get`/`set`. Ловит три вещи: имя из `main.js` без внедрения, присваивание
  чужому имени без сеттера и голое обращение к живому значению. Плюс тест на сам страж:
  он обязан ловить посаженную ошибку и не считать ошибкой строку или свойство объекта.

### Проверки (всё на запущенном приложении)
- Структурные: **370 ✅ / 0 ❌** (было 365).
- Живой десктоп: **61 ✅ / 0 ❌** — генерация изображения снова работает:
  «OK — изображение сгенерировано и сохранено: kot.png (67 байт, image/png)».
- Живой тест консоли YC: **38 ✅ / 0 ❌**; живой тест деплоя: **40 ✅ / 0 ❌**; живой веб: **44/44**.

### Что осталось из плана
1. `agent-core.js` (5321 строка): провода провайдеров и планировщик — общего состояния мало.
2. Секреты выдавать конкретному инструменту, а не всем командам сразу.
3. Шаблоны проектов (лендинг, API, бот).

## 1.5.78 — шестой шов: системный раздел вынесен из main.js

### Что вынесено
| Модуль | Роль |
|---|---|
| **`src/system-stack.js`** (497 стр.) | PATH и его слияние, поиск программ (`findProgram`, `runProgVersion`), запуск процессов с разбором кодов выхода (`spawnRaw`, `explainExit`), живая сессия PowerShell с коротким кэшем справок (`psScript`, `cachedPs`, `invalidatePsCache`, `refreshEnvFromOS`), установка системными менеджерами (`installSystemPkg`), загрузка файлов и архивов (`downloadFileTo`, `downloadAndExtractTo`, `findInstallersIn`), запуск от администратора (`runAsAdmin`) |

**`main.js`: 4903 → 4499 строк** (−404). Всего вынесено **восемь модулей**; имя каждого
осталось в `main.js` тем же, поэтому агентские инструменты, IPC и деплой не менялись ни на строку.

### Одно решение по существу
**Окружение агента (`agentEnv`) отдано живым.** Оно пересобирается при смене настроек и прав
Yandex Cloud, а команды получают из него PATH и токены. Передача копией «застыла» бы на пустом
объекте — команды остались бы без PATH и без доступа к облаку, причём только после смены настроек.
Скрипт извлечения развернул `...agentEnv` в `...live.agentEnv`.

### Проверки — тесты теперь читают модуль, а не срез текста
Три проверки резали код `main.js` по тексту (`spawnRaw`, `findInstallersIn`) и смотрели на
переехавший код. Теперь они берут **настоящий модуль** — срез молча «зеленел» бы на исчезнувшем коде.

| Набор | Результат |
|---|---|
| Структурные `bun run test` | **375 ✅ / 0 ❌** (было 370; +5 на модуль) |
| Живой десктоп | **61 ✅ / 0 ❌** |
| Живой тест консоли YC | **38 ✅ / 0 ❌** |
| Живой тест деплоя | **40 ✅ / 0 ❌** |
| Живой веб `test:live` | **44/44** |

Новые тесты работают без Electron: PATH сливается без дублей и в порядке «своё, потом системное»;
код 127 ведёт к `installSystemPackage` и `refreshEnv`, 9009 объясняется как «команда не найдена»,
0 — «успех»; `downloadFileTo` уважает лимит размера (и **не пишет** слишком большой файл на диск),
отдаёт HTTP 404 как ошибку и считает размер при успехе; `findProgram` не выдумывает путь;
`installSystemPkg` не запускает установку для уже установленной программы.

### Что осталось из плана
1. `agent-core.js` (5321 строка): провода провайдеров и планировщик.
2. `installExe` по шагам: скачать → показать хэш и издателя → подтверждение → установить.
3. Секреты — конкретному инструменту, а не всем командам сразу.
4. Шаблоны проектов (лендинг, API, бот).

## 1.5.79 — седьмой шов: веб и вспомогательная модель вынесены из agent-core.js

### Что вынесено
| Модуль | Роль |
|---|---|
| **`src/renderer/web-tools.js`** (224 стр.) | Поиск и чтение страниц без API-ключей: загрузка HTML с таймаутом и лимитом 2 МБ, распаковка ссылок DuckDuckGo, разбор html- и lite-выдачи, поиск через Serper, превращение HTML в читаемый текст |
| **`src/renderer/image-tools.js`** (432 стр.) | Вспомогательная модель: разбор картинок (зрение) и генерация изображений — определение провайдера по адресу, перебор путей `/images/generations` → `/images`, YandexART с опросом операции, понятная ошибка со всеми попытками |

**`agent-core.js`: 5321 → 4741 строка** (−580). Ядро осталось владельцем транспорта и раздаёт
модули наружу теми же именами, поэтому `main.js`, preview-сервер, реестр инструментов и настройки
не менялись ни на строку.

### Шов проходит по зависимостям, а не по строкам
Перед разрезом посчитал настоящие связи (временный анализатор разбирает блоки, вырезая строки,
комментарии, регулярки и объявления). Карта получилась такая:

| Блок | Строк | Что тянет из ядра |
|---|---|---|
| веб | 203 | **ничего** — чистый лист |
| изображения | 397 | `apiHeaders`, `proxiedBase`, `readApiError` |
| транспорт | 836 | `OLLAMA_KEEP_ALIVE`, `TOOL_DEFINITIONS`, `ollamaNumCtx` |
| контекст и компакция | 247 | транспортные помощники + `partsText`, `truncateText` |

Поэтому первыми ушли два листа: изображения получают три помощника аргументом, веб не получает
ничего. Порядок следующих швов теперь не догадка, а карта.

### Одно решение по существу
**`classifyKeyError` уехал из веб-блока к лимитам провайдера.** Он лежал между `webSearchSerper`
и `webSearch`, но к вебу отношения не имеет: это классификация ошибок ключа (401/402/429 → пауза).
В веб-модуле он выглядел бы «частью поиска», а при выносе транспорта уехал бы второй раз.

### Три пути загрузки — новая проверка
Модуль окна грузится тремя способами, и забытый путь не виден ни компилятору, ни обычным тестам:
в Electron main — `require`, в окне — тег `<script>` (иначе `window.WebTools` пуст и окно белое),
телефону — список файлов preview-моста. Страж проверяет все три сразу, плюс обратное: что вынесенный
модуль не тянет за собой ядро.

### Проверки
| Набор | Результат |
|---|---|
| Структурные `bun run test` | **382 ✅ / 0 ❌** (было 375; +7) |
| Живой веб `test:live` | **46 ✅ / 0 ❌** (было 44) |
| Живой десктоп | **61 ✅ / 0 ❌** |
| Живой тест консоли YC | **38 ✅ / 0 ❌** |
| Живой тест деплоя | **40 ✅ / 0 ❌** |

Новые тесты идут без Electron: разбор html- и lite-выдачи, распаковка ссылок, обрезка разметки,
404/таймаут/лимит 2 МБ у `downloadHtml`, переход поиска с html на lite, отказ ключа Serper;
для изображений — сборка на трёх подставленных помощниках и то, что адрес и тело ошибки берутся
из переданной конфигурации, а не из настроек приложения.

### Что осталось из плана
1. **Транспорт провайдеров** (836 строк): `buildChatRequest`, стрим, лимиты, `classifyKeyError` — зависимости уже известны.
2. `installExe` по шагам: скачать → показать хэш и издателя → подтверждение → установить.
3. Секреты — конкретному инструменту, а не всем командам сразу.
4. Шаблоны проектов (лендинг, API, бот).

## 1.5.80 — восьмой шов: подключение к провайдеру вынесено из agent-core.js

Первая часть разреза транспорта. Транспорт специально режется **по слоям**, а не целиком:
сначала подключение (куда и с чем обращаться), затем сообщения и стрим.

### Что вынесено
| Модуль | Роль |
|---|---|
| **`src/renderer/provider-config.js`** (339 стр.) | Реестр провайдеров G4F и маршрут «Провайдер:модель», адрес провайдера (`baseFor`, `trimBase`, `anthropicApiBase`), прокси браузерного режима (`proxiedBase`), ключ и заголовки (`apiKeyFor`, `apiHeaders`, `projectHeader`), разбор аргументов вызова (`jsonArgs`), идентификатор вызова (`genCallId`), чтение ошибки (`readApiError`), объяснение лимита Groq (`friendlyRateLimitError`), классификация ошибки ключа (`classifyKeyError`), пауза по 429 (`rateLimitInfo`) и держатель темпа (`createRateLimiter`), текст исключения (`fmtError`) |

**`agent-core.js`: 4741 → 4473 строки** (−268). Наружу ядро отдаёт те же имена, поэтому
`main.js`, окно, preview-сервер и инструменты не менялись ни на строку.

### Почему этот шов безопасен — и это проверено, а не предположено
Анализатор связности показал: у блока **ноль** зависимостей от ядра. Все настройки приходят
аргументом (`baseFor(provider, s)`, `apiHeaders(provider, key, fromBrowser, extra)`), а
состояние — только внутри держателя темпа. Поэтому модуль собран **первым**: он не получает
из ядра ничего, а ядро получает от него пятнадцать имён.

### Одно решение по существу
**Объявления модуля подняты в начало фабрики ядра.** Контекст (строки ~2260) стоит в файле
*выше* адресов и ключей, а вызывает их позже — при исполнении. Объявление `const` в начале
файла снимает вопрос о порядке: любая функция ядра видит нужное имя, где бы она ни лежала.

### Проверки
| Набор | Результат |
|---|---|
| Структурные `bun run test` | **384 ✅ / 0 ❌** (было 382; +2 на модуль) |
| Живой веб `test:live` | **47 ✅ / 0 ❌** (было 46) |
| Живой десктоп | **61 ✅ / 0 ❌** |
| Живой тест консоли YC | **38 ✅ / 0 ❌** |
| Живой тест деплоя | **40 ✅ / 0 ❌** |

Новые тесты идут без агента: адрес провайдера по умолчанию и свой (хвостовой слэш убран, `/v1`
у Anthropic не дублируется), ключ каждого семейства с откатом на общий, **у Ollama в заголовках
нет Authorization**, браузерный заголовок Anthropic уходит только из браузера, каталог Yandex
доходит до запроса; разбор строки аргументов и битой строки; уникальность идентификатора вызова;
маршрут G4F разбирается только для известных провайдеров (чужое `openai/gpt-4o:free` не трогаем);
ошибка читается из JSON и обрезается до 600 символов, нечитаемое тело не роняет разбор; лимит Groq
объясняется только для Groq; 400 **не** считается ошибкой ключа; пауза берётся из `Retry-After`,
из текста и из окна лимита («Maximum 8 requests within 1 minutes» → 60 с), ограничена сверху;
держатель темпа расставляет запросы и не делит состояние между экземплярами.

### Что осталось из плана
1. **Вторая часть транспорта** (648 стр.): конвертация сообщений (`contentForProvider`, `messagesForProvider`, `toolsForProvider`), кэш промпта, `buildChatRequest`, `consumeProviderStream`, `listModels` и окно Ollama.
2. `installExe` по шагам: скачать → показать хэш и издателя → подтверждение → установить.
3. Секреты — конкретному инструменту, а не всем командам сразу.
4. Шаблоны проектов (лендинг, API, бот).

## 1.5.81 — девятый шов: транспорт провайдеров вынесен из agent-core.js

Вторая (заключительная) часть разреза транспорта: после подключения уехали сообщения и стрим.

### Что вынесено
| Модуль | Роль |
|---|---|
| **`src/renderer/provider-transport.js`** (705 стр.) | Перевод канонических сообщений агента в диалект семейства (`contentForProvider`, `messagesForProvider`, `systemText`, `toolsForProvider`), кэш промпта (`cacheableProvider`, `splitStaticSystem`, `anthropicSystem`, `withCacheOnFirstSystem`), сборка запроса (`buildChatRequest`), разбор потока всех трёх семейств (`consumeProviderStream`, `normalizeUsage`), список моделей (`listModels`) и реальное окно модели (`ollamaModelInfo`, `ollamaNumCtx`, `modelWindow`) |

Модуль получает **ровно две вещи**: подключение (`config`) и таблицу инструментов агента
(`toolDefinitions`). Настройки приложения ему не видны — всё приходит аргументами.

**`agent-core.js`: 4473 → 3849 строк** (−624). Всего за разрезание: **5321 → 3849** (−1472),
пять модулей окна: подключение (339), транспорт (705), веб (224), изображения (432).

### Ловушка, из-за которой я гнался за ложным провалом
Живой тест консоли Yandex Cloud упал: дашборд пустой, к API ушло три запроса вместо десятка.
Причина оказалась не в коде: **десктопное приложение работает из применённого OTA-набора**, а
набор был собран ещё до второй части. Приложение подхватило старый `agent-core.js` вместе с
новым окном — набор и рабочая копия разошлись. После пересборки набора тест снова **38 ✅ / 0 ❌**.
**Правило: после переноса файлов сначала `node scripts/make-ota.js`, потом живые тесты** — иначе
симптомы ведут не туда, где ошибка.

### Страж стал точнее — и благодаря этому поймал сам себя
Проверка «модуль не тянет за собой ядро» ругалась на `genCallId`: он объявлен **внутри** модуля
(получен из `config`), то есть как раз внедрён. Страж теперь считает объявленные имена своими
(объявления, деструктуризация, параметры стрелок и функций) и ловит только по-настоящему
свободные. Так проверка остаётся настоящей, а не списком исключений.

### Проверки
| Набор | Результат |
|---|---|
| Структурные `bun run test` | **387 ✅ / 0 ❌** (было 384; +3 на транспорт) |
| Живой веб `test:live` | **48 ✅ / 0 ❌** (было 47) |
| Живой десктоп | **61 ✅ / 0 ❌** |
| Живой тест консоли YC | **38 ✅ / 0 ❌** |
| Живой тест деплоя | **40 ✅ / 0 ❌** |

Новые тесты идут **без ядра** — модуль собирается на подключении и таблице инструментов:
адрес и ключ каждого семейства, схемы инструментов в диалекте Anthropic (`input_schema`, без
`function`), `num_ctx` и удержание модели у Ollama, явно пустая таблица против таблицы модуля;
разбор потока всех трёх семейств (текст, куски аргументов вызова, рассуждения Ollama,
`input_json_delta` Anthropic); окно модели спрашивается один раз и кэшируется.

### Что осталось из плана
1. **Контекст и компакция** (262 стр.): `estimateTokens`, `contextBudget`, `trimConversation`, `compactRemote`, `createContextManager` — последний крупный шов в ядре.
2. `installExe` по шагам: скачать → показать хэш и издателя → подтверждение → установить.
3. Секреты — конкретному инструменту, а не всем командам сразу.
4. Шаблоны проектов (лендинг, API, бот).

## 1.5.82 — десятый шов: контекст и компакция вынесены из agent-core.js

Последний крупный перенос из ядра окна: после подключения, транспорта, веба и изображений уехал
контекст — всё, что считает объём диалога и решает, что из него выбросить.

### Что вынесено
| Модуль | Роль |
|---|---|
| **`src/renderer/context-window.js`** (286 стр.) | Оценка объёма (`estimateTokens`, `estimateMessageTokens`), бюджет окна (`contextBudget`), чистка пар «вызов — ответ» (`sanitizeToolPairs`), обрезка истории (`trimConversation`, `truncateText`), сжатие через вспомогательную модель (`compactRemote`) и менеджер контекста (`createContextManager`) |

**`agent-core.js`: 3849 → 3619 строк** (−230). Всего за разрезание: **5321 → 3619** (−1702),
шесть модулей окна: подключение (339), транспорт (705), контекст (286), веб (224), изображения (432).

### Ловушка: вызов выше объявления
На уровне фабрики агента есть **немедленный** вызов `estimateTokens`. Значит объявления
вынесенного модуля обязаны стоять **выше** фабрики, иначе ядро упало бы на старте — а обычные
тесты этого не увидели бы, потому что модуль подключается тегом `<script>` в окне. Порядок
подключения проверен явно (модули строго до ядра) и закреплён стражем.

### Живые тесты падали на собственной гонке, а не на приложении
Оба живых набора — деплой и консоль Yandex Cloud — начали падать на **первом клике по рельсе**:
панель не открывалась, дальше сыпались все проверки шага. Код был цел: тест жмёт кнопку **один
раз** после фиксированной паузы, а окно навешивает обработчики только после загрузки модулей —
и с ростом числа файлов это окно стало длиннее, чем пауза. Диагноз подтвердился тем, что тот же
набор сразу после перезапуска давал 38 ✅ / 0 ❌.
Теперь оба теста жмут **до появления панели** (с ограничением попыток) и печатают ошибки страницы,
если она так и не открылась. Это была настоящая хрупкость проверки: она сообщала о дефекте там,
где дефекта нет, и могла скрыть настоящий.

### Проверки — всё на запущенном приложении
| Набор | Результат |
|---|---|
| Структурные `bun run test` | **390 ✅ / 0 ❌** (было 387; +3 на контекст) |
| Живой веб `test:live` | **49 ✅ / 0 ❌** (+1: модуль в проверке состава окна) |
| Живой десктоп | **61 ✅ / 0 ❌** |
| Живой тест консоли YC | **38 ✅ / 0 ❌** |
| Живой тест деплоя | **40 ✅ / 0 ❌** |

Новые тесты идут без ядра: оценка объёма сообщений и запроса, бюджет окна на каждое семейство,
чистка пар «вызов — ответ» (осиротевший вызов не остаётся без ответа), обрезка истории сохраняет
цель задачи, а менеджер сжимает переполнение и не теряет её.

### Что осталось из плана
1. `installExe` по шагам: скачать → показать хэш и издателя → подтверждение → установить.
2. Секреты — конкретному инструменту, а не всем командам сразу.
3. Шаблоны проектов (лендинг, API, бот).

## 1.5.83 — installExe: скачать → проверить → показать → запустить

Инструмент мог скачать произвольный файл по ссылке и сразу его выполнить. Подтверждение
пользователя было (политика: `system.install`, риск high, confirm), но оно показывает только
ссылку — а что именно приехало, не знал никто: ни хэша, ни издателя, ни размера.

### Что теперь происходит
| Шаг | Было | Стало |
|---|---|---|
| Скачать | downloadFileTo | без изменений |
| Проверить | — | SHA-256 каждого файла + подпись Authenticode (Windows) через `Get-AuthenticodeSignature` |
| Показать | размер | размер, SHA-256 (с пометкой «совпал с заданным»), подпись: статус и издатель |
| Запустить | сразу | только если проверка пройдена: заданный `sha256` совпал и подпись действительна (либо явный `allowUnsigned: true`) |

Новые параметры: **`sha256`** — ожидаемый хэш (при несовпадении запуск не состоится: это защита
от подмены при загрузке), **`allowUnsigned: true`** — осознанное разрешение запустить файл с
недействительной подписью. Проверка встроена во все три ветки: `.exe`, `.msi` (msiexec) и
установщик, найденный внутри `.zip`.

### Где живёт проверка
**`src/system-stack.js`** (+ `fileSha256`, `verifyInstaller`, `installerFacts`, `installerGate`):
рядом с загрузкой файлов, откуда её можно проверять в plain-node, а не срезом текста инструмента.
Инструмент получает готовый отчёт и решение — форматирование и логика отказа не размазаны по веткам.

### Найденная (и закрытая) ловушка — в моей же правке
Вставка строки с фактами попала не в ту ветку: `factsZip` оказался в ветке «установщика в архиве
не нашлось», где он объявлен **ниже** — то есть упал бы на первом же portable-архиве (TDZ).
Ни синтаксис, ни прежние тесты этого не видят. Теперь на это есть постоянная проверка: **каждое
объявленное имя обязано быть объявлено ДО использования** — она и поймала промах.

### Проверки — всё на запущенном приложении
| Набор | Результат |
|---|---|
| Структурные `bun run test` | **397 ✅ / 0 ❌** (было 390; +7) |
| Живой веб `test:live` | **49 ✅ / 0 ❌** |
| Живой десктоп | **61 ✅ / 0 ❌** |
| Живой тест консоли YC | **38 ✅ / 0 ❌** |
| Живой тест деплоя | **40 ✅ / 0 ❌** |

Тесты идут на **настоящих** функциях модуля: хэш считается по файлу, приставка `sha256:` и регистр
не мешают, чужой хэш даёт отказ с обоими хэшами (`allowUnsigned` сверку не отменяет), отсутствие
файла — понятная ошибка. Ветка Windows проверяется подменой `process.platform` и подставленным
PowerShell: разбор статуса и издателя, «нет живой сессии» → «нет данных», неразобранный ответ →
`Unknown`. Отдельная проверка смотрит **порядок**: во всех трёх ветках отказ стоит раньше запуска,
локальных копий помощников в инструменте нет, а объявление фактов предшествует их использованию.

### Что осталось из плана
1. Секреты — конкретному инструменту, а не всем командам сразу.
2. Шаблоны проектов (лендинг, API, бот).

## 1.5.84 — секреты выдаются конкретному инструменту, а не всем командам сразу

### Что было
Переменные агента (`settings.agentEnv` — ключи, пароли, токены пользователя) подмешивались
в окружение ЛЮБОЙ команды агента: сборка проекта, git, docker, yc, браузер — всё получало
весь набор сразу. Единственное ограничение появилось в 1.5.70: команда-дамп окружения
(`env`, `printenv`, `set`, `Get-ChildItem Env:`) получала только PATH. Остальное было
«всем и сразу»: одна утечка в логе, отчёте или отправленном конфиге раскрывала сразу все
ключи пользователя, а модель получала то, что задаче не нужно.

### Что сделано

| Кому выдаётся окружение | Было | Стало |
|---|---|---|
| `runCommand`, фоновые процессы, shell, превью | весь набор | выданное группе `terminal` |
| git (инструменты И панель) | весь набор | своё назначение: `git.push` / `git.clone` / `git.commit` / `git.read` |
| облако, БД, установщики | весь набор | `cloud.*`, `db.query`, `system.install` |
| дамп окружения (`env`, `printenv`) | PATH | PATH (как было — это правило 1.5.70) |

- **Хранение:** `settings.agentEnvScopes` — `{ ИМЯ: ["terminal", "git"] }`. Записи нет —
  переменная доходит всюду, как раньше (совместимость сохранена); запись есть — только
  названному инструменту или группе.
- **Политика — одна точка правды.** В `tool-policy.js` добавлены `scopeGroups()`,
  `normalizeScopes()`, `scopeAllows()`, `envForCapability()`, `scopeSummary()`. Группы
  собираются ИЗ таблицы capability (`terminal`, `git`, `browser`, `cloud`, `files`, … —
  22 группы), отдельного списка нет: интерфейс и политика разойтись не могут.
  Ограничение понимает и группу (`git`), и точную capability (`git.push`), и `"*"`.
- **Ошибка в безопасную сторону.** Незнакомое имя ограничения (опечатка) или пустой
  список — переменная не выдаётся НИКОМУ. Опечатка сужает доступ, а не открывает его.
- **main.js:** единая точка выдачи `envFor(capability)`; `executeTool` объявляет
  назначение инструмента на время вызова (`activeToolCapability`, сброс в `finally`);
  `commandEnv(command, capability)` сохранил защиту от дампа; `runGit` принимает операцию
  4-м аргументом; для действий НЕ от инструмента добавлен `withCapability()` (клон и
  публикация из панели). Инструмент в работе важнее: команда внутри облачного инструмента
  получает выданное облаку, а не терминалу.
- **git-панель:** 17 каналов передают свою операцию в `runGit`, клон идёт под
  `withCapability("git.clone", …)` — переменные, выданные git, доходят и до кнопок.
- **system-stack:** `spawnRaw` берёт окружение через `live.envFor(o.capability)` — модуль
  больше не читает `live.agentEnv` напрямую (проверено тестом по вызову и по тексту).
- **envSet:** необязательный `scopes` (группы или точные capability), `envList` показывает
  выдачу каждой переменной, правило 13 системного промпта объясняет параметр агенту.
- **Интерфейс:** у каждой переменной в настройках — селект «кому» («Всем командам» /
  «Ни одному инструменту» / группа с числом инструментов) и подсказка; выдача приходит
  каналом `policy:groups` (preload и мобильный мост тоже — настройки с телефона работают
  так же). `envList` и селект говорят одно и то же: сводка собирается той же политикой.

### Ловушка, найденная по ходу (и закрытая)
`envSet`/`envUnset` падали в живом приложении: `ReferenceError: userAgentEnv is not defined`.
После разреза модуля инструментов осталось «голое» имя main.js вместо чтения через мост
(`live.userAgentEnv`), а вызывать инструмент никто не пробовал: ни синтаксис, ни 397
прежних тестов этого не видели — агент получал «Ошибка: userAgentEnv is not defined»
вместо работающей переменной. Теперь это проверяется ВЫЗОВОМ (envSet → запись выдачи →
envList → envUnset). Заодно уточнён страж связи: `envFor` был передан через мост `live`, и
проверка «ни одного имени из main.js без внедрения» справедливо его не признала — теперь
он передаётся обычной зависимостью модуля.

### Проверки — всё на запущенном приложении
| Набор | Результат |
|---|---|
| Структурные `bun run test` | **405 ✅ / 0 ❌** (было 397; +8) |
| Живой веб `test:live` | **55 ✅ / 0 ❌** (было 49; +6 — выдача в самих настройках) |
| Живой десктоп `test:live:desktop` | **61 ✅ / 0 ❌** |

Новые проверки идут по вызовам, а не по тексту: правило выдачи на всех ветках (включая
опечатку, которая обязана сужать доступ), группы против таблицы прав (каждая capability
ровно в одной группе и каждая группа реально отдаёт выданное), git-панель — по аргументам,
которые дошли до `runGit`, системный раздел — по окружению, которое получил процесс,
`envSet`/`envList`/`envUnset` — реальными вызовами, интерфейс — по наличию селекта и канала.
В живом браузере (`scripts/live-ui.js`) добавлены шесть проверок: у переменной виден выбор
выдачи, предлагаются «всем» и «ни одному», по умолчанию — «всем», выбранное сохраняется
в настройках, ограничение видно в строке, а возврат к «всем» убирает запись из настроек
(«нет записи» и «пустой список» — разные состояния, и разница видна в самом файле).

### Итог по версиям
`package.json` → **1.5.84**, OTA-набор → **1.5.89** (авто-бамп строго выше прошлого 1.5.88:
иначе обновление не применилось бы; при сборке синтаксис всех 49 JS проверен).

### Что осталось из плана
1. Шаблоны проектов (лендинг, API, бот).

## 1.5.85 — дела повторяются, и планировщик реально будит агента

**Что было не так.** Планировщик дел существовал, но умел ровно одно: за 15 минут до срока
показать тост и уведомление Windows. Отсюда две жалобы: «не трегерит по времени» и «не дёргает
ИИ». По коду всё сходилось: повторов не было вовсе, а `checkTaskReminders` (main.js, раз в
минуту) только звал `notifyUser` и слал событие `task-reminder` — модель не просыпалась никогда.

### Что сделано

- **Повторы дел.** `repeat` у дела: `daily`, `weekdays`, `weekly`, `weekly:<день недели>`,
  `monthly`, `every:<минут>`. Разбор человеческий (`parseRepeat`): «каждый день», «по будням»,
  «каждую пятницу», «каждый месяц», «каждые 2 часа», «раз в неделю», «без повтора». Следующий
  срок считает `nextDueDate` (weekdays пропускает выходные, 31-е в коротком месяце = последний
  день). После срабатывания `advanceRepeat` сдвигает срок и сбрасывает напоминание.
- **Автозадачи будят агента.** Поле `auto` + `prompt` (что именно сделать). Раз в минуту
  `tasksTakeAuto` отдаёт дела, чей срок пришёл (`firedAt` не даёт запустить дважды), а main.js
  шлёт событие `task-due`. Окно поднимает агента в **отдельном чате «Автозадачи»** ролью
  Менеджер и кладёт ответ туда. Разовое дело после удачного прогона закрывается, повтор — уезжает
  на следующий срок.
- **Точный будильник.** `tasksNextDue` + `armTaskWake` ставят `setTimeout` ровно на ближайший
  срок (опрос раз в минуту остаётся страховкой на сон и перевод часов).
- **Тишина и очередь.** Автозадача не показывает тостов и не ждёт подтверждения; если в этот
  момент идёт другой прогон — встаёт в очередь и запускается сразу после него. Отсрочка
  (`snooze` у `taskUpdate`: «через час») глушит и напоминание, и автозапуск.
- **Галочка в настройках** «Автозадачи выполняет агент» (`taskAuto`, по умолчанию включена).
  Без неё дела только напоминают — токены не жгутся нечаянно.
- **Панель дел** показывает метку повтора (`🔁 каждую пятницу`) и автозапуска (`▶ агент`),
  `taskLine` — то же самое для модели. Роль «Менеджер» получила правила 9–11: как заводить
  повторы, как помечать дело на автозапуск, как отсрочить надоевшее.

### Ловушки, найденные по ходу

1. **`\w` в JS не матчит кириллицу.** Первый вариант разбора повторов был написан через
   `/кажд\w*\s*день/` — «каждый» не совпадал никогда, и `parseRepeat` молча отдавал ошибку
   на всех русских фразах. Заменено на `[а-я]` явно. Проверено прогоном по 15 фразам.
2. **Автозадачу нельзя выполнять с телефона.** `ai:event` транслируется всем клиентам моста,
   и телефон исполняет тот же `app.js`: событие срока запустилось бы дважды. Поэтому окно
   обрабатывает `task-due` только при `isElectron`, а событие уходит с `from: "desktop"`.
3. **Структурная проверка, которую удовлетворял комментарий.** Тест на `from: "desktop"` проходил
   даже после подмены на `mobile` — эту строку содержал и комментарий рядом. Проверка сужена до
   самой строки вызова; мутация теперь ловится.
4. **Отсрочка считается от настоящих часов**, а не от «сейчас» теста: `snooze` разбирается
   `parseDue(..., Date.now())`. В бою это верно, поэтому тест отсрочки берёт реальное время,
   а просроченные дела делает вчерашними.
5. **Общий путь прогона.** `sendMessage` и автозадача ходили бы двумя копиями логики (история,
   сессия, стрим, завершение) — вынесены в `runTurn(chat, content, opts)`; `sendMessage` стал
   тонкой обёрткой, автозадача идёт тем же путём.

### Проверки

| Набор | Результат |
|---|---|
| Структурные `npm test` | **410 ✅ / 0 ❌** (было 405; +5) |

Пять новых тестов: разбор/подпись/следующий срок повторов (включая переходы через выходные,
31-е в коротком месяце и `every:N`), срабатывание автозадачи по сроку с защитой от двойного
запуска и сдвигом повтора, отсрочка (глушит и тост, и автозапуск), расчёт ближайшего срока для
будильника, и связки в исходниках (main шлёт `task-due` с `from: "desktop"`, окно ограничено
ПК-клиентом, есть чат «Автозадачи», галочка и схемы инструментов).

**Проверки на сломанном коде:** шесть мутаций (снятый гвард «автозадачи не напоминают», снятая
защита от повторного запуска, не сдвигающийся повтор, сломанный разбор «каждый день», будильник
на прошедший срок, событие как «мобильное») — все шесть ловятся падением теста, код после
проверки возвращён из памяти (в репозитории незакоммиченные правки, `git checkout` не годится).

### Итог по версиям
`package.json` → **1.5.85**, OTA-набор → **1.5.90** (авто-бамп строго выше прошлого 1.5.89).
sha256 бандла сверен с диском, все 66 файлов — побайтово.

### Что осталось из плана
1. Роли: своя модель на роль — **пока не делаем** (решено оставить модель, выбранную человеком).
2. Автозадачи при закрытом приложении не работают: Electron закрыт — таймера нет. Срок
   отработается при следующем запуске (пропущенный повтор уезжает на следующий раз сам).


## 1.5.87 — локальный профиль: слабые модели и модели без инструментов

Задача ставилась с двух сторон: «представь, что ты в песочнице, но не DeepSeek V4 Flash, а
модель намного легче, в том числе без поддержки инструментов» и «почему у локальной модели
вообще лимит, она же бесплатная». Разбор дал цифры, а цифры — четыре настоящих дефекта.

### Что было не так (измерено, не на глаз)

1. **Роутер инструментов на локальной модели не работал НИКОГДА.** Бюджет `contextBudget("ollama")`
   возвращал 14 000 (наследие облачной экономии), а потолок веса схем считался как
   `budget - 12000` → `max(6 081, min(15 000, 2 000)) = 6 081` — ровно вес базы. То есть **ни одна**
   группа не помещалась: ни группы по задаче, ни группы активной роли, ни справочники группы.
   Прогнал все четыре роли на этом бюджете — у всех `groups: []`, 37 схем. Отдельно: «предохранитель A»
   печатал «добавляю группу … (схем станет 37)» (группа добавлялась, но тут же срезалась), а
   `findTools` отвечал «схемы уже добавлены в запрос».
2. **Модель без capability «tools».** Схемы уходили всё равно — часть сборок Ollama отвечает на них
   ошибкой, и раунд падал целиком. Предупреждение об этом жило только в «Консоли», то есть человек
   в чате видел «модель ничего не делает» без причины.
3. **Таймаут первого байта 90 с для всех провайдеров.** Локальная модель на CPU грузится и читает
   промпт минутами: обрыв на пустом месте.
4. **Сжатие контекста на локальной модели.** Запрос за памяткой уходил без `num_ctx` и без
   `keep_alive` → Ollama брала дефолт 2048 (памятка собиралась из обрезанного текста) и перезагружала
   модель; таймаут 30 с на генерацию в 700 слов на CPU нереален, а ошибка глоталась молча, причём
   попытка повторялась на каждом витке (счётчик сжатий не рос).
5. **`done_reason: "length"` игнорировался** — ответ, оборванный на полуслове, выглядел законченным.

### Что сделано

1. `windowBudget(provider, cloudBudget, window)` (context-window.js): у ollama потолок = окно − 4 096,
   но не выше `LOCAL_CTX_CAP` = 32 768 (KV-кэш 8B-модели ~4 ГБ — выше уже не ноутбук); окно неизвестно
   (сервер молчит) — прежние 14 000; окно меньше резерва — отдаём само окно. **Облачные потолки не
   тронуты**: проверил openai 8k → 4 096, 131k → 26 000, anthropic 80 000 — как было.
2. `routerMaxTokens(budget, systemWeight, baseWeight)` (agent-core.js) — формула потолка схем вынесена
   из main.js в чистую функцию, жёсткие 12 000 заменены на «системный промпт + MIN_HISTORY_TOKENS
   (1 500)». Это же и позволило тесту звать настоящую формулу, а не её копию.
3. **Модель без инструментов работает текстом.** Схемы не отправляются; в системное сообщение идут
   компактный каталог (`toolsAsText`: `имя(поля) — первая фраза описания`) и правило вызова
   JSON-блоком — формат, который уже разбирает `extractToolCallsFromText`. Каталог базы: 4 356
   символов ≈ **1 210 т.** против 6 081 т. JSON-схем; с браузерной группой 1 403 против 12 810.
   Вес инструментов в бюджете и в индикаторе считается по каталогу, когда схемы не уходят.
4. Таймауты для ollama: **300 с** на первый байт, **120 с** простой (облако — прежние 90/60).
5. Сжатие: в запрос за памяткой уходят `options.num_ctx` (`localCtx = ollamaNumCtx(budget, modelWin)`)
   и `keep_alive`; таймаут 300 с для локальной модели; отказ сервера больше не глотается — причина
   уходит в чат **один раз за прогон**.
6. `done_reason: "length"` → `onTruncated` → заметка в чате «ответ оборван лимитом вывода».
7. Честность сообщений: предупреждения «окно мало» и «нет capability tools» теперь и в чате, а не
   только в «Консоли»; «предохранитель A» сообщает результат (влезла ли группа), а не намерение;
   `findTools` говорит, что реально в наборе схем, и прямо называет те, что не поместились.

### Проверки

| Набор | Результат |
|---|---|
| Структурные `npm test` | **425 ✅ / 0 ❌** (было 419; +6) |
| Мутационная проверка | **8 из 8** ловится падением теста, код возвращён |

Шесть новых тестов: бюджет от окна (включая «окно неизвестно» и облачные потолки), роутер на
локальном окне (с воспроизведением прежнего дефекта на бюджете 14 000 и границей резерва на 22 000),
модель без инструментов (каталог, протокол, экономия против схем, исходные сообщения не портятся),
обрыв ответа по `done_reason`, отдельные таймауты для Ollama, сжатие локальной модели с `num_ctx`/
`keep_alive` и внятным провалом (один раз за прогон).

Мутации: окно игнорируется, потолок схем снова 12 000, схемы уходят без tools, пустой каталог,
обрыв не замечается, `num_ctx` не уходит, провал сжатия молчит, main.js перестал считать бюджет от окна.

### Осознанный размен

У модели без инструментов JSON-блок вызова **остаётся в переписке**: текст уже отправлен в стриме,
и вырезать его задним числом нечем. Это честнее молчания, но заметно; если помешает — прятать блок
в стриме так же, как `<think>`.

### Что осталось (не делалось)

1. `num_predict` / `temperature` для локальной модели не задаются: нет ограничения длины ответа
   и нет настроек поведения.
2. Локальная модель как **зрение** поддержана только «основной моделью» (в aux-путь идёт
   OpenAI-совместимый `/chat/completions`, Ollama нужен с `/v1` руками).
3. Системный промпт 6 390 т. для окна 4–8k всё ещё велик: нужен сжатый вариант промпта под узкие окна.
4. Нет прогрева модели при старте прогона (первый раунд платит загрузку весов).
5. Живого прогона против Ollama в песочнице нет (сервер не запущен) — проверки структурные.

### Итог по версиям

`package.json` → **1.5.87**, OTA-набор → **1.5.92** (авто-бамп строго выше прошлого 1.5.91).

## 1.5.88 — локальные серверы совместимого API: LM Studio, vLLM, llama.cpp

Продолжение 1.5.87. Там локальный профиль был привязан к имени семейства (`provider === "ollama"`),
и всё, что говорит на OpenAI-совместимом API, но живёт на своём ПК, попадало в облачные правила.
Разбор «а что такое локальные OpenAI-совместимые» показал цену этой привязки.

### Что было не так

1. **Бюджет как у платного облака.** Для qwen-подобного имени `contextBudget("openai")` = 26 000, и
   потолком был именно он. У LM Studio с окном 8k сервер получал запрос на 26k — то же самое, чем была
   опасна Ollama с дефолтными 2048, только теперь без `num_ctx` и без предупреждения.
2. **Окно почти никогда не читалось.** В `/v1/models` (openai-совместимо) окна обычно нет: LM Studio
   отдаёт его в `/api/v0/models`, llama.cpp — в `/props`, vLLM — полем `max_model_len`. Значит, признак
   «окно неизвестно» срабатывал почти всегда, и бюджет оставался облачным.
3. **Таймауты 90/60 с.** Сервер на CPU читает промпт минутами — обрыв на пустом месте.
4. **Схемы уходили всегда.** Спросить «умеет ли модель инструменты» у совместимого API негде, поэтому
   строгие сборки (и часть прокси вроде G4F) отвечали ошибкой на весь раунд.

### Что сделано

1. `isLocalBase(url)` вынесена в provider-config.js (одна проверка на два места: прокси веб-превью не
   заворачивает localhost, и агент по тому же признаку понимает «токены свои»). В ядре —
   `isLocalEndpoint(settings)`: Ollama локальна всегда (num_ctx/keep_alive — часть её протокола), для
   остальных признак считается **по адресу** (localhost, 127.0.0.1, 10.*, 192.168.*, 172.16–31.*).
2. `windowBudget(provider, cloudBudget, window, { local })`: у местного сервера потолок — память
   (`LOCAL_CTX_CAP` = 32 768), а не наш денежный бюджет. Облачные ветки проверены отдельно:
   26 000 / 50 000 / 80 000 — как было.
3. **Бюджет при неизвестном окне не срезан намеренно.** Соблазн был взять локальный дефолт 14 000, но
   это молча отняло бы историю у g4f и подобных местных прокси к большим моделям. Вместо угадывания
   окно теперь **спрашивается**: `/api/v0/models` (LM Studio: `max_context_length`), `/props`
   (llama.cpp: `n_ctx`; имя модели там — путь к .gguf, поэтому окно идёт «общим» на базу),
   `max_model_len` из `/models` (vLLM/TGI). Запросы идут **только** на локальные адреса: к чужому
   облачному серверу лишних проб нет. Кэш окна прежний — 10 минут на адрес.
4. Таймауты: `consumeProviderStream({ local })` → `localish = local || provider === "ollama"` → 300/120 с;
   сжатие контекста получает тот же признак (`createContextManager({ local })`) и свои 300 с.
5. **Текстовый протокол для любого сервера без инструментов.** `noTools` теперь понимают и ветки
   openai, и anthropic: схемы не уходят, в системный текст дописывается каталог
   (`textToolRule`). У Anthropic каталог дописан **в конец** системного текста — статичный префикс
   промпта остаётся началом, точка кэша не срывается. Спросить «умеет ли» у совместимого сервера негде,
   поэтому это **галочка** в настройках «Модель без поддержки инструментов» (`settings.noToolsModel`),
   а не догадка по имени модели.
6. `withTextTools` больше не ломает `content`-массив: у совместимых системное сообщение бывает
   массивом частей (текст + картинки), и превращение его в строку теряло картинки.
7. Интерфейс: галочка в настройках и подсказка под «Базовый URL» — какие локальные серверы сюда
   подключаются и что ключ им не нужен.

### Проверки

| Набор | Результат |
|---|---|
| Структурные `npm test` | **429 ✅ / 0 ❌** (было 425; +4) |
| Мутационная проверка | **12 из 12** ловится падением теста, код возвращён после каждой |

Новые тесты: признак локальности и потолок по адресу (плюс проверка, что **облачный** бюджет не поехал),
окно локального сервера тремя ручками (LM Studio, llama.cpp, vLLM) и отсутствие лишних проб к облаку,
`noTools` у совместимых (схем нет, каталог есть, префикс промпта Anthropic цел, картинка цела),
связка «галочка → настройки → протокол вызовов → сжатие».

Мутации: локальные таймауты снова только у Ollama · родные ручки не спрошены · схемы уходят без
инструментов · `content`-массив склеен в строку · каталог не доехал до Anthropic · потолок снова
облачный · сжатие в облачном таймауте · признак не дошёл до сжатия · галочка игнорируется · бюджет
посчитан как облачный · признак не считается · галочка пропала из настроек.

### Честные оговорки

1. **Живых серверов в песочнице нет** (ни LM Studio, ни llama.cpp, ни vLLM): пробы проверены против
   подставного `fetch`, который отвечает как эти серверы. Формат ответов взят по документации, а не по
   живому ответу.
2. `/props` у llama.cpp описывает **загруженный** контекст. Если на одном сервере поднято несколько
   моделей (не типичный случай), окно считается общим — это допущение, а не знание.
3. Для остальных местных сборок (KoboldCpp, Jan, LocalAI без `/props`) окно может остаться неизвестным —
   тогда бюджет облачный и переполнение ловит существующий повтор того же раунда с меньшим бюджетом.
4. G4F остался как был: это местный адрес, но прокси к облачным моделям, и «окно − 4 096» ему не нужно;
   поэтому общий бюджет не понижался.

## 1.5.89 — режим менеджера: миссия на 8 часов, файлы работы на ПК

Запрос звучал так: «реальный менеджер, который работает локально и, возможно, по несколько часов —
сделать так, чтобы он не отключался; и чтобы задачи и контекст агент сам складывал файлами на ПК».
Разбор кода показал, что «бац и перестал» — не капризы провайдера, а четыре независимые причины.

### Почему агент останавливался (найдено в коде, не на слух)

1. **Жёсткий потолок раундов.** `maxRounds = planMode ? 3 : 25` — на 26-м раунде прогон падал с fatal.
2. **Два сбоя — и всё.** `AUTO_RETRY_LIMIT = 2`: моргнувшая сеть на 20-й минуте заканчивала работу.
3. **Текстовый ответ = конец.** Продолжить агента заставляли только `planNudges` (макс. 2) и только при
   активном плане. Менеджер план часто не составляет — первое «осталось сделать то и то» было финалом.
4. **Состояния задачи на диске не было.** Упало приложение — работа потеряна, спасало только «продолжай».

### Что сделано

1. **Миссия — объект на диске** (`src/mission-store.js`): цель, план-шаги, состояние, метрики, лимиты,
   журнал (markdown для человека + jsonl для панели), отчёт. Всё в рабочей папке:
   `.agent/missions/<id>/mission.json · journal.md · journal.jsonl · report.md`. Рядом README.md и
   `.gitignore` со звёздочкой — рабочий журнал не попадает в коммиты (авто-коммит делает `git add -A`).
   Секреты маскируются тем же кодом, что дневник контекста (`redactSecrets`), поэтому случайный ключ из
   переписки не оседает в журнале.
2. **Работа идёт батчами.** `for (let batch = 1; ; batch++) { for (let round = 0; round < maxRounds; round++) … }`
   — 25 раундов на отрезок, затем `missionAfterBatch()`: жив ли контекст, не вышли ли лимиты (8 часов,
   600 раундов), не зациклился ли агент (один и тот же вызов 6+ раз), нет ли 12 раундов без нового шага.
   Дальше — новый отрезок с тем же контекстом и коротким напоминанием о миссии.
3. **Миссия заводится сама** на 6-м раунде работы, если агент её не завёл (цель берётся из просьбы), и
   подхватывается с диска при следующем запуске (`▶ Продолжаю миссию: …`).
4. **Сбои больше не обрывают долгую работу:** пока миссия жива, приложение ждёт и продолжает —
   `longWorkAutoContinue` раз (по умолчанию 6), с записью причины в журнал.
5. **Стопы стали мягкими:** лимит раундов/времени, зацикливание и отсутствие прогресса ставят миссию на
   паузу с объяснением и сохранением файлов, а не выбрасывают ошибку в чат. **Закрытая миссия** теперь
   завершает прогон обычным финалом — раньше на границе батча она рвала работу грозным «превышено число
   раундов», что и выглядело как «агент ни с того ни с сего отвалился».
6. **Инструменты `missionStart / missionStep / missionStatus / missionFinish`** (группа «дела», права
   `mission.read` / `mission.write`), правила в системном промпте и в роли «Менеджер».
7. **Панель «Миссия»** (рельса + вкладка): цель, полоса прогресса, счётчики времени/раундов/шагов, список
   шагов, живой журнал, кнопки «Пауза / Продолжить / Стоп / Открыть папку», список прошлых миссий.
   Продолжение идёт тем же путём, что «продолжай» — прогон с текстом миссии и хвостом журнала.
8. **Файлы работы рядом с проектом.** Раньше зеркала были привязаны к «долгой работе», а памятки — ещё и
   к галочке «Память диалогов» (это про другое: про поиск по дням внутри приложения). Теперь у них своя
   галочка **`.agent/` — файлы работы агента** (по умолчанию включена): `.agent/tasks.md` (список дел),
   `.agent/context/<дата>.md` (памятки контекста), `.agent/missions/`. В настройках — состояние папки
   (что уже лежит, сколько миссий, размер), «Открыть папку» и «Очистить зеркала» (миссии не трогает).

### Цифры и проверки

- Полный `npm test`: **438 прошло, 0 упало** (+9 новых тестов миссий: файлы, шаги, журнал, секреты,
  отчёт, зеркала и их очистка, движок батчей, панель/настройки/IPC/мост).
- **Мутационная проверка, 8 из 8 реальных мутаций пойманы**: зеркало дел привязано к «долгой работе»,
  зеркало контекста не пишется, `agentWorkFiles` по умолчанию выключен, `afterBatch.closed` убран,
  авто-продолжение выключено, `redactSecrets` убран, очистка зеркал сносит миссии, шаг «выполнено» не
  отмечается. Девятый случай — намеренный no-op (контрольный): он и не должен ронять тесты.
- Версия **1.5.89**, OTA-бандл **1.5.94**, 67 файлов сверены побайтово (расхождений 0).

### Честно

- Долгая работа проверена структурно и на модуле миссий; **живого восьмичасового прогона в песочнице не
  было** — батчи, лимиты и авто-продолжение проверяются кодом, а не часами работы.
- Верхняя граница «миссии» — 600 раундов и 8 часов по умолчанию; после паузы продолжает кнопка, а не
  время (расписание — следующий шаг, речь про него шла отдельно).
## 1.5.90 — одна навигация: разделы переключает рельса, шапка — про чат

Замечание было прямое: «интерфейс дублируется — слева панель и справа сверху». Так и было: один
и тот же набор разделов переключался из трёх мест — иконки на рельсе слева, такие же иконки в шапке
справа и вкладки внутри самой панели.

### Вторая половина проблемы — не косметика

`openSidePanel` включал подсветку **всем трём** кнопкам шапки сразу: `btn-toggle-console`,
`btn-toggle-preview` и `btn-toggle-cloud` получали `active` одной пачкой, независимо от открытого
раздела. `syncRail` переносил это на рельсу — то есть при открытой консоли подсвеченными выглядели
ещё «Превью» и «Облако». Теперь подсветка считается из активного раздела в одном месте.

### Что сделано

1. **Одна навигация — рельса.** Иконки разделов в шапке помечены классом `hdr-dupe` и скрыты на
   широком экране; показываются только на телефоне (там рельса скрыта).
2. **Вкладки внутри панели** (`sp-switch`) тоже скрыты на широком экране — они дублировали рельсу.
   Вместо них в шапке панели **название раздела** (`#sp-title` из `SP_TITLES`), которое меняется при
   переключении. На телефоне вкладки возвращаются, а название убирается.
3. **Подсветка ровно одна** — `markPanelButtons()`: снимает `active` со всех кнопок шапки, ставит его
   кнопке активного раздела и синхронизирует рельсу. И открытие, и закрытие панели идут через неё —
   одна точка вместо двух списков.
4. **В шапке остаются действия чата:** модель и «скопировать чат». Кнопки-дубли по-прежнему в
   разметке (рельса нажимает именно их), поэтому связка `proxy(...)` не изменилась.
5. **Композер собран плотнее.** Все кнопки одной высоты (30px), скругление 9px, зазор 6px, прижаты
   вправо; отправка и стоп — 34px (главное действие чуть крупнее). Подпись «📋 План-режим» → «📋 План»,
   подсказка укорочена до «Enter — отправить · Shift+Enter — новая строка» и на телефоне скрыта.
   Шапка на телефоне тоже плотнее: иконки 34px, зазор 5px.

### Проверки

- Полный `npm test`: **441 прошло, 0 упало** (+3 новых теста: разметка и скрытие дублей, живая логика
  подсветки на игрушечном DOM, геометрия композера).
- **Мутационная проверка, 13 из 13 пойманы**: снята метка дубля, отменён возврат иконок на телефоне,
  вкладки снова видны на широком экране, `markPanelButtons` убран из `openSidePanel`, подсветка снова
  зажигает все кнопки шапки, название раздела не обновляется, высота кнопок композера разная, вернулась
  подсказка на телефоне, длинная подпись режима плана. Ещё четыре мутации проверяют не «есть ли правило»,
  а место в каскаде: продублированное базовое правило, мобильные правила, уехавшие до базовых, и поздняя
  таблица стилей, вернувшая вкладкам видимость. Все пойманы. Каждая мутация откатывалась, код после
  проверки — как был.
- Версия **1.5.90**, OTA-бандл **1.5.95**, все файлы сверены побайтово.

### Честно

- Проверено статикой, `node --check` и тестами. **Живую проверку в браузере прогнать не удалось:**
  Chromium в песочнице не запускается (`libglib-2.0.so.0` отсутствует), поэтому пиксельного результата
  (как выглядит переход при ширине 901px, как ведёт себя панель при перетаскивании) я не видел —
  проверены правила, их порядок в каскаде и логика подсветки.
- Осознанный размен: на широком экране, чтобы переключить раздел, надо вести мышь к рельсе слева.
  Взамен — один список разделов вместо трёх и честная подсветка.
## 1.5.91 — клик по полю больше не теряется: охрана полей ввода

Жалоба: «нажимаю на поле — курсор не встаёт, текст не печатается; через какое-то время само
отпускает, и снова можно писать». Уточнение от пользователя сняло половину версий: окно не
замирает, приглашение агента не висит, в чат «Автозадачи» не перекидывает — именно клик по полю
не даёт фокуса. И это было задолго до автозадач и долгой работы, то есть не про них.

### Что смотрел

Прошёл всю цепочку, которую запускает дело со сроком: `checkTaskReminders` (раз в минуту,
`main.js`) → `emitTasksChanged` → `tasks:changed` → `renderTasks`; напоминание → `ai:event
task-reminder` → тост; срок автозадачи → `task-due` → прогон агента в чате «Автозадачи» с
`selectChat` и `streaming` на весь прогон. Плюс разметку и каскад стилей: кто вообще может лежать
поверх поля.

### Что нашёл (по убыванию вероятности)

1. **Тосты.** `toast()` создаёт плашку `position: fixed; z-index: 200` в `document.body` и убирает
   её через 2600 мс. У плашки не было ни `pointer-events: none`, ни ограничения ширины:
   - клик по полю в её полосе (`bottom: 90px`) доставался плашке, а не полю — «кликаю, а оно не
     работает»;
   - длинный текст растягивал плашку на всю ширину окна (перенос не задан), и перехват доставал
     любой элемент интерфейса в этой полосе, включая строки дел;
   - «само отпускает» — это ровно 2.6 секунды жизни тоста.
   По времени у пользователя как раз после срабатывания дела (напоминание о сроке, просрочка).
2. **`pointer-events: none` на предке поля.** Ровно на этом когда-то ломался композер
   (`#welcome` перехватывал клики, 1.5.36). Второй раз такое ловится глазами, а не кодом: поле
   выглядит живым, но клики сквозь него проходят вниз.
3. **Прозрачный слой-обёртка над полем** (пустой оверлей, блок без фона) — то же самое, но без
   участия `pointer-events`.

### Что сделано

`src/renderer/field-guard.js` — правило: **клик, который целился в поле, обязан попасть в поле.**

- `stolenFieldClick(target, stack)` — если клик получил неинтерактивный слой, а под точкой лежит
  настоящее поле (`document.elementsFromPoint`), отдаём фокус полю и называем виновника;
- `deadField(target, styleOf)` — если у поля или у предка `pointer-events: none`, фокусируем поле
  руками (фокус работает и так) и указываем **самый верхний** слой с этим правилом: у
  `pointer-events` наследование, поэтому причина всегда последняя «none» вверх по дереву;
- клик, который перехвачен и вернул фокус, гасится (`preventDefault` + `stopPropagation`): под полем
  не должно сработать чужое действие, на которое человек не нажимал;
- отчёт виден: `console.warn` + тост через `window.uiToast` (его уже выставляет app.js) и не чаще
  одного раза в 5 секунд;
- живое не трогается: клик по кнопке, ссылке, окну/меню/попапу, по самому полю, правая кнопка и уже
  погашенный клик — охрана молчит.

Подключение: тег `<script src="field-guard.js">` в `index.html` **перед** `app.js` и (страховкой)
загрузчик в крошечном `src/renderer/bootstrap.js`. Дубль нарочный: `index.html` — на 117 КБ, правки
больших файлов инструментами на нём срываются, а загрузчик в `bootstrap.js` всегда доезжает.
Повторная загрузка безопасна: модуль ставит защиту один раз (`root.__fieldGuardInstalled`), лишний
тег не добавляется, если скрипт уже есть в разметке.

### Проверки

- `npm test`: **441 прошло, 0 упало** (прежний набор) + новый `test/field-guard.test.js`
  (**5 прошло**): подключение перед `app.js`, перехват тостом возвращает фокус и называет виновника,
  живой клик (кнопка, кнопка поверх поля, окно, само поле, правая кнопка) не перехватывается,
  `pointer-events: none` на предке оживает с верным виновником, рассказ не спамит.
- **Мутационная проверка, 6 из 6 пойманы**: убран `preventDefault`; отключена защита кнопок;
  отключена защита окон поверх; виновником названо поле вместо слоя; снят предохранитель частоты
  рассказа; из имени виновника убраны классы. Каждая мутация откачена, код после проверки — как был.
- `node --check` на `field-guard.js` и `bootstrap.js`; версия **1.5.91**.

### Честно

- Живого прогона в окне нет: Chromium в песочнице не поднимается, окно Electron — тоже. Проверено
  статикой, тестами на игрушечном DOM и мутациями, а не глазами на экране.
- Сам `toast()` в `app.js` не правил: файл на 406 КБ, правка инструментом на нём не проходит
  (сорвалась трижды), а лезть в него наугад sed'ом — риск сломать больше, чем починить. Охрана
  закрывает последствие (клик всё равно попадает в поле) и называет виновника. Убрать у тоста
  перехват насовсем (одна строка `pointerEvents: "none"`) — следующим шагом, когда правка app.js
  снова станет доступной.
- `renderMessages()` всё ещё забирает фокус в композер, если активный чат пуст (`inp.focus()` в
  rAF) — это другой сценарий, к делу со сроком не относится, и трогать его вслепую не стал.
- Автозадача по-прежнему уводит окно в чат «Автозадачи» и держит `streaming` на весь прогон
  (`runAutoTask` → `selectChat`). Это отдельная жалоба (её здесь не чинили).

## 1.5.92 — поле возвращает фокус само: свидетель фокуса вместо догадок

Жалоба, с которой пришли: «кликаю по полю — курсор не встаёт, текст не печатается; через какое-то
время само отпускает», при этом охрана из 1.5.91 **молчит**. Значит, ловить надо было не слой, а сам
фокус: слой поверх поля — только один из шести механизмов, и он единственный, который видно в DOM.

### Почему молчала охрана 1.5.91

Она умела ровно одно: заметить чужой слой над полем (`elementsFromPoint`) и `pointer-events: none`
у предка. Клик по полю может не дать фокуса и совсем иначе:

1. слой поверх поля ест клик (тост, прозрачная обёртка);
2. `pointer-events: none` у поля или предка — клик проходит сквозь;
3. фокус у поля забрал кто-то другой: обработчик клика или **перерисовка по таймеру** — в этом
   окне так целиком перерисовываются список дел (`renderTasks`), план и журнал миссии
   (`missionTickStart`, 1 с), лента чата (`renderMessages`);
4. поле перерисовали сразу после клика — узел исчез вместе с фокусом;
5. окно приложения потеряло фокус (Electron): в DOM всё «правильно», но каретка не мигает и
   клавиши уходят в другое окно;
6. плашка-уведомление лежит над полем и ест клик ровно 2.6 с своей жизни (`toast()` в `app.js`).

Пункт 6 из прошлой версии остался незакрытым: `toast()` живёт в `app.js` (406 КБ), и правка
инструментом туда не проходит. Поэтому декор теперь нейтрализуется **из охраны**, а не правкой тоста.

### Что сделано

`src/renderer/field-guard.js` (v2, «охрана живого интерфейса»):

- **Свидетель фокуса** (`hookFocus`, `makeTrace`, `stolenFocus`): перехват
  `HTMLElement.prototype.focus/blur` (ставится один раз), кольцо последних 40 вызовов со стеком
  (до 4 кадров, свои кадры скрыты). После каждого клика по полю — проверка через `setTimeout(0)`
  и через 150 мс: фокус там? Если нет, охрана возвращает фокус полю и называет виновника
  **вместе со стеком вызова** — видно, какая строка кода его забрала.
- **Окно приложения**: `document.hasFocus()` отличает «виноват DOM» от «виновато окно». Во втором
  случае охрана зовёт `window.focus()` (внутри клика это разрешено) и не трогает поле.
- **Декор не ест клики** (`isDecoration`, `applyClickThrough`): плашка, добавленная поверх
  интерфейса, у которой нет ни кнопок, ни полей, `position: fixed/absolute`, не выше 160 px и не
  больше 30 % площади, без имён `overlay/backdrop/scrim/gate/modal/dialog/popup/menu/pallet|
  panel/popover` — становится `pointer-events: none` (+ `user-select: none`, ограничена ширина).
  Наблюдение через `MutationObserver` плюс разовый обход `body`. Окна, меню, подложки и всё, внутри
  чего есть живой элемент, не трогаем: они клики обязаны получать.
- **Залипший режим перетаскивания** (`clearStuckDrag`): ресайзеры панелей включают
  `body.resizing` / `body.resizing-x` на `mousedown` и снимают на `mouseup` документа. Отпустили
  кнопку за окном — `mouseup` не пришёл, и класс оставался навсегда (курсор col-resize и
  `user-select: none` во всём приложении). Теперь снимается на `mousedown`, `mouseup`, `pointerup`
  и потере фокуса окном.
- **Охрана не тянет фокус назад**: проверка отменяется на любом нажатии клавиши и на новом клике.
- Экспорт `focusReport()` (и `window.__focusLog`): если глюк повторится, в консоли `focusReport()`
  покажет, кто и какой строкой кода забирал фокус.

Заодно, по ходу проверок:

- `app.js`: `renderMessages()` больше не забирает фокус в композер, если человек печатает в другом
  поле (`inp.focus()` в rAF выполняется только когда активного элемента нет). Правка прошла — она в
  начале файла, куда инструмент достаёт.
- `mobile-api.js`: добавлены `tasksAutoAck` / `tasksAutoRearm` — тест «мобильная копия покрывает все
  методы интерфейса» падал (методы появились в `preload.js` раньше, а в мобильной копии — нет).
- `test/smoke.test.js`: тест повтора приведён к двухшаговой схеме выдачи автозадачи. Он закреплял
  **старую поломку** — «повтор двигается сразу при запуске», из-за чего сорвавшийся прогон увозил
  расписание и дело молчало до следующего дня. Теперь проверяется обратное: до подтверждения окна
  срок на месте, отказ не двигает расписание и назначает повторную попытку, подтверждение сдвигает
  срок строго вперёд с тем же временем суток.
- `agent-store.js`: комментарий к `tasksTakeAuto` приведён в соответствие с двухшаговой выдачей.
- Удалены временные файлы прошлого захода: `.tmp-patch-tests.js` (в нём был синтаксически битый
  патчер — потому он и не применился) и `scripts/probe-focus.js`.

### Проверки

- `npm test`: **441 прошло, 0 упало** (smoke) + **13 прошло, 0 упало** (`test/field-guard.test.js`,
  было 5): перехват слоем, `pointer-events: none`, свидетель фокуса (вор + стек), потеря фокуса
  окном, отмена проверки клавишей, точный матчер кнопки/поля, декор-решения, подписка на новые
  узлы, снятие залипшего режима.
- **Мутационная проверка: 8 из 8 пойманных.** Убраны: разбор потери фокуса окном; проверка позиции
  декора; возврат `pointer-events: none` плашке; отмена проверки по клавише; снятие залипшего
  режима; проверка «поле исчезло (перерисовка)»; лечение (возврат фокуса); взятие виновника со
  стеком из свидетеля. Каждая мутация откачена, файл после проверки сверен по `sha256`.
- `node --check` на изменённых файлах; версия **1.5.92**, OTA-бандл пересобран.

### Честно

- Живого прогона в окне по-прежнему нет: Chromium в песочнице не поднимается (нет `libglib-2.0.so.0`
  и Xvfb), окно Electron — тоже. Всё проверено статикой, тестами на игрушечном DOM и мутациями.
- Флаг однократной установки охраны (`__fieldGuardInstalled` в `autoInstall`) тестами не покрыт:
  в Node нет `document`, поэтому проверяется только живой загрузкой страницы.
- Инструмент правки инструментами работает только с началом больших файлов: `app.js` (406 КБ) —
  примерно до первых 2000 строк; глубокие места (тост, ресайзеры, drag&drop) инструментом не
  правятся, а правка молча не применяется. Большие файлы менялись патчером с проверкой «ровно одно
  вхождение» и последующей сверкой (`node --check` + прогон тестов).
- Тосты гасит охрана; собственную строку `pointerEvents: "none"` в `toast()` можно внести позже,
  когда появится способ править хвост `app.js`.

## 1.5.93 — справочник ВК: отправка сообщения, выгрузка диалогов, роли

Запрос: «добавь гайд для менеджера и ассистента, чтобы когда работаю с ВК они знали, что правильно
делать». Гайд по ВК в проекте уже был (`src/agent-guides/vk.md`), но в главном месте он врал.

### Что было не так

Раздел отправки сообщения учил такому: `browserFill` + `browserPress { key: "Enter" }`. В живом ВК
это не отправка: поле сообщений — `contenteditable`, поэтому Enter вставляет перенос строки, а
`submit: true` рапортует об отправке, оставляя текст залипшим в поле. Плюс:

- кнопку отправки искали по подписи «Отправить» в карте DOM, хотя есть стабильный селектор;
- отправку подтверждали прокруткой истории, а история в ВК виртуальная — «сообщения нет в DOM»
  ≠ «не отправлено»;
- в справочнике не было строки `<!-- sites: … -->`, поэтому по адресу `vk.com` он не подхватывался
  автоматически: агент должен был вспомнить и прочитать его сам;
- у роли «Менеджер» не было группы `browser` — то есть роль физически не могла открыть ВК, даже
  если бы знала гайд.

### Что сделано

- **`src/agent-guides/vk.md` переписан** по проверенному маршруту: правило нуля (перед действием
  `browserText` — сессия жива?), вход через менеджер паролей (`vaultList`/`vaultFill`) или руками
  человека, отправка РОВНО четырьмя шагами (`browserOpen` → `browserFill` в `[role=textbox]` БЕЗ
  `submit` → `browserClick` по `.ConvoComposer__sendButton--submit` → проверка пустым полем через
  `browserEval`), таблица «чего НЕ делать» (`submit: true`, Enter, `browserAct`, поиск кнопки по
  подписи), подтверждение отправки, виртуализация списка и истории, replay `messages.getItems`
  (`v=5.285` из перехвата, `start_from=conversations_<id>`, `last_item`, стоп по `total_count`) и
  `messages.getHistory`, баги инструментов (IIFE в `browserEval`, поллинг в `browserNetwork`,
  перезагрузка вкладки → `save: true`) и известный контекст переписок.
- **В шапку добавлена строка `<!-- sites: vk.com, vk.ru, m.vk.com -->`** — теперь при `browserOpen`
  на адрес ВК приложение само говорит: «есть справочник, прочитай перед действиями».
- **Роли**: «Ассистент» и «Менеджер» получили пункты про ВК со ссылкой на `agentGuide { name: "vk" }`
  и напоминанием про четыре шага; **у «Менеджера» появились группы `browser` и `vault`** — без них
  переписка с клиентами была невозможна в принципе. Плюс предохранитель: без просьбы человека агент
  в переписке не отвечает, а непришедший ответ превращает в дело со сроком.
- **`test/vk-guide.test.js`** (8 проверок): подхват по адресу, четыре шага и запреты, подтверждение
  пустым полем, «нет в DOM ≠ не отправлено», виртуализация и replay, сессия/пароли/баги инструментов,
  читаемость гайда и знание его обеими ролями. Файл добавлен в `npm test`.

### Проверки

- `npm test`: **441 / 13 / 8**, все три набора без падений.
- **Мутационная проверка, 6 из 6 пойманы**: гайд снова разрешает `submit`; убрана строка `sites`
  (гайд не подхватывается); убран селектор кнопки отправки; у «Менеджера» отнята группа `browser`;
  из промпта менеджера убран справочник ВК; (первая попытка с селектором пропустила подмену, потому
  что `String.replace` меняет только первое вхождение — перепроверено заменой всех).
- Версия **1.5.93**, OTA-бандл пересобран; `src/agent-guides/*.md` входят в бандл, значит гайд
  доедет до приложения вместе с обновлением.

### Честно

- Гайд — текст, а не код: он не заставляет модель действовать правильно, он лишь снимает
  двусмысленность. Проверяемая часть (маршрут, селекторы, подтверждение, знание ролями) закрыта
  тестами; качество самого ответа модели тестами не измеряется.
- В справочник не добавлены живые проверки сессии ВК: у проекта нет доступа к аккаунту из тестов,
  поэтому «сессия жива?» остаётся инструкцией для агента.

## 1.5.94 — телефон подключается по QR-коду (и мост отдаёт все файлы страницы)

### Зачем

Мобильный доступ был уже готов (мост по локальной сети + PIN), но подключаться приходилось вручную:
найти IP ПК, набрать `http://192.168.1.42:9090` в браузере телефона, потом шесть цифр PIN. На практике
это самая частая причина «телефон не подключается»: адрес вводится с ошибкой, а PIN диктуется с экрана ПК.
Теперь в Настройках → «Мобильный доступ» есть QR-код: навёл камеру — приложение открылось на телефоне
и подключилось само.

### Что сделано

- **`src/renderer/qr.js` — свой кодировщик QR без зависимостей.** Внешний пакет пришлось бы тянуть
  через `npm install`, а это ломает OTA-обновление (бандл везёт файлы, а не `node_modules`). Поэтому
  реализованы байтовый режим, уровни L/M/Q/H, версии 1–10, таблица блоков, Рид—Соломон, раскладка,
  маски и форматная информация — по ISO/IEC 18004. Файл подключён в `index.html` перед `app.js`.
- **Экран ПК (Настройки → «Мобильный доступ»).** QR строится по адресу моста и текущему PIN:
  `http://<IP>:<порт>/#pin=<PIN>`. Код остаётся светлым (белое поле, тёмные модули) даже в тёмной теме —
  на тёмном фоне камера код не находит. Показывается только когда мост включён и запущен.
- **Телефон (`mobile-api.js`).** PIN читается из адреса (`#pin=`, `#p=`, `?pin=`) и сразу уходит на ПК при
  открытии сокета — окно ввода не появляется. Сам PIN из адресной строки вырезается (`history.replaceState`),
  чтобы не осесть в истории браузера и на скриншотах.
- **Устаревший PIN.** Если на ПК PIN сменили, а телефон открыл старую ссылку, `auth_err` раньше мог прийти
  при ещё не построенном окне ввода: на экране оставался пустой фон без объяснений. Теперь окно строится
  принудительно, поле очищается и показывается «Неверный PIN. Попробуй ещё раз».
- **Найдена и исправлена настоящая поломка мобильного доступа.** Мост отдаёт телефону только файлы из
  `STATIC_FILES`, и в списке не было ни `qr.js`, ни `field-guard.js` (охрана полей на телефоне просто не
  загружалась), ни `yc-console.js/.css`, ни `deploy-panel.js/.css` — панели Yandex Cloud и деплоя получали 404.
  Это нашёл новый тест: он сверяет список моста со всеми `<script src>` и `<link href>` из разметки.

### Проверки

- `test/qr.test.js` (7 проверок): **64 вектора** сверены бит в бит с эталонной реализацией
  (qrcode-generator, Кадзухико Арасэ) — версии 1, 2, 3, 4, 5, 6, 7, 9, 10, все четыре уровня коррекции,
  включая полную загрузку ёмкости; форматная информация читается на месте и совпадает в двух копиях и
  проходит BCH-проверку; номер версии для v7+; ищем-паттерны, разделители, синхронизация, «тёмный модуль»;
  ёмкости совпадают с опубликованной таблицей (v1: L17 M14 Q11 H7 … v10: L271 M213 Q151 H119);
  переполнение даёт внятную ошибку, а не битый код; SVG рисует ровно все тёмные модули и учитывает тихую зону.
- `test/mobile-pair.test.js` (7 проверок): скрипт телефона загружается в песочнице с игрушечным окном и
  WebSocket — PIN из адреса уходит сам, окна ввода нет; PIN вырезается из адресной строки; без PIN всё как
  раньше; устаревший PIN показывает окно и ошибку; ссылка ПК и разбор на телефоне — один формат; список
  файлов моста покрывает все ресурсы страницы.
- `npm test`: smoke **441 / 0**, field-guard **13 / 0**, VK **8 / 0**, QR **7 / 0**, mobile-pair **7 / 0**.
- Версия **1.5.94**, OTA-бандл пересобран; `qr.js` входит в бандл.

### Честно

- Живого прогона «навёл камеру телефона» в песочнице нет: ни телефона, ни камеры. Проверено то, что
  проверяется кодом — матрица кода, маршрут PIN, выдача файлов мостом.
- Ёмкость кодировщика ограничена версией 10: для ссылки вида `http://192.168.x.x:9090/#pin=000000`
  этого с запасом, но произвольный длинный текст в код не влезет — тогда будет понятная ошибка, а не
  нечитаемый код.
## Чистка репозитория — снесён мёртвый Flutter-прототип

В репозитории лежал второй, заброшенный прототип того же приложения на Flutter: `pubspec.yaml`,
`lib/` (14 Dart-файлов), папки `android/ ios/ macos/ linux/ windows/` и Flutter-тест
`test/widget_test.dart` — **133 файла, ~1 МБ**. Он не попадал ни в сборку (electron-builder берёт только
`src/**`, `assets/**`, `package.json`, `server.js`), ни в OTA-бандл (69 файлов, ни одного Dart),
ни в тесты. Живое приложение — Electron (`src/bootstrap.js`, `bun run dist:win`).

**Почему снесён, а не оставлен «на всякий случай».** Единственный коммит, который его трогал, —
`b2356a3` от 2026-09-07 («Initial commit»); все версии 1.5.x шли мимо него. При этом он выглядел как
живое приложение и вредил: детектор dev-серверов в `src/main.js` ловил `flutter run`, поиск по проекту
подхватывал `.dart_tool`, а разбор проекта каждый раз начинался с вопроса «почему два приложения».

**Удалено:** `lib/`, `android/`, `ios/`, `macos/`, `linux/`, `windows/`, `pubspec.yaml`, `pubspec.lock`,
`analysis_options.yaml`, `.metadata`, `test/widget_test.dart`. Из `.gitignore` убраны только правила
прототипа (`.dart_tool/`, `.flutter-plugins`, `.flutter-plugins-dependencies`) — общие правила IDE
(`.idea/`, `*.iml`), сборки и OTA-бандла не тронуты.

**Чего НЕ трогали нарочно.** Поддержка Dart в самом агенте — это работа с чужими проектами, а не наш
прототип: `.dart` в подсветке и списке расширений, `flutter run` в детекторе dev-серверов, `.dart_tool`
и `.flutter-plugins` в списке игнора обхода файлов (всё — `src/main.js`). Удаление этих строк отняло бы
у агента работу с чужими Flutter-проектами.

### Проверки

- `test/repo-shape.test.js` (7 проверок, в `npm test`): корневых файлов прототипа нет; платформенных
  папок нет; ни одного `dart/swift/kt/pbxproj`-исходника и нет `test/widget_test.dart`; в `.gitignore`
  нет правил прототипа, но общие правила IDE и коммит OTA-бандла на месте; живая точка входа Electron
  (`src/bootstrap.js` из `package.json`), разметка, `server.js` и `electron-builder.yml` — на месте;
  **ни один живой файл** не ссылается на пути прототипа; в OTA-бандле нет файлов прототипа.
- **Мутации: 7 из 7 пойманы** (вернули `pubspec.yaml`; вернули папку `android/`; вернули
  `test/widget_test.dart`; вернули `.dart_tool/` в `.gitignore`; снесли `src/main.js`; добавили ссылку
  на `pubspec` в `server.js`; положили `lib/main.dart` в OTA-бандл). Всё откачено.
- `npm test` после удаления: smoke **441 / 0**, field-guard **13 / 0**, VK **8 / 0**, QR **7 / 0**,
  mobile-pair **7 / 0**, repo-shape **7 / 0**.
- Версия **не менялась** (1.5.94), OTA-бандл **не пересобирался**: ни один файл, уезжающий к людям,
  не изменён — удалены только те, что никогда в бандл не попадали.

### Честно

- Восстановить удалённое можно из истории: `git checkout b2356a3 -- lib pubspec.yaml` и остальные пути
  из того же коммита (переписывания истории не было, коммит на месте).
- Живого прогона Electron в песочнице нет; проверено статикой, тестами и сверкой списка файлов сборки
  и OTA-бандла (в заметках выше раздел 1.5.94 — он остаётся последним по версии).
## 1.5.95 — свидетель фокуса больше не путает «до» и «после»: порядок вызовов вместо миллисекунд

Разобрана гонка, из-за которой тест свидетеля фокуса падал примерно раз из четырёх полных
прогонов (один раз она всплыла при уборке Flutter-прототипа). Это оказалась не проблема теста,
а **настоящая ошибка охраны**: виновник кражи фокуса выбирался сравнением времени (`Date.now()`),
а не порядка вызовов.

**Как было.** Клик по полю брал метку времени (`pending.at = Date.now()`), а свидетель фокуса
(`makeTrace`) хранил вызовы `focus()` с той же меткой и функцию `lastAfter(at, notEl)` с условием
`it.at < at → пропустить`. Всё, что попало в **ту же миллисекунду**, считалось «после клика».

**Чем это плохо в бою.** Тот, кто звал фокус ДО клика (прошлый жест, чужой обработчик, перерисовка
соседней панели), попадал в отчёт виновником — с ЧУЖИМ стеком вызова, то есть человек получал тост
с именем и строкой кода, которые ни в чём не виноваты. Проба на 3000 прогонов до правки:

| Сценарий | Результат до правки | После правки |
|---|---|---|
| вор забрал фокус ПОСЛЕ клика — назван с именем и стеком | 3000 / 3000 | 3000 / 3000 |
| фокус звали ДО клика — ошибочно назван виновником | **2996 / 3000** | **0 / 3000** |

**Почему тест при этом был зелёным.** Он сам ставил сцену наоборот: свидетель вызывал фокус вора
ПЕРЕД кликом и ждал, что виновника назовут. Это проходило, только если оба вызова укладывались в
одну миллисекунду. Измеренное окно от `focus()` вора до метки клика — **18–19 мкс** в покое и
**28–41 мкс** на холодном коде, то есть вероятность падения ≈ **1,8 %** на прогон, на холодную ≈ 3–4 %,
под нагрузкой выше (на загруженной машине миллисекунда переключается внутри окна чаще).

**Что сделано.**

- `makeTrace` ведёт **номер вызова** (`seq`) и отдаёт метку `trace.mark()`; `lastAfter(mark, notEl)`
  сравнивает порядок вызовов. Клик берёт метку (`pending.mark`), а виновник — первый, кто звал фокус
  ПОСЛЕ неё. Время в отчёте осталось (`at`) — оно нужно человеку в `focusReport()`, но решает не оно.
- Часы подменяемы вторым аргументом (`makeTrace(limit, now)`) — тестам это нужно, чтобы проверить
  порядок независимо от времени, с настоящими часами два вызова подряд почти всегда в одну
  миллисекунду, и проверка была бы случайной.

**Проверки.**

- `test/field-guard.test.js`: **15 проверок** (было 13), новые:
  - «виновника выбирает порядок вызовов, а не часы» — часы свидетеля идут НАЗАД (5000, 4000);
    правильный виновник обязан быть выбран по порядку, и в записях должно быть видно подменённые
    часы (без этой сверки мутация «часы игнорируются» проходила незамеченной);
  - «фокус, взятый ДО клика, виновником не считается» — часы заморожены (оба вызова в одну
    «миллисекунду», как на быстрой машине): в отчёте не должно быть стека и чужого имени;
  - старый тест переписан на реальную сцену: клик → вор забирает фокус после него → проверка.
- **Мутации: 5 из 5 пойманы** (вернуть сравнение по миллисекундам; сдвинуть метку клика на один
  вызов; игнорировать подменяемые часы; не увеличивать `seq`; вернуть в тесте старого «вора до
  клика»). Всё откачено.
- Проба на 3000 прогонов в двух сценариях: **0 и 0** (до правки — 0 и 2996).
- `npm test` — **четыре полных прогона подряд**: smoke 441/0, field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 7/0.
- Версия **1.5.95**, OTA-бандл **1.5.101** (69 файлов); `field-guard.js` в бандле побайтово совпадает
  с диском.

**Честно.** Живого прогона в окне нет — Chromium и Electron в песочнице не поднимаются. Проверено
статикой, тестами на игрушечном DOM, подменяемыми часами, мутациями и пробой на 3000 прогонов.
Остальная логика охраны не менялась: лечение (возврат фокуса), тост с виновником и предохранители
(кнопки, окна, печать с клавиатуры) работают как раньше.

## 1.5.96 — контейнер открывается привязкой «все пользователи», а не ролью сервисному аккаунту

Первый этап плана «от запроса до прода»: убрать то, из-за чего боевой деплой **не мог** пройти
успешно ни разу, даже когда все стадии до последней отрабатывали.

**Что было не так.** Стадия «Контейнер и доступ» выводила контейнер в интернет так:

    ensureServiceAccount("sa-" + slug) → addRoleOnFolder(sa, "serverless.containers.invoker")

То есть роль invoker выдавалась **сервисному аккаунту на каталог**. Публичным контейнер делает
другое: привязка роли `serverless.containers.invoker` субъекту «все пользователи»
(`{ id: "allUsers", type: "system" }`) НА САМ КОНТЕЙНЕР через `containers/v1/containers/<id>:setAccessBindings`
(документация: serverless-containers/operations/container-public). Роль на каталог доступа из
интернета не даёт, поэтому адрес контейнера отвечал 403 → стадия «Проверка после деплоя» валила
выкат, а откатываться на первом деплое было некуда. Диагноз в коде при этом был поставлен неверно:
403 объяснялся «не хватило прав на роль invoker».

**Почему это не поймали тесты.** Подменённое облако в `scripts/live-deploy.js` отдавало по адресу
контейнера локальный сайт, который всегда отвечал 200, и принимало любой запрос прав. Главное
свойство реальности — «пока прав нет, адрес закрыт» — в подмене отсутствовало.

**Что сделано.**

- `src/yandex-cloud.js`: `listContainerAccessBindings` и `setContainerPublicAccess` (delta ADD, чужие
  роли не трогаем; повторный вызов видит готовую привязку и не дублирует её; результат проверяется
  по списку прав, а не по факту отправки запроса). id роли сопоставляется «по скелету»: облако
  отвечает и `serverless.containers.invoker`, и `serverless-containers.containerInvoker`.
- `src/deploy-engine.js`: стадия контейнера выдаёт публичный доступ этой привязкой и говорит в отчёте,
  чем именно открыт контейнер. Сервисный аккаунт для публичности больше не создаётся: он был лишним
  правом (`iam.serviceAccounts.create`) и лишним ресурсом в каталоге пользователя. Когда он реально
  понадобится приложению (секреты, бакеты) — попросят явно, `o.serviceAccount`.
- Текст ошибки 403 переписан по факту: «нужна привязка все пользователи → invoker на контейнер»,
  а не «не хватило прав на роль invoker».
- `scripts/live-deploy.js`: подменённое облако теперь воспроизводит главное — **адрес контейнера
  отвечает 403, пока привязки нет**. Если стадия прав исчезнет, живой тест упадёт целиком.
- Тесты: три новых — (1) стадия выдаёт привязку, повтор называет «уже был», отказ в правах
  останавливает выкат до ревизии, `public: false` права не трогает; (2) сам модуль облака на
  подменённом API: привязка, распознавание готовой, отказ с названным правом; (3) **сквозной** прогон
  движка через настоящий `yandex-cloud.js` к подменённому API, где закрытый контейнер отдаёт 403, а
  права открывают адрес.

**Проверено.** `npm test`: smoke **444/0** (было 441), field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair
7/0, repo-shape 7/0. Мутации **6 из 6 пойманы**: права не выдаются вовсе; публичность выдаётся
сервисному аккаунту; id роли сравнивается буквально; результат выдачи не проверяется; сервисный
аккаунт вернулся в публичный путь; `public: false` игнорируется. Одна из мутаций сняла версию файла
при таймауте команды — это замечено по содержимому и восстановлено, после восстановления прогон
снова 444/0.

**Честно.** Живого прогона против облака нет: нужен аккаунт с OAuth-токеном и деньги (следующий этап
плана — отдельный `test:live:yc:real` с ручной уборкой ресурсов). И `scripts/live-deploy.js` в этой
песочнице не запускается: на Linux нужен `xvfb-run`, которого здесь нет.
## 1.5.97 — настоящий E2E и приёмка, которая не пускает сломанное в прод

Два этапа плана «от запроса до прода» сразу: сквозной прогон против НАСТОЯЩЕГО
облака (этап 2) и правила приёмки production (этап 3).

### Этап 2 — `test:live:yc:real`: прогон против настоящего Yandex Cloud

**Зачем.** Подменённое облако в `scripts/live-deploy.js` проверяет ЛОГИКУ движка,
но не реальность: настоящий API ломается на том, чего подмена не повторяет —
право IAM, статус операции, схема ответа, формат параметра ревизии. Пока это не
прогнано по-настоящему, зелёный тест ничего не говорит о боевом деплое.

**Что делает новый `scripts/live-yc-real.js`** (запуск `bun run test:live:yc:real`)
— ровно цепочку из плана:

    контейнер → настоящая ревизия → настоящий URL → HTTP-здоровье
    → браузер → вторая ревизия → откат → здоровье снова → удаление ресурсов

- Работает через НАСТОЯЩИЕ модули: `src/yandex-cloud.js` и `src/deploy-engine.js`
  (движку передаются лишь те зависимости, что в приложении даёт `main.js`:
  запуск команд с кодом выхода, поиск docker, аудит страницы из `browser-tools.js`).
- Проект — статический сайт с маркером версии; Dockerfile движок генерирует сам,
  то есть проверяется и наша сборка, а не только облако.
- **Смена версии подтверждается маркером, а не кодом 200.** У одной ревизии адрес
  не меняется, поэтому «страница отвечает» само по себе ничего не доказывает:
  после отката проверяется, что вернулся маркер ПЕРВОЙ версии.
- Секреты включены намеренно: так по-настоящему проверяются стадия Lockbox и
  сервисный аккаунт, которому выдаётся право только на этот секрет.

**Безопасность прогона.** Без `YC_OAUTH_TOKEN` скрипт не начинается вовсе. Без
`AI_AGENT_YC_REAL=1` (или `--yes`) он только печатает план того, что будет создано,
и выходит — молча тратить деньги пользователя он не должен. Уборка идёт в
`finally`, поэтому выполняется и после провала; если что-то удалить не удалось, в
конце печатается список «осталось удалить руками» с id. Имена всего созданного
начинаются с `e2e-<метка времени>`, так что их видно глазами. `YC_REAL_KEEP=1`
оставляет ресурсы для разбора.

**Уборка знает порядок, а не «удалить всё».** Реестр в облаке не удаляется, пока
в нём лежат образы, поэтому сначала удаляются образы, потом реестр; контейнер —
до реестра; секрет и сервисный аккаунт — своими вызовами. Провал одной уборки не
мешает остальным: всё, что не вышло, попадает в список для ручного удаления.

### Этап 3 — production не принимает сломанное

**Что было не так.** Падение тестов проекта давало ЗАМЕЧАНИЕ и деплой продолжался
(`deploy-engine.js`: «Тесты проекта упали — деплой продолжен»). В прод уезжало
заведомо сломанное состояние. Проверка страницы браузером была необязательной:
если браузер не поднялся, стадия молча пропускалась.

**Что сделано (решение принимают две чистые функции, поэтому они и проверяются
напрямую):**

- `testsAreFatal(o, recipe)` — в production падение тестов останавливает выкат
  **до сборки образа**. В development — по-прежнему замечание. Продолжить можно
  только явным «да, я понимаю» (`allowFailingTests: true`, кнопка в панели), и
  тогда правда остаётся в замечаниях и в истории деплоя. Есть и `testsGate:
  "block" | "warn"` — для случаев, когда окружение не выражает намерения.
- `browserModeOf(o)` — режим проверки страницы: `off` (не проверять и не делать
  вид, что проверили), `auto` (по умолчанию), `required` (без проверки выкат не
  принимается). **Сломанная страница** — белый экран, 5xx, 404, ошибки консоли —
  останавливает выкат в любом режиме, кроме `off`.

**Почему браузер не стал обязательным «по умолчанию» для frontend, хотя просили.**
Первая версия делала `required` автоматически для frontend в production — и уронила
уже существующий тест: выкат падал не из-за приложения, а из-за того, что браузер
не поднимается на этой машине. Это ограничение окружения, а не поломка продукта, и
платить за него остановкой прода неправильно. Поэтому `required` — осознанный
выбор пользователя (`browserCheck: "required"`), а не навязанное правило. Если
нужно строже — это одна строка в `browserModeOf`.

**Панель больше не молчит.** При остановке на тестах она объясняет причину и
показывает кнопку «⚠ Всё равно задеплоить: тесты упали» (признак приходит из
движка как `testsFailed`, а не вылавливается из текста ошибки). Опции
`environment`, `allowFailingTests`, `testsGate`, `browserCheck` проведены через
`src/deploy-ipc.js` (это же путь и для агентского `ycDeploy`).

### Проверки

- `test/smoke.test.js` — **455/0** (+9): пять на E2E-скрипт (права на запуск, совпадение
  имён ресурсов с движком, уборка с порядком «образы раньше реестра», подтверждение
  версии маркером, прогон «выкат → вторая ревизия → откат» на подставном движке
  с проверкой, что после провала первого выката второй не запускается) и четыре на
  приёмку production (чистые правила; живой прогон конвейера на подставных Docker
  и облаке, где видно, что выкат встаёт ДО `docker build`, а `allowFailingTests`
  его пропускает; три режима проверки страницы; связность панели и моста).
- Остальные наборы: field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0, repo-shape 7/0.
- **Мутации: 6 из 6 пойманы** (отключить гейт тестов; не выставлять признак
  остановки; проигнорировать режим `off`; не удалять образы при уборке; не
  требовать маркер версии; разойтись с движком в имени реестра). Всё откачено.
- Проверки самого скрипта без токена и без согласия: `--plan` печатает план и
  выходит, запуск без токена останавливается на первой же проверке.

### Честно

- **Настоящий прогон против облака в этой песочнице не выполнен**: нет OAuth-токена,
  нет Docker и это стоит денег. Проверено то, что проверяется кодом — сами правила
  приёмки живым прогоном конвейера, а у E2E-скрипта логика прогона, уборки и
  подтверждения версии. Первый настоящий запуск — за пользователем:
  `YC_OAUTH_TOKEN=... AI_AGENT_YC_REAL=1 bun run test:live:yc:real`.
- `scripts/live-yc-real.js` не запускается в песочнице и целиком (`xvfb-run` тут нет,
  а браузерный шаг идёт через `browser-tools.js`) — в приложении на ПК он идёт по
  обычному пути.

**Мелкая правка вывода (после 1.5.97).** Отказ в начале прогона печатался одной строкой:
`❌ YC_OAUTH_TOKEN задан — не задан: ` и дальше весь план создания ресурсов, склеенный в ту же
строку. Теперь у чека короткая причина («возьмите OAuth-токен на oauth.yandex.ru»), а план
выходит отдельным блоком ниже — ровно это человек и видит при первом запуске без токена.
Обе причины отказа (нет токена / нет согласия на траты) возвращают код 2 и ничего не создают:
проверено запуском без `YC_OAUTH_TOKEN` и с фиктивным токеном без `AI_AGENT_YC_REAL`.

## 1.5.98 — инструменты перестали врать про свою работу (отчёт песочницы по ВК)

Отчёт живой работы с ВК разобран по коду: часть пунктов подтвердилась как настоящие
дефекты, часть оказалась неверным диагнозом. Сделаны только подтверждённые — с тестами.

### Что было настоящей поломкой

1. **browserEval: «то работает, то нет».** Корень не в промисах (`page.evaluate` их и так
   ждёт), а в обёртке: код без слова `return` заворачивался в `return ( … )` — для набора
   операторов это синтаксическая ошибка, срабатывал откат «выполнить как есть», значение
   терялось, а в чат уходило «(выражение ничего не вернуло)» без объяснения. Второй слой:
   Playwright отдаёт `undefined` для несериализуемых значений (DOM-узел, Map/Set, объект с
   циклами) — узел «пропадал» молча. Теперь значение проходит сериализатор В СТРАНИЦЕ
   (`evalValueToPlain`), ответ честно говорит «код выполнен, значения не вернул», а если код
   писал в `window.__x` — инструмент сам подставляет это значение (`varValueInPage`) и
   называет его размер.
2. **browserReplay не находил запрос ВК.** Метод лежит в теле бандла
   (`POST …/method/batch.call`, `batch=…messages.getItems…`), а образец искался по адресу →
   replay брал чужой POST (поллинг `a_check`) со старой версией API и получал отказ. Теперь
   `match` ищется и в теле, в журнал пишется тело целиком (было 8 КБ — бандл не влезал), тип
   `other` (свой транспорт сайта) больше не отбрасывается, а при отказе сервера replay один
   раз берёт СВЕЖИЙ перехват и прямо говорит об этом в ответе.
3. **loadAll на виртуальном списке.** Ключ строки не знал `data-peer-id`, число строк брали из
   DOM (там их ~16–18), а `aria-setsize` (реальное «110») не читался — поэтому «шагов 4,
   конец» выглядело как конец списка. Теперь `aria-setsize` читается, «два пустых шага» не
   считаются концом, пока строк меньше обещанного, и в ответе прямо сказано «в DOM 18 строк
   из ~110 — бери данные запросом».

### Что в отчёте было не так (и почему правок не делали)

- **«browserEval не ждёт промис»** — ждёт: вызов идёт через `async`-обёртку.
- **«перехват не поймал токен, ВК шлёт своим транспортом»** — `page.on("request")` видит все
  запросы страницы и хранит `postData()`; дело было в поиске по адресу.
- **«loadAll дошёл до конца»** — дошёл до своей ложной остановки.
- **«noteSave запрещает кириллицу и не документирован»** — формат был написан и в описании, и
  в ошибке; неудобство реальное (русский ключ — естественная попытка), поэтому кириллица
  теперь транслитерируется: «Клиенты ВК» → `klienty-vk`, и это видно в ответе. Тем же
  правилом ищут и читают (`noteRead`/`noteDelete`).
- **«роль „Менеджер“ мешает писать код»** — группы ролей на это не влияют:
  `writeFile`/`runCommand` лежат в базовом наборе и роутером не срезаются. Мешала формулировка
  правила 7 — переписана: «самовольно нельзя, попросили прямо — можно», и большая такая работа
  названа миссией, а не поводом отказаться.

### Остальные правки того же захода

- **writeFile проверяет записанное**: `.js/.mjs/.cjs/.jsx` — `node --check` (тем же Node, что
  запущен), `.json` — разбор; результат виден в ответе, `check: false` отключает. Плюс строка
  про окружение: чем запускать (Node/bun, Python, bash), есть ли рядом `node_modules`, где
  брать ключи. «Исполнимость» не обещаем — зависимостей и ключей у файла может не быть.
- **Повторный missionFinish** больше не отвечает «закрывать нечего»: называет последнюю
  миссию, когда закрыта, с каким итогом и где отчёт.
- **missionStart** требует `todoWrite` ПЕРВЫМ делом (правило 12 роли «Менеджер» — так же).
- **Справочник ВК** (`agent-guides/vk.md`) дополнен: поля строки диалога
  (`.ConvoTitle__author` + `title`, `.ConvoListItem__text`, `.ConvoListItem__date`, точная
  дата в скрытом `.vkuiVisuallyHidden__host`, ключ `data-peer-id`), оба варианта строки
  (`.ConvoListItem` — новый клиент, `.convo-item` — старый), пометка, что
  `.ConvoListItem__name` не существует и селекторы не выдумывают, объяснение бандла методов,
  `aria-setsize`, `sessionStorage` рядом с `save: true`. Описания
  `browserEval`/`browserScroll`/`browserReplay`/`writeFile`/`noteSave` в промпте согласованы с
  новым поведением.

### Проверки

- `npm test`: **smoke 464/0** (+9 новых: разбор значения из страницы, честный ответ про набор
  операторов с подстановкой `window.__x`, образец replay по телу бандла и фильтр свежести,
  `aria-setsize` в вердикте догрузки, ключ строки из `data-peer-id`, кириллический ключ
  заметки, проверка записанного файла и требования окружения, повторный `missionFinish`,
  наличие новых фактов в справочнике и описаниях). field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 7/0.
- `node --check` по всем правленым файлам; сборка OTA-бандла **1.5.104** проверяет синтаксис
  всех 52 файлов приложения.
- Правки в `src/browser-tools.js`, `src/agent-tools.js` и `src/renderer/agent-core.js` делались
  точечным скриптом по строкам (`str_replace` в этих больших файлах не находит текст —
  известный глюк кэша); каждый шаг проверял якорь и падал ДО записи, если якорь не совпал.
- Живой прогон в браузере не делался: в песочнице нет Chromium/дисплея. Проверено кодом и
  подставной страницей — в приложении на ПК путь тот же.

## Замер локальной модели и адрес для телефона (1.5.99)

### Почему появился замер

Вопрос «тормозит ноутбук или подключение?» нельзя было закрыть по коду: приложение не
читало из ответа Ollama ничего, кроме счётчиков токенов, и не знало про `/api/ps`.
Теперь есть `probeLocalModel` (в `src/renderer/provider-transport.js`) и кнопка
«📈 Замерить скорость» в карточке Ollama + действие в списке команд.

- Меряем: связь (`/api/tags`), загрузку модели (`load_duration`), чтение промпта
  (`prompt_eval_count`/`prompt_eval_duration`), генерацию (`eval_count`/`eval_duration`)
  и память — веса и сколько из них в видеопамяти (`/api/ps`: `size`, `size_vram`).
- `ollamaModelInfo` теперь считает KV-кэш на токен из `/api/show` (2 × слои × головы KV ×
  размер головы × 2 байта), поэтому отчёт пишет цену запрошенного `num_ctx` в гигабайтах.
- Пробный запрос — не-стрим с балластом ~1200 символов (на 30 токенах скорость скачет) и
  с ТЕМ ЖЕ `num_ctx`, что у боевого чата: другой размер контекста заставил бы Ollama
  перезагрузить модель и испортил бы следующий ответ.
- Отчёт: строки метрик + вердикт (упор в процессор / в объём запроса / железо справляется)
  + до трёх советов, что ускорит (модель поменьше, `num_ctx` 8–16k, размышления).
- Местные OpenAI-совместимые серверы (LM Studio, llama.cpp, g4f) тоже проверяются, но
  честно: разбивку «чтение/генерация» они не отдают — показываем полное время ответа.
- Обвязка: канал `ai:probeLocal` (main.js) → `preload.js` и `mobile-api.js` (работает и с
  телефона) → `app.js`.

### Адрес для телефона

У мобильного моста адрес брался как первый LAN-адрес ПК, а у машины их обычно несколько
(Hyper-V, WSL, Docker) — телефон уходил на недостижимый. Теперь:

- настройка `mobileHost` (по умолчанию `192.168.1.72`, поле «Адрес для телефона» в
  Настройках → Мобильный доступ) ставит адрес первым в списке и в QR-коде;
- если такого адреса на ПК нет (сменилась сеть) — он НЕ подставляется, показываем реальные
  и пишем предупреждение (`hostActive` из `status()`);
- автоопределение без настройки тоже поумнело: 192.168.x.x и 10.x идут впереди виртуальных
  адаптеров (по имени адаптера), 172.16–31.x — в конце.

### Проверки

- `npm test`: **smoke 471/0** (+7: скорости/память/KV/вердикт по подставному ответу Ollama,
  честный отказ при молчащем сервере, отказ без выбранной модели, обвязка IPC/preload/кнопки,
  адрес для телефона из настроек, порядок адресов и отказ от чужого адреса, поле в настройках).
  field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0, repo-shape 7/0.
- OTA-бандл пересобран: **1.5.107**, 69 файлов, синтаксис 52 JS проверен при сборке.
- Живой прогон замера не делался: Ollama живёт на ПК пользователя, из песочницы порт 11434
  закрыт (`ECONNREFUSED`). Проверено подставным сервером с реальными полями ответа Ollama.

## Этап 1 разреза ядра: данные агента — в свои модули (1.5.100)

Начало поэтапного разреза крупных файлов. Взят самый безопасный кусок: в
`src/renderer/agent-core.js` было 3814 строк, из них **2320 — чистая таблица** (текст
правил и 159 схем инструментов) без единой строки логики.

- **`src/renderer/prompts.js`** (67 строк) — `SYSTEM_PROMPT`.
- **`src/renderer/tool-schemas.js`** (2342 строки) — `TOOL_DEFINITIONS` (159 схем).
- **agent-core.js: 3814 → 1455 строк.** Данные не переписывались: перенос проверялся
  хешами до и после — sha текста промпта и sha JSON таблицы схем совпали побайтово,
  порядок 159 имён и план-режим тоже. Ядро берёт их из модулей и **отдаёт наружу под
  теми же именами**, поэтому main.js, инструменты, панель и тесты не менялись.

Проводка (как у остальных модулей ядра): `require` в CommonJS, `window.Prompts` /
`window.ToolSchemas` в окне, теги в index.html **перед** agent-core.js, файлы в списке
выдачи мобильного моста — без них телефон получил бы агента без правил и инструментов.

### Что изменилось в тестах (и почему)

- Появился помощник **`coreData()`**: ядро вместе с его данными. 15 проверок вида «в
  промпте сказано X» и «в описании инструмента есть Y» читали agent-core.js напрямую и
  падали на переехавшем тексте — теперь они читают данные, где бы те лежали. Кто
  проверяет, что в САМОМ ядре данных больше нет, по-прежнему читает только ядро.
- Проверка утечек между модулями перешла на **`codeOnly()`**: строки и комментарии
  снимаются, сканируется код. Имя, попавшее в строку, уронить модуль не может, а
  таблицы данных состоят из строк почти целиком (в описании инструмента законно
  встречается `window.__x` — это текст для модели, а не обращение к окну). Заодно ушла
  старая ошибка: «//» внутри строки («https://…») съедал остаток строки вместе с кодом,
  и утечка могла спрятаться.
- Два **живых** теста вместо текстовых: мост реально отдаёт `/prompts.js` и
  `/tool-schemas.js` по HTTP (не только упоминает в списке), а ядро поднимается в
  песочнице **в порядке тегов из index.html** и в нём совпадают промпт, таблица схем,
  план-режим и сборка запроса с `num_ctx`. Забытый или переставленный тег теперь
  ловится: это и есть тот случай, когда в окне агент стартует без правил.
- `scripts/live-ui.js` (живой тест интерфейса на ПК) проверяет выдачу `/prompts.js` и
  `/tool-schemas.js` вместе с остальными модулями.

### Проверки

- `npm test`: **smoke 472/0** (+1 живой тест окна; в существующий живой тест моста
  добавлена выдача данных телефону), field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0,
  repo-shape 7/0.
- `node scripts/live-ui.js`: серверная часть зелёная (все модули, включая новые, отдаются
  с 200); шаг с настоящим Chromium в песочнице не идёт — нет системной библиотеки
  `libglib-2.0.so.0`, а ставить её нельзя. На ПК этот шаг пройдёт целиком.
- OTA-бандл пересобран: **1.5.108**, 71 файл (было 69), синтаксис 54 JS проверен при сборке.
- Данные сверены хешами: промпт и таблица схем до и после переноса — байт в байт.

## Этап 2 разреза интерфейса: панель Yandex Cloud — отдельный модуль (1.5.101)

`src/renderer/app.js` был 9077 строк и держал в себе всё окно. Первым вырезан самый
обособленный кусок — панель Yandex Cloud: **626 строк** уехали в новый
`src/renderer/yc-panel.js`, app.js стал **8466 строк** (−611).

### Как вырезали

Код перенесён **текст в текст** (сверил построчно: 626 строк совпали байт в байт),
изменилось только одно: `settings.…` → `getSettings().…` (7 мест).

Модуль собран по образцу `provider-transport.js` — фабрика, которая получает
зависимости одним объектом: `$`, `api`, `isElectron`, `toast`, `termAppend`,
`confirmModal`, `inputDialog`, `openSettings`, `openSidePanel` и **`getSettings`**.
Последнее принципиально: настройки в app.js перезаписываются (`settings = normalize(...)`
в 7 местах), поэтому передавать их копией нельзя — панель читает их живыми.
Наружу модуль отдаёт только `loadDashboard` и `refreshSettingsUI` — ровно то, что
зовёт оболочка окна: при заходе на вкладку «облако» и при открытии настроек.

Переключатели шапки («☁️» и «🚀») остались в app.js: это оболочка, а не облако.
Фабрика вызывается на том же месте, где раньше начинался вырезанный код, — разметка
к этому моменту уже готова, а `window.YcPanel` объявлен тегом раньше app.js.

### Что поймали тесты (и почему это хорошо)

Сразу упали **6 проверок**: четыре искали код панели в app.js напрямую. Добавлен
помощник `uiSrc` = app.js + модуль панели (как `coreData()` после этапа 1); `appSrc`
остался строго про app.js, чтобы проверки «в app.js этого быть не должно» не ослабли.
Отдельно отмечу проверку синхронизации каталога: она искала `settings.ycFolderId`,
а теперь ищет `getSettings().ycFolderId` — то есть тест заметил бы и потерю живых настроек.

### Новая живая проверка

`test/smoke.test.js` получил тест, который **реально собирает модуль**: запускает его в
браузерной песочнице (`vm`) с заглушками DOM, собранными из id настоящей разметки, и
проверяет, что панель повесила обработчики на `btn-yc-connect`, `s-yc-allow-update`,
`btn-yc-deploy` и остальные 17 элементов. Если id исчезнет из `index.html`, тест упадёт
на `TypeError` — это и есть обещанная согласованность кода и разметки.

`scripts/live-ui.js` проверяет выдачу `/yc-panel.js` вместе с остальными модулями.

### Проверки

- `npm test`: **smoke 473/0** (+1 тест сборки панели), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 7/0.
- **Живой HTTP**: мобильный мост поднят по-настоящему и отдал телефону все 18 скриптов из
  разметки с 200 — включая новый `/yc-panel.js` (26684 байта). Забытый файл в
  `STATIC_FILES` ловится именно здесь.
- **Живой запуск в окне**: в песочнице по порядку тегов `index.html` выполнены все 18
  скриптов (включая app.js), `window.YcPanel` оказался фабрикой, панель нашла элементы и
  повесила обработчики. **Негативный контроль**: с убранным тегом панели app.js падает с
  `window.YcPanel is not a function` — проверка не пустая.
- Шаг с настоящим Chromium в песочнице не идёт (нет `libglib-2.0.so.0`); на ПК —
  `bun run test:live`.
- OTA-бандл пересобран: **1.5.109**, 72 файла (было 71), синтаксис 55 JS проверен при
  сборке; все 72 файла бандла сверены с диском — расхождений 0, хеш манифеста сходится.

## Этап 0: карта раскладки и проверки, которые не боятся выноса (1.5.102)

Перед разбором остальных гигантов сделана подготовка — иначе каждый вынос ронял бы
пачку тестов: в тестах **181 строка** читает текст интерфейса, из них 60 — срезы по
текстовым якорям. На этапе 2 так упало 6 проверок на 626 строк кода.

### Что появилось

1. **`ARCHITECTURE.md`** — карта: слои, таблица «файл → что держит → где подключается»
   и правила («новый модуль окна = файл + тег + список телефону + строка в карте»).
2. **Сторож раскладки** (`test/repo-shape.test.js`): карта, `index.html` и `STATIC_FILES`
   моста обязаны совпадать, а фрагмент из столбца «где подключается» — реально найтись
   в указанном файле. Такой тест поймал бы и сломанный телефон (нет файла в списке),
   и забытый тег в разметке.
3. **`uiFile` / `uiAll` / `uiFind` в smoke-тестах**: код ищется по содержимому, а не по
   адресу. Раздвоенный или уехавший маркер — это ошибка с точным сообщением, а не молча
   взятый чужой кусок.
4. **Бюджет прямых чтений `app.js`** — 33 (было 36). Тест не даёт числу расти: каждое
   новое прямое чтение привязывает проверки к адресу кода. Три теста после перевода
   якорей больше не читают `app.js` вообще.
5. **12 сайтов (55 строк) переведены на `uiFind`** — блок паролей, индикатор контекста,
   размышления, восстановление чатов, план, история и продолжение контекста, стрим,
   поиск настроек, рельса, навигация. Каждый кусок сверен: найденное текстом `uiFind`
   обязано совпасть байт в байт со старым срезом по `indexOf`/`slice`.

### Проверки (всё в копии репозитория, рабочее дерево не трогалось)

| Проверка | Результат |
|---|---|
| `npm test` | smoke **474/0** (+1 тест помощника), field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0, repo-shape **9/0** (+2 сторожа) |
| Список для телефона без нового файла | сторож падает ✅ |
| Строка убрана из карты | сторож падает ✅ |
| Тег пропал из разметки | сторож падает ✅ |
| В карте неверный фрагмент подключения | сторож падает ✅ |
| Карта ссылается на несуществующий файл | сторож падает ✅ |
| Новое прямое чтение `app.js` в тестах | бюджет падает ✅ |
| Кусок уехал в модуль | `uiFind` находит его там (thinking-panel.js, 232 символа) ✅ |
| Маркер конца уехал в другой файл | точная ошибка «не найден конец куска (…) в <файл>» ✅ |
| Вынос в модуль | тест падает на проверке адреса («нет автопрокрутки размышлений») и называет, что править ✅ |

### Честно про предел

Полностью «нулевых» правок при выносе не бывает: там, где маркер конца принадлежал
соседней секции или где тест проверяет сам факт «код лежит в app.js», правка нужна —
одна-две строки. Выигрыш в другом: правка заменяется точной подсказкой, а не поиском
причины падения. Проверено на живой пробе: перенос в копии даёт ровно одну понятную
ошибку вместо пяти неясных.

OTA-бандл пересобран: **1.5.110**, 72 файла, синтаксис 55 JS проверен при сборке.
Версия приложения 1.5.102.

## Этап 3.1: быстрый запуск превью — свой модуль (1.5.103)

Первый вынос после подготовки. Из `app.js` вырезан блок «Быстрый запуск проекта в
превью» — **117 строк** в новый `src/renderer/dev-run.js` (весь файл 155 строк),
`app.js` стал **8362 строки** (было 8466).

### Что именно уехало

Определение занятого порта, старт и стоп dev-сервера, поток событий дев-процесса,
лог превью, дублирование вывода сервера в консоль и Tab-дополнение команды.
Текст перенесён байт в байт (сверил построчно), изменилось одно обращение:
`settings.previewUrl` → `getSettings().previewUrl` — настройки в app.js перезаписываются.

### Границы модуля

Наружу — **живое свойство** `previewRunning` (оболочка читает его в строке состояния,
копия значения устарела бы сразу) и шесть функций: `refreshDevControls`, `devStartClick`,
`devStopClick`, `termServerAppend`, `onDevEvent`, `termTabComplete`.
Внутрь — 10 зависимостей: `$`, `api`, `isElectron`, `esc`, `previewOpen`, `projectDir`,
`termAppend`, `toast`, `updateStatusBar` и `getSettings`. 13 вызовов в app.js переведены
на модуль (проверено: ровно столько, сколько было).

### Проверки

- `npm test`: smoke **475/0** (+1 поведенческий тест модуля), field-guard 15/0, ВК 8/0,
  QR 7/0, mobile-pair 7/0, repo-shape 9/0.
- Новый тест запускает модуль с заглушками настоящей разметки (id, которого нет в
  `index.html`, — падение) и проверяет поведение: команда проекта подставляется из
  главного процесса, «запущен/остановлен» ведётся живым свойством, превью открывается
  на настроенном адресе, вывод сервера идёт в лог и в консоль, Tab дополняет команду.
- **Негативный контроль зависимостей**: без `esc` модуль падает с точным «esc is not a
  function» — забытая зависимость не пройдёт молча.
- **Живой прогон окна** (`bun run test:boot`, новый скрипт): мобильный мост отдал
  телефону все 20 файлов разметки с 200, затем в песочнице в порядке тегов выполнились
  19 скриптов, все модули поднялись, панели повесили обработчики на настоящие элементы.
  **Негативный контроль**: без тега `dev-run.js` прогон падает (6 провалов) — проверка
  не пустая. Скрипт живёт в репозитории, чтобы каждый следующий вынос проверялся так же.
- OTA-бандл пересобран: **1.5.111**, 73 файла, синтаксис 56 JS проверен при сборке.

### Что дальше

Этап 3.2 — удобство чата: копирование, регенерация, правка сообщения (195 строк,
цена в тестах 0). Затем 3.3 веб-режим (315) и 3.4 замер локальной модели (61).
### Что дальше по плану

Этап 3 — мелкие чистые вырезки интерфейса: быстрый запуск превью (118 строк), удобство
чата (195), веб-режим (315), замер локальной модели (61). Затем дела и миссия (620),
секреты (408), мобильный доступ (329), панель проекта с разделением хвоста событий (2554)
и уже потом настройки и чат. Бэкенд — после интерфейса: реестр инструментов по доменам,
`browser-tools.js`, `main.js` (с предварительным расширением `backendSrc()` в тестах).

## Замер локальной модели: как его найти (1.5.104)

Жалоба: «не увидел такую функцию в УИ». Функция была и работала, но жила только внутри
карточки «🖥️ Ollama» в настройках. Исправлено:

- кнопка **«📈 Замерить скорость»** появилась в подвале настроек рядом с
  «🔌 Проверить подключение». Она видна только для местной модели (Ollama всегда;
  OpenAI-совместимый сервер на своём ПК или в домашней сети) — для облака замер
  бессмыслен: он измерил бы задержку чужого дата-центра. Видимость обновляет
  `refreshProbeButton()` из `setProviderUI()`, то есть при открытии настроек и смене
  провайдера;
- вторая кнопка осталась в карточке Ollama: тот же замер, один и тот же код;
- поиск по настройкам теперь находит замер по тексту кнопки и её подсказке
  (`settingsFieldText` читает кнопки внутри поля): «замерить» и даже «чтение промпта»
  ведут к нужному полю;
- в палитре команд есть пункт «📈 Замерить скорость локальной модели».

### Проверки

- `npm test`: smoke **476/0** (+1 тест: отчёт рисуется в панели, кнопка видна только
  для местной модели, разметка и проводка на месте), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 9/0.
- **Негативные контроли** (правка → тест → возврат): кнопка без `hidden` в разметке;
  пропавший вызов `refreshProbeButton()`; поиск, переставший читать кнопки внутри
  поля — каждый ломает проверку и называет причину.
- `bun run test:boot` (живой прогон окна): 20 файлов разметки отданы телефону, 19
  скриптов выполнились, обработчики легли и на `btn-probe-ollama`, и на `btn-probe-model`.
  Новый шаг **[4] живой замер**: поднимается настоящий HTTP-сервер, говорящий
  протоколом Ollama, и замер идёт по сети — генерация 6 ток/с, чтение промпта 30 ток/с,
  доля весов в видеопамяти 0.8, KV-кэш 147 456 Б/токен, отчёт 9 строк. Негативный
  контроль: сервер с другими цифрами — проверка падает.
- Заодно починена заглушка живого прогона: у элементов не было `closest`, и `app.js`
  падал на `$("project-select").closest(".project-switch")` в асинхронном тике —
  прогон «проходил», не дождавшись. Теперь `closest` ищет родителя по тексту настоящей
  разметки, а заглушка знает свой `id`.
- OTA-бандл: **1.5.112**, 73 файла, 56 JS проверено, все файлы сверены с диском
  (расхождений 0). Версия приложения — **1.5.104**.

### Что дальше

Этап 3.2 — удобство чата: копирование, регенерация, правка сообщения (195 строк, цена
в тестах 0). Затем 3.3 веб-режим (315). Замер больше не отдельный этап: показ отчёта
остался в `app.js`, а его находимость проверяют тесты.

## Этап 3.2: удобство чата — свой модуль (1.5.105)

Из `app.js` вынесен кусок «Удобство: копирование, регенерация, редактирование» —
91 строка, пять функций:

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 8390 строк | **8317** (−73) |
| `src/renderer/chat-actions.js` (новый) | — | 122 строки |

Уехали: `copyText` (буфер обмена с запасным путём через `execCommand`), `copyChat`
(выгрузка переписки в markdown), `isLastAssistant` (кнопка «↻» только у последнего
ответа), `regenerate` (снять ответы запуска и отправить вопрос заново),
`editUserMessage` (вернуть своё сообщение в поле ввода и переотправить).

Текст переехал **байт в байт** (сверил телом модуля), изменилось ровно одно: доступ к
общему состоянию — `streaming` → живая функция `isStreaming()`. Иначе копия значения
устарела бы, и «Перегенерировать» перебило бы уже идущий ответ. Семь вызовов в `app.js`
переведены на модуль: четыре в кнопках под сообщением, кнопка «Скопировать чат» в шапке
и пункт палитры команд.

### Что поймали проверки

- Новый поведенческий тест (`testChatActions`) запускает модуль в песочнице с заглушкой DOM,
  собранной из id настоящей разметки: перегенерация снимает ответы запуска и отправляет
  вопрос заново; во время генерации она не срабатывает; правка сообщения очищает переписку
  после него; выгрузка в markdown содержит заголовок, роли и блок инструмента; пустой чат
  не уходит в буфер; запасной путь копирования (`execCommand`) работает.
- **Негативные контроли** (правка → тест → возврат): перегенерация без повторной отправки;
  снятая проверка «идёт генерация»; пустой чат, уходящий в буфер; проводка
  `isStreaming: () => false` в `app.js` — каждый ломает тест, восстановление зелёное.
- Заодно проверено, что «голых» обращений к вынесенным функциям в `app.js` не осталось
(0 из 0), а через модуль их ровно 7 — столько, сколько было.
- `npm test`: smoke **477/0** (+1), field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0,
  repo-shape 9/0. Живой прогон окна: 21 файл разметки телефону, 20 скриптов выполнились.
  **Негативный контроль**: без тега `chat-actions.js` `app.js` падает на
  `window.ChatActions is not a function` — проверка не пустая.
- OTA-бандл: **1.5.114**, 74 файла (+1), 57 JS проверено, файлы сверены с диском.
  Версия приложения — **1.5.105**.

### Что дальше

Этап 3.3 — веб-режим: браузерный чат (315 строк, цена в тестах 0). Дальше по плану
дела и миссия (620), секреты (408), мобильный доступ (329), панель проекта с разделением
хвоста событий (2554) и уже потом настройки и чат.

## Этап 3.3: веб-режим — свой модуль, и найденная в нём ошибка (1.5.106)

Из `app.js` вынесен браузерный цикл чата: 316 строк, состояние авто-переключений,
`tryWebAutoSwitch` и `webSend`.

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 8317 строк | **8014** (−303) |
| `src/renderer/web-chat.js` (новый) | — | 346 строк |

Текст переехал **байт в байт**; изменилось только обращение к общему состоянию:
`settings` → `getSettings()` (17 мест). Копия не годилась бы: объект настроек
перезаписывается, и смена профиля не дошла бы до модуля.

### Найденная ошибка (её закрыла эта работа)

В браузерном авто-переключении профилей вызывался `onEvent({ type: "profile_switched", … })`,
**которого в app.js нет вовсе** — такой обработчик существует только как параметр
`webSend`. При ошибке ключа/баланса функция успевала переключить профиль и сохранить
настройки, а потом падала с `ReferenceError: onEvent is not defined`. Исключение
вылетало из `webSend` целиком: прогон обрывался с непонятным сообщением вместо повтора
на запасном ключе, и пользователь не видел, что подключение сменилось. В desktop-цикле
такого нет: там отчёт идёт через `emit(...)` и обёрнут в try/catch.

Проверено ДО правки: запуск той же функции из текста `app.js` дал
`ReferenceError: onEvent is not defined`, профиль при этом уже был переключён.
Исправление — в модуль передаётся `onEvent: onAiEvent` (то же окно событий, что и у
desktop-цикла): тело функции не менялось ни на байт.

### Проверки

- Новый поведенческий тест (`testWebChat`) гоняет модуль на живом ядре AgentCore и
  настоящих `Response`: первый ключ отвечает 402 — модуль переключается на второй,
  сообщает об этом событием, повторяет раунд уже с новым ключом, собирает поток в ответ
  и завершает прогон; вызов `readFile` получает честное «доступно в desktop-приложении»;
  без выбранной модели запросов в сеть не уходит вовсе.
- **Негативные контроли** (правка → тест → возврат): модуль без обработчика событий
  (ровно старая ошибка); раунд не повторяется после переключения; снята проверка
  «модель не выбрана»; в проводке `onEvent` подменён пустышкой — каждый ломает тест.
- Четыре старые проверки искали код веб-режима прямо в `app.js` и упали на выносе.
  Переведены на `uiAll()` (весь интерфейс): они спрашивают «этот код есть?», а не «он
  лежит именно в app.js». Заодно прямых чтений `app.js` в тестах стало на одно меньше.
- `npm test`: smoke **478/0** (+1 тест веб-режима, +1 предыдущий), field-guard 15/0, ВК 8/0,
  QR 7/0, mobile-pair 7/0, repo-shape 9/0. Живой прогон окна — чисто; **негативный
  контроль** без тега `web-chat.js`: `app.js` падает на `window.WebChat is not a function`.
- OTA-бандл: **1.5.115**, 75 файлов (+1), 58 JS проверено, файлы сверены с диском.
  Версия приложения — **1.5.106**.

### Что дальше

Этап 3.4 — дела и миссия (620 строк, цена в тестах 1). Дальше секреты (408),
мобильный доступ (329) и панель проекта с разделением хвоста событий (2554).

## Этап 3.4: дела и миссия — свой модуль, и две найденные в нём ошибки (1.5.107)

Из `app.js` вынесены роли чата, панель дел со сроками и карточка миссии — самый
связный кусок из оставшихся: 29 функций, 676 строк.

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 8014 строк | **7338** (−676) |
| `src/renderer/tasks-mission.js` (новый) | — | 740 строк |

Уехали: роли (`chatRole`, `setChatRole`, `initRolesAndTasks`), список дел
(`taskRow`, `tasksDueText`, `paintTaskFilters`, `paintQuickDue`, `addTaskFromPanel`,
`renderTasks`, `tasksFilter`, `QUICK_DUE`) и карточка миссии (`renderMission`,
`refreshMission`, `missionFromEvent`, `missionTickStart`, `initMissionPanel`).

**Сверка переноса** (скрипт, а не глаз): из 29 функций **21 совпала байт в байт**,
8 отличаются ровно доступом к общему состоянию — `settings` → `getSettings()` (4 места),
`streaming` → `isStreaming()` (2), `sideTab` → `getSideTab()` (3) — плюс три правки
из этого раздела ниже. Проводка передаёт **живые** функции (`getSettings: () => settings`),
поэтому копия настроек или признака генерации не устареет. Голых вызовов вынесенных
функций в `app.js` не осталось: 8 обращений идут через `TasksMission.`.

### Найденная ошибка 1: живая миссия выглядела выключенной (гонка на старте)

`renderMission` первые строки проверяет `st.enabled`, а `enabled` приходит только из
опроса главного процесса. Событие о миссии приходит из потока агента и может обогнать
опрос. Тогда карточка пряталась и панель писала:

```
Пустое состояние: "Долгая работа выключена: включи галочку «Долгая работа агента (миссии)» …"
Карточка миссии скрыта: true      ← при этом миссия уже идёт
```

Это доказано пробой (состояние из main отвечает медленнее события). Исправление —
в слиянии события `enabled: true`: само событие доказывает, что долгая работа включена.

### Найденная ошибка 2: падение на отсутствующих `metrics` (следом за первой)

Как только карточка начала рисоваться из события, вылезло следующее: у миссии, собранной
из одного события, нет поля `metrics`, а строка метрик читала его напрямую —
`m.metrics.tokens` / `m.metrics.compactions`. Исключение вылетало из отрисовки и уходило
в обработчик событий агента (`TypeError: Cannot read properties of undefined (reading
'compactions')`). В жизни это выглядело бы как непонятный сбой панели при старте миссии.
Исправление: `(m.metrics && m.metrics.tokens) || 0`.

### Мелочь, которую видно в панели

Срок просроченного дела показывался как «⚠ ⚠ просрочено 12:18 · 1 ч назад»: значок
добавлялся и в `taskRow`, и внутри `tasksDueText`. Теперь значок один.

### Проверки

- Новый поведенческий тест `testTasksMission` запускает модуль на заглушках **настоящей
  разметки** (id, которых нет в `index.html`, роняют тест) и живой `isStreaming()`:
  роли чата, счётчики и группы, фильтр сужает список, добавление дела (пустое — подсказка,
  с названием — уходит агенту с `auto: true`), пауза миссии не срабатывает поверх
  генерации, событие рисует карточку сразу, а после опроса слово за главным процессом,
  гонка «событие раньше опроса» и миссия без `metrics`.
- Заглушка DOM теперь повторяет браузер: запись `innerHTML` заменяет содержимое. Без
  этого строки дел копились, и проверка «фильтр сузил список» ничего не видела (6 вместо 2).
- **Негативные контроли**: без тега `tasks-mission.js` живой прогон даёт **16 провалов**
  (проверка не пустая); забытая зависимость (`getActiveChat`) падает с понятной ошибкой.
- `npm test`: smoke **479/0**, field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0,
  repo-shape 9/0. В `scripts/live-boot.js` шаг [3] дополнен панелью дел и миссии —
  восемь новых id обязаны получить обработчики.
- OTA-бандл: **1.5.117**, 76 файлов (+1), 59 JS проверено, все файлы сверены с диском —
  расхождений 0. Версия приложения — **1.5.107**.

### Что дальше

Секреты: пароли, почта, переменные (408 строк, цена в тестах 6) — там проверок больше
всего, идти по чек-листу из `ARCHITECTURE.md`. Потом мобильный доступ (329) и панель
проекта с разделением хвоста событий (2554).

## Этап 3.5: секреты (пароли, почта, переменные) — свой модуль (1.5.108)

Из `app.js` вынесены все три вкладки секретов: 409 строк, 23 функции.

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 7338 строк | **6940** (−398) |
| `src/renderer/secrets-panel.js` (новый) | — | 449 строк |

Уехали: менеджер паролей (`vaultArr`, `renderVault`, `vaultLoadToForm`, `vaultClearForm`,
`vaultAdd`, `vaultDelete`), почта (`renderMailStatus`, `mailGuessed`, `mailFillServers`,
`mailRenderList`, `mailDoTest`, `mailDoTestSend`, `mailDoRecent`) и переменные агента
(`envScopeLabel`, `envScopeGroups`, `envScopeValue`, `setEnvScope`, `renderEnvVars`,
`envAdd`, `envDelete`, `parseEnvText`, `envImportText`, `envImportFile`).

**Сверка переноса:** тело модуля совпало с прежней областью **байт в байт** после замены
32 обращений `settings.` → `getSettings().` (настройки в оболочке перезаписываются — при
смене профиля копия устарела бы). Скрипт выноса падает до записи, если маркер не нашёлся,
если функция не одна или если вызовов снаружи не ожидаемое число. Двенадцать вызовов в
`app.js` переведены на модуль (`renderVault`, `renderEnvVars`, кнопки переменных,
паролей и почты); «голых» обращений к вынесенным именам не осталось — 0.

### Что проверено и как

- **Новый поведенческий тест** `testSecretsPanel`: модуль запускается на заглушках
  НАСТОЯЩЕЙ разметки (id не из `index.html` роняют тест) и делает полный круг:
  пустой список → проверка имени переменной → сохранение значения → маска вместо
  значения → выдача группе (`git`) и возврат к «Всем» → импорт текстом (комментарии,
  `export`, кавычки, мусорные строки) → импорт из файла через `FileReader` → удаление
  кнопкой вместе с выдачей → пресеты почты (Gmail, Outlook со STARTTLS, неизвестный
  домен) → проверка входа (успех, отказ с подсказкой, честный отказ в веб-режиме) →
  последние письма с кодом входа → **живые настройки** (объект подменили снаружи —
  панель обязана увидеть новый) → проводка в `app.js` отдаёт `getSettings: () => settings`.
- **Восемь негативных контролей** (в КОПИИ репозитория, рабочее дерево не трогается):
  значение переменной показано вместо маски; удаление не убирает выдачу; в веб-режиме
  почта всё равно идёт в главный процесс; имя переменной без проверки; проводка отдаёт
  пустые настройки; в проводке нет `persistSettings`; без тега `secrets-panel.js` живой
  прогон даёт **25 провалов**; модуль забыт в списке файлов для телефона — сторож
  раскладки падает. Каждый пойман.
- Три старые проверки искали этот код прямо в `app.js` и упали на выносе (как и было
  предсказано: цена выноса — 6 правок). Переведены на `uiAll()`: они спрашивают «этот код
  есть в интерфейсе?», а не «он лежит в app.js». Поведенческий тест паролей теперь
  получает `getSettings()` вместо объекта настроек. Прямых чтений `app.js` в тестах стало
  ещё на одно меньше (бюджет 33 — растёт только вниз).
- `npm test`: smoke **480/0** (+1 тест панели), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 9/0.
- Живой прогон окна: телефону отданы **27 файлов разметки** (включая
  `/secrets-panel.js` — 18 919 байт), в песочнице выполнились **23 скрипта** в порядке
  тегов; шаг обработчиков расширен девятью id секретов.
- OTA-бандл: **1.5.118**, 77 файлов (+1), 60 JS проверено, все файлы сверены с диском —
  расхождений 0. Версия приложения — **1.5.108**.

### Что дальше

Мобильный доступ (329 строк, 7 правок тестов) → чат: размышления и сегменты (1316, 20) →
настройки (916, 32) → панель проекта (2554, 4) с предварительным разделением хвоста
событий (7.1). Затем гиганты вне окна: `main.js` (5297 строк, 73 IPC-обработчика),
`src/browser-tools.js` (3566), `src/agent-tools.js` (2774), `src/agent-store.js` (1520),
`src/yandex-cloud.js` (1204) и самый крупный файл репозитория `test/smoke.test.js` (13 703).

## Сверка линий перед продолжением разреза (1.5.109)

Сессия началась с пулла `242fd72..d6ab750` (5 коммитов, версии 1.5.85–1.5.108). Как и
требует чек-лист из `ARCHITECTURE.md`, перед следующим выносом сделана сверка: размеры
файлов, состояние этапов и цена каждого оставшегося шага. План ниже опирается на факты,
а не на память прошлой сессии.

### Состояние рабочего дерева

- Забраны версии **1.5.85–1.5.108**; приложение — **1.5.108**, OTA-бандл — **1.5.118**.
- В воркспейсе оставались **неотслеживаемые** остатки снесённого Flutter-прототипа
  (`android/`, `ios/`, `macos/`, `linux/`, `windows/`, `.dart_tool/`, `.flutter-plugins*`,
  пустой `lib/`). Git убрал их из индекса, физически папки остались, и сторож
  `repo-shape` («платформенных папок Flutter нет») падал именно на них. Папки удалены —
  это локальный мусор, в репозитории его нет.
- `npm test` после уборки: smoke **480/0**, field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape **9/0** — итого **526 ✅ / 0 ❌**.
- Ветка `main` синхронна с `origin/main` (0/0), дерево чистое.

### Размеры (сверено `wc -l`, а не по памяти)

| Файл | Строк | Что с ним |
|---|---|---|
| `src/renderer/app.js` | 6940 | режем дальше (цель — тонкая оболочка) |
| `src/main.js` | 5297 | 73 IPC-обработчика, резать после интерфейса |
| `src/browser-tools.js` | 3566 | браузер агента, по действиям |
| `src/agent-tools.js` | 2774 | реестр инструментов по доменам |
| `src/agent-store.js` | 1520 | по тому же чек-листу |
| `src/yandex-cloud.js` | 1204 | по тому же чек-листу |
| `test/smoke.test.js` | 13 703 | разбить по наборам |

Все вынесенные модули окна: `tool-schemas` 2342, `agent-core` 1455,
`provider-transport` 1096, `tasks-mission` 740, `deploy-panel` 707, `yc-panel` 660,
`mobile-api` 602, `field-guard` 583, `qr` 528, `secrets-panel` 449, `image-tools` 432,
`context-window` 366, `provider-config` 348, `markdown` 348, `web-chat` 346,
`yc-console` 310, `highlight` 227, `web-tools` 224, `dev-run` 154, `chat-actions` 122,
`prompts` 67, `bootstrap` 25.

### Карта остатка: порядок и цена

Внутри окна (`app.js`):

| Этап | Что | Строк | Правок тестов |
|---|---|---|---|
| **3.6** | мобильный доступ: QR, статус моста, PIN, адреса для телефона | ~90 | 2 |
| 3.7 | чат: размышления и сегменты ответа (выносить по частям) | 1316 | ~20 |
| 3.8 | настройки: поиск, OpenAI-подключения, карточка замера, вкладки | 916 | ~32 |
| 7.1 | разделение хвоста событий (подготовка, без выноса) | — | — |
| 7 | панель проекта: файлы, правка, вкладки, коммиты, дифф, публикация | 2554 | 4 |

Вне окна: **4** `main.js` (5297, 73 канала IPC: регистрация каналов → сервисы →
обработчики инструментов) → **5** `browser-tools.js` (3566, по действиям) →
**6** `agent-tools.js` (2774, реестр по доменам: файлы, git, облако, почта, браузер,
заметки, медиа) → **8** `agent-store.js` (1520) и `yandex-cloud.js` (1204) →
**9** `smoke.test.js` (13 703) разбить по наборам (vault, дела, YC, почта, мобильный,
разметка), чтобы прогон шёл частями.

### Производственная безопасность деплоя (не сделано, вне разреза)

Из разбора облачных идей, ещё не реализовано:

1. В production **падение тестов останавливает деплой** (сейчас предупреждение и
   продолжение) — это главное.
2. HTTP-проверка после деплоя обязательна.
3. Браузерная проверка — настраиваемая и рекомендованная для фронтенда.
4. **Deployment Manifest** перед сборкой: runtime, фреймворк, команда запуска, порт,
   миграции — чтобы не полагаться на эвристики Dockerfile.

Порядок работы по каждому этапу — ровно чек-лист из `ARCHITECTURE.md` (анализ границ →
скрипт с проверкой якорей → байт в байт → тесты → живой прогон → OTA и заметка).

## Этап 3.6: мобильный доступ — свой модуль (1.5.109)

Из `app.js` вынесена панель подключения телефона: QR-код, статус моста, PIN и адреса.

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 6940 строк | **6848** (−92) |
| `src/renderer/mobile-panel.js` (новый) | — | 149 строк |

Уехали: `renderMobileQr` (код «наведи камеру»: адрес моста + PIN), `renderMobileStatus`
(PIN, список реальных адресов, два предупреждения — недостижимый адрес и незапустившийся
мост, честный отказ статуса) и `regenerateMobilePin`. Наружу модуль отдаёт три точки
входа: `applyMobileFields` (поля из настроек + статус), `readMobileFields` (поля обратно
в живые настройки) и `initMobilePanel` (галочка и кнопка «Новый PIN»).

**Сверка переноса** (скрипт, а не глаз): тело модуля совпало с прежней областью
**байт в байт** за вычетом одной строки — `settings.mobilePin` → `getSettings().mobilePin`.
Голых вызовов вынесенных функций в `app.js` не осталось: три обращения идут через
`MobilePanel.`.

### Что стоит помнить про этот этап

- `applyMobileFields` возвращает обещание статуса. Так и панель не остаётся «висеть» без
  ответа, и тест не проверяет адреса раньше, чем придёт ответ главного процесса: первая
  версия теста падала ровно на этом.
- Панель общается с главным процессом только в desktop-приложении. В веб-режиме поля
  прячутся и ни одного вызова IPC не уходит — это отдельная проверка в тесте.
- Строка карты интерфейса про `qr.js` поехала на новый модуль: `window.QR` теперь зовёт
  `mobile-panel.js`. Сторож раскладки заметил это сразу — в `app.js` вызова `window.QR`
  больше нет, и карта обязана говорить правду.

### Проверки

- `npm test`: smoke **481/0** (+1 тест панели), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 9/0 — итого **527 ✅ / 0 ❌**.
- Новый поведенческий тест `testMobilePanel` запускает модуль на заглушках **настоящей
  разметки** (id не из `index.html` роняют тест) и делает полный круг: заполнение полей
  из настроек → QR с PIN и адресом → предупреждение о недостижимом адресе →
  предупреждение о незапустившемся мосте → честный отказ статуса → сохранение в живые
  настройки (и возврат порта к 9090 при пустом поле) → галочка и кнопка PIN → ошибка
  смены PIN называется вслух → веб-режим без вызовов IPC → негативный контроль
  зависимостей (без `getSettings` модуль падает понятной ошибкой).
- Две старые проверки искали код панели прямо в `app.js` (как и было предсказано: цена
  выноса — 2 правки). Тест «поле „Адрес для телефона“ сохраняется» переведён на
  `uiAll()`, тест «ссылка с ПК и разбор на телефоне» — на модуль. Прямых чтений `app.js`
  в тестах стало **30 → 28** (бюджет растёт только вниз).
- Живой прогон окна (`bun run test:boot`): телефону отданы **28 файлов** разметки
  (включая `/mobile-panel.js` — 6201 байт), в песочнице выполнились **24 скрипта** в
  порядке тегов, `MobilePanel` поднялся фабрикой, обработчики легли на
  `s-mobile-enabled` и `btn-mobile-pin-regen`. Шаг [2] прогона научился видеть подписку
  через `addEventListener`: раньше честная панель выглядела «без обработчика».
- **Негативный контроль**: без тега `mobile-panel.js` прогон падает — `app.js` не
  выполняется с `window.MobilePanel is not a function`, следом сыпется вся проводка.
  Проверка не пустая.
- OTA-бандл: **1.5.119**, 78 файлов (+1), 61 JS проверен при сборке, все файлы сверены
  с диском — расхождений 0. Версия приложения — **1.5.109**.

- Живые прогоны: `bun run test:live` (настоящий Chromium) — **60 ✅ / 0 ❌**;
  `bun run test:live:desktop` (настоящее окно Electron под Xvfb) — **61 ✅ / 0 ❌**.
- Заодно починена **устаревшая** проверка живого веб-теста: она ждала в рельсе 9 иконок,
  а их 10 — иконка «Миссия» приехала вместе с версиями 1.5.85–1.5.108. Падение было не от
  выноса (до правки цифра была та же), но живой набор обязан быть зелёным: число
  поправлено, и добавлена проверка видимости `#rail-mission`.

### Что дальше

Чат: размышления и сегменты ответа (1316 строк, ~20 правок тестов) — выносить по частям:
сначала блок размышлений, потом хронологический лог «текст → действия → текст». Дальше
настройки (916, ~32) и панель проекта (2554) с предварительным разделением хвоста событий
(7.1). Затем гиганты вне окна: `main.js` (5297, 73 канала IPC), `browser-tools.js` (3566),
`agent-tools.js` (2774), `agent-store.js` (1520), `yandex-cloud.js` (1204) и самый крупный
файл репозитория `test/smoke.test.js` (13 913 после этого этапа) — разбить по наборам.

  поправлено, и добавлена проверка видимости `#rail-mission`.

## Этап 3.7, часть 1: блок размышлений — свой модуль (1.5.110)

Разбор чата идёт по частям: сначала плашка «Размышление», потом хронологический лог
«текст → действия → текст». Первая часть сделана.

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 6847 строк | **6776** (−71) |
| `src/renderer/chat-thinking.js` (новый) | — | 114 строк |

Уехали: `thinkAutoScroll` (автопрокрутка вниз по мере роста текста, но не против
человека, который отлистал вверх читать ранее написанное) и `ensureThinkBox` (сборка
плашки: значок, заголовок, стрелка, тело; клик по заголовку сворачивает и помечает
блок как «ручной»; рост текста обновляет тело и едет вниз). Добавились две точки входа:
`collapseThinkBox` (автосворачивание по завершении ответа — из цикла оболочки) и
`restoreThinkBox` (возврат сохранённых размышлений после перезагрузки или переключения
чата). Наружу модуль отдаёт три функции; `thinkAutoScroll` остался внутренней.

**Сверка переноса** (скрипт, а не глаз): тело модуля совпало с прежней областью
**байт в байт**. Две новые точки входа — это тот же текст, только с параметрами:
`sEl` → `el`, `m.thinking` → `text`, `m.pending` → `pending`. Голых вызовов
вынесенных функций в `app.js` не осталось: три обращения идут через `ChatThinking.`.

### Что стоит помнить про эту часть

- `collapseThinkBox` получил собственные проверки на пустой элемент. В цикле оболочки
  их держал вызывающий (`if (!sEl) continue;`), а модуль — общая граница, и «свернуть
  то, чего нет» обязано быть тихим бездействием. Это единственное отклонение от
  «байт в байт», и оно проверено тестом.
- Живой прогон окна сразу показал ошибку в моей же проверке: `ChatThinking` — фабрика,
  значит в окне это `function`, а не `object`. Проверка в прогоне поправлена; сам
  модуль был в порядке (25 скриптов выполнялись, обработчики легли).
- Живой десктоп-прогон оставлял за собой живой Electron, если его вывод обрезать
  конвейером (`| head`): скрипт убивает приложение в `finally`, а обрыв потока
  прерывал работу раньше. Следующие прогоны цеплялись к старому окну и показывали
  чужие дела и чужой журнал — девять «падений», которых нет. Перед прогоном убирать
  зависшие процессы и не обрезать вывод.

### Проверки

- `npm test`: smoke **482/0** (+1 тест блока размышлений), field-guard 15/0, ВК 8/0,
  QR 7/0, mobile-pair 7/0, repo-shape 9/0 — итого **528 ✅ / 0 ❌**.
- Новый поведенческий тест `testChatThinking` собирает плашку на заглушке DOM, которая
  ищет элементы по классу, как браузер, и проверяет: сборку из заголовка и тела, место
  над пузырём ответа (и в конец сообщения, если пузыря ещё нет), рост текста с
  автопрокруткой, честную реакцию на ручную прокрутку (человек читает выше — не
  выдёргиваем, вернулись когда он снова у конца), клик по заголовку (сворачивание,
  пометка «ручное», повторный разворот с показом конца), автосворачивание по завершении
  ответа (и что блок, открытый человеком, автосворачивание не трогает), возврат
  сохранённых размышлений (свёрнуто, а у незакрытого ответа — раскрыто) и тихое
  бездействие при пустом элементе и пропавшем теле плашки.
- Одна старая проверка искала код размышлений в `app.js` (цена выноса — одна правка):
  переведена на модуль, а сама поведенческая часть теста (`uiFind` + запуск настоящего
  кода `thinkAutoScroll`) заработала без правок — она ищет код по содержимому интерфейса.
- Живой прогон окна: телефону отданы **29 файлов** разметки (включая
  `/chat-thinking.js` — 4736 байт), выполнились **25 скриптов** в порядке тегов.
  **Негативный контроль**: без тега `chat-thinking.js` прогон даёт 27 провалов —
  `app.js` падает с `window.ChatThinking is not a function`.
- Живые прогоны: `bun run test:live` — **60 ✅ / 0 ❌**;
  `bun run test:live:desktop` (Electron под Xvfb, без обрезки вывода) — **61 ✅ / 0 ❌**.
- OTA-бандл: **1.5.120**, 79 файлов (+1), 62 JS проверены при сборке.
  Версия приложения — **1.5.110**.

### Что дальше (вторая часть этапа 3.7)

Хронологический лог «текст → действия → текст»: сегменты ответа (`ensureSegmentForText`,
`removeSegment`, `runSegments`) и отрисовка сообщений вокруг них. Это сердце чата,
поэтому вынос идёт отдельным заходом, с полным прогоном после.

поэтому вынос идёт отдельным заходом, с полным прогоном после.

## Этап 3.7, часть 2: сегменты ответа — свой модуль (1.5.111)

Хронологический лог «текст → действия → текст → …» вынесен целиком: три функции,
44 строки.

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 6776 строк | **6743** (−33) |
| `src/renderer/chat-segments.js` (новый) | — | 83 строки |

Уехали: `ensureSegmentForText` (текст после действия открывает НОВОЕ сообщение ниже
блока действий, а не дописывается в пузырь сверху), `removeSegment` (убрать пустой
сегмент из данных, из DOM и из сессии) и `runSegments` (все assistant-сегменты текущего
запуска по порядку). Семь вызовов в оболочке переведены на модуль.

**Сверка переноса** (скрипт, а не глаз): после снятия трёх добавленных строк
`const sess = getSession();` и возврата прежнего имени тело модуля совпало с прежней
областью **байт в байт**. Доступ к общему состоянию изменился ровно в пяти местах:
сессия запуска читается живой функцией `getSession()` (копия устарела бы молча —
сессию переписывают на каждом запуске). Восемь зависимостей модуля: `$`, `uid`,
`getSession`, `msgEls`, `buildMessageEl`, `scrollBottom`, `persistChatsSoon`,
`planRoundStarted`.

### Что поймали проверки (две правки, обе ожидаемые)

- Проверка «новый раунд ответа не двигает галочки текстового плана» искала строку
  `planRoundStarted(chat, seg.id);` прямо в `app.js` — переведена на `uiAll()`.
- Игрушечная среда плана (тест собирает срез оболочки в `new Function`) знала только
  свою заглушку `runSegments`. Теперь она отдаёт контракт сегментов целиком — иначе
  срез падал бы с `ChatSegments is not defined`.
- Новый тест `testChatSegments` сначала падал сам: массив, собранный ВНУТРИ песочницы
  `vm`, имеет другой прототип, и `deepStrictEqual` ругается на «same structure but not
  reference-equal» — то есть на природу значения, а не на порядок сегментов. В тесте
  результат приводится к своему массиву через `Array.from`, и сравнение снова про смысл.

### Проверки

- `npm test`: smoke **483/0** (+1 тест сегментов), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 9/0 — итого **529 ✅ / 0 ❌**.
- Новый поведенческий тест запускает модуль в песочнице и проверяет: текст без действия
  дописывается в текущий сегмент; текст ПОСЛЕ действия создаёт новое сообщение в конец
  (пустое, незавершённое, с отметкой нового раунда для плана, элементом в ленте и
  прокруткой); сессия читается ЖИВОЙ (объект подменили снаружи — модуль увидел новый);
  чужой сегмент не трогается; пустой сегмент убирается из истории, из карты элементов,
  из DOM и из сессии, с сохранением истории; сегменты запуска собираются по порядку id,
  а без сессии и без сегментов отдаётся запасной; негативный контроль зависимостей.
- Живой прогон окна: телефону отданы **30 файлов** разметки (включая
  `/chat-segments.js` — 3358 байт), выполнились **26 скриптов** в порядке тегов.
  **Негативный контроль**: без тега `chat-segments.js` прогон даёт 27 провалов.
- Живые прогоны: `bun run test:live` — **60 ✅ / 0 ❌**;
  `bun run test:live:desktop` — **61 ✅ / 0 ❌** (вывод в файл, без обрезки конвейером).
- OTA-бандл: **1.5.121**, 80 файлов (+1), 63 JS проверены при сборке.
  Версия приложения — **1.5.111**.

### Что дальше

Осталось в окне: отрисовка сообщений и кусок работы агента (`buildMessageEl`, `msgHtml`,
`buildBubbleEl`, `renderMessages`, `queueBubbleRender`, `ensureWorkGroup`), затем
настройки (916 строк, ~32 правки тестов) и панель проекта (2554) с предварительным
разделением хвоста событий (7.1). Потом гиганты вне окна: `main.js` (5296, 73 канала
IPC), `browser-tools.js` (3566), `agent-tools.js` (2774), `agent-store.js` (1520),
`yandex-cloud.js` (1204) и разбиение `test/smoke.test.js` (14 220 строк) по наборам.

`yandex-cloud.js` (1204) и разбиение `test/smoke.test.js` (14 220 строк) по наборам.

## Этап 3.7, часть 3: отрисовка сообщения — свой модуль (1.5.112)

Третья часть разбора чата: как одно сообщение превращается в элемент ленты.

| Файл | Было | Стало |
|---|---|---|
| `src/renderer/app.js` | 6742 строки | **6667** (−75) |
| `src/renderer/chat-render.js` (новый) | — | 116 строк |

Уехали: `msgText` (содержимое сообщения → текст, в том числе из частей-вложений),
`msgHtml` (markdown плюс картинки-вложения отдельными блоками) и `buildBubbleEl`
(пузырь с классами ошибки и незавершённости, метка времени, плашка размышлений,
кнопка «Дописать ответ» у прерванного хода и кнопки действий — скопировать,
перегенерировать, править). Пять вызовов в оболочке переведены на модуль.

**Сверка переноса**: оба куска (текст и пузырь) совпали с прежним состоянием
**байт в байт**. Проверял не по памяти и не по git: предыдущее состояние `app.js`
взято из OTA-бандла 1.5.121 — это точный снимок «до». Приём удобный: бандл всегда
лежит рядом и после каждой сборки равен диску (это отдельно проверяется).

### Найденная ошибка: «голое» имя вместо моста

`buildBubbleEl` звал продолжение прерванного ответа так:
`continueInterruptedAnswer(m.chatId || chatsData.activeId, m)`. При переносе
`chatsData` остался жить в оболочке, и модуль ссылался на имя, которого у него нет:
у человека это упало бы с `ReferenceError` ровно при нажатии «Дописать ответ».
Ни синтаксическая проверка, ни структурные тесты этого не видели — их никто не
водил в эту ветку. Исправлено на `getChatsData().activeId` (живая функция в проводке).

**Чтобы это не повторилось**, в новом тесте есть дешёвая родня бэкенд-стража
(`backend-wiring.js`): модуль не имеет права упоминать `chatsData`, `session`,
`streaming`, `msgEls`, `pinnedToBottom` — только получать их через deps. Негативный
контроль: с возвращённой ошибкой тест падает с «модуль ссылается на chatsData без
внедрения», после возврата — зелёный.

### Проводка и порядок

`ChatActions` создаётся в оболочке ниже места, где лежала отрисовка, а модуль получает
его целиком (кнопки под сообщением). Поэтому проводка `ChatRender` поставлена **после**
действий чата — и это отдельно проверяется тестом (`wiringAt > actionsAt`). Обратная
сторона разорвана живой стрелкой: действия чата получают `msgText` как
`(c) => ChatRender.msgText(c)`, а не копией функции.

### Проверки

- `npm test`: smoke **484/0** (+1 тест отрисовки), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 9/0 — итого **530 ✅ / 0 ❌**.
- Новый поведенческий тест `testChatRender` запускает модуль в песочнице с заглушкой DOM
  и проверяет: текст из строки, из частей и мусора; экранирование адреса картинки;
  классы ошибки и незавершённого ответа; отсутствие кнопок у ошибки и у идущего ответа;
  markdown, метку времени и плашку размышлений у обычного ответа; кнопки «скопировать»,
  «перегенерировать» (только у последнего ответа), «править» у своего сообщения —
  каждая нажатием, а не по названию; прерванный ход уходит в главный процесс с ЖИВЫМИ
  данными чатов и с учётом своего чата у сообщения; негативный контроль зависимостей.
- Три старые проверки искали код в `app.js` (цена переноса — три правки): кнопка
  «Дописать ответ», срез стрима (получил заглушку модуля) и мой же тест размышлений
  (возврат плашки теперь зовёт модуль отрисовки). Прямых чтений `app.js` не прибавилось.
- Живой прогон окна: телефону отданы **31 файл** разметки (включая `/chat-render.js` —
  4819 байт), выполнились **27 скриптов**. **Негативный контроль**: без тега
  `chat-render.js` прогон даёт 27 провалов.
- Живые прогоны: `bun run test:live` — **60 ✅ / 0 ❌**; `bun run test:live:desktop` —
  **61 ✅ / 0 ❌**.
- Заодно починена **гонка** в живом десктоп-прогоне: проверка свежести кода спрашивала
  `window.AgentCore` сразу после подключения к отладке, а на «холодном» профиле страница
  ещё разбирала скрипты — выходило ложное «к отладке подключился старый экземпляр».
  Теперь она ждёт появления ядра (до 15 с), и падение снова означает падение.
- OTA-бандл: **1.5.122**, 81 файл (+1), 64 JS проверены при сборке.
  Версия приложения — **1.5.112**.

### Что дальше

Осталось в окне: кусок работы агента (`ensureWorkGroup`, `queueBubbleRender`,
`renderMessages`, лента и её прокрутка) и инструменты строки действий; затем настройки
(916 строк, ~32 правки тестов) и панель проекта (2554) с предварительным разделением
хвоста событий (7.1). Потом гиганты вне окна: `main.js` (5296, 73 канала IPC),
`browser-tools.js` (3566), `agent-tools.js` (2774), `agent-store.js` (1520),
`yandex-cloud.js` (1204) и разбиение `test/smoke.test.js` по наборам.

---

## Этап 3.7, часть 4: лента — прокрутка и очередь кадра (1.5.113)

Из окна уехал последний кусок чата, который отвечает за ленту целиком: умная прокрутка и
экономия кадров при стриме. Они и правда ходят вместе — очередь кадра в конце каждого
кадра зовёт именно `scrollBottom`, а «умная» логика решает, ехать ли вниз.

| Файл | Было строк | Стало строк |
|---|---|---|
| `src/renderer/app.js` | 6666 | **6613** (−53) |
| `src/renderer/chat-feed.js` (новый) | — | **93** |

Уехали: `scrollBottom` (вниз — только если человек у конца ленты), `updatePinState`
(порог 90 px и плавающая кнопка «↓»), `jumpToBottom` (ручной возврат в конец),
`queueBubbleRender` (два чанка — одна перерисовка, рисуется последнее состояние) и
`scrollBottomSoon` (отложенная прокрутка размышлений, тоже не чаще кадра). Модуль отдаёт
пять функций и просит три зависимости: `$`, `msgEls`, `msgHtml`.

**Сверка переноса:** тело совпало с прежним участком **байт в байт**, отличается ровно одна
строка — рендер содержимого берётся из deps (`ChatRender.msgHtml` → `msgHtml`). «Голых»
ссылок в оболочке не осталось: 14 обращений, все через `ChatFeed.`. Кусок брал снаружи
ровно три имени — это проверено скриптом выноса до записи (плюс число обращений к DOM и к
карте элементов сообщений), и он же падает, если границы сдвинулись.

### Порядок проводки — то же правило, что у отрисовки

`msgHtml` передаётся **стрелкой** `(c) => ChatRender.msgHtml(c)`: отрисовка сообщения
собирается НИЖЕ ленты, и копия функции на этом месте была бы пустой — упало бы при первом
же чанке. Тест проверяет и порядок сборки (`ChatFeed` выше `ChatRender`), и саму стрелку.
Обратная сторона: сегменты ответа получают прокрутку ссылкой `scrollBottom: ChatFeed.scrollBottom`
(функция не меняется — копия не устареет).

### Проверки

- `npm test`: smoke **485/0** (+1 тест ленты), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 9/0 — итого **531 ✅ / 0 ❌**.
- Новый поведенческий тест `testChatFeed` запускает модуль в песочнице и проверяет
  ПОВЕДЕНИЕ: набор отдаваемых функций; у конца ленты — держимся вниз и кнопка «↓» скрыта;
  человек читает выше — не выдёргиваем и кнопка показана; ручной возврат в конец и
  возобновление автопрокрутки; два чанка — ровно один кадр и последнее состояние; пузырь
  не перерисовывается до кадра; чанк без сообщения — молча и без висячего кадра; отложенная
  прокрутка тоже схлопывается в кадр и уважает чтение выше; негативный контроль двух
  зависимостей (`$` и `msgHtml`) — забытая даёт понятную ошибку с именем зависимости.
- Тест стрима перестал собирать вырезку из `app.js` и берёт модуль целиком той же фабрикой,
  что и приложение: проверяется настоящий код, а не копия в тесте. Обработчики стрима в
  оболочке проверяются по `ChatFeed.queueBubbleRender` и `ChatFeed.scrollBottomSoon`.
- В песочницу модуля проброшен `requestAnimationFrame` (в `vm` его нет) — кадрами
  распоряжается тест. Это нашлось первым же прогоном: «requestAnimationFrame is not defined».
- Живой прогон окна: выполнились **28 скриптов** из разметки, `ChatFeed` в окне —
  функция. **Негативный контроль**: без тега `chat-feed.js` `app.js` падает с
  `window.ChatFeed is not a function`, прогон валится целиком.
- Живые прогоны: `bun run test:live` — **60 ✅ / 0 ❌**; `bun run test:live:desktop` —
  **61 ✅ / 0 ❌**.
- OTA-бандл: **1.5.123**, **82 файла** (+1), 65 JS проверены при сборке, все 82 файла
  сверены с диском — расхождений 0. Версия приложения — **1.5.113**.

### Что дальше

Осталось в окне: работа агента и строка действий (`renderMessages` — 1027, `buildToolEl` —
1303, `ensureWorkGroup` — 1396, `planAdd` — 1442; вместе с окружением ~471 строка
до строки 1470), затем **настройки** (916 строк, ~32 правки тестов) и **панель проекта**
(2554) с предварительным разделением хвоста событий (7.1). Потом гиганты вне окна:
`main.js` (5296, 73 канала IPC), `browser-tools.js` (3566), `agent-tools.js` (2774),
`agent-store.js` (1520), `yandex-cloud.js` (1204) и разбиение `test/smoke.test.js`
по наборам. Отдельно — производственная безопасность деплоя (4 пункта, ещё не сделано).

---

## Петля миссий: «продолжай — нет, ты продолжай» (1.5.114)

Человек описал так: агент трижды подряд присылал один и тот же отчёт, закрывал миссию —
а она снова его дёргала, и в панели висела незакрытой. Разбор по коду дал точную цепочку,
и она оказалась не в модели, а в приложении.

### Что происходило на самом деле

1. Прогон заканчивался текстом, не вызывая `missionFinish`. Приложение подталкивало
   модель: «миссия не закрыта — продолжай делом» (до **трёх** раз за прогон). Модель
   отвечала тем же отчётом — человек видел три-четыре одинаковых «Готово».
2. После третьего призыва приложение ставило миссию **на паузу** («агент остановился,
   не закрыв миссию»).
3. Дальше начиналось главное: `missionRead()` брал `missionStore.missionActive()` —
   то есть **любую** незакрытую миссию, включая паузы и миссии ДРУГИХ чатов. Следующий
   прогон (даже обычный вопрос) подхватывал эту паузу, объявлял «▶ продолжаю миссию» и
   снова призывал. Петля не кончалась никогда, а закрытие одной миссии просто открывало
   следующую старую паузу — «закрывает, а она снова дёргает».
4. Новая миссия с той же целью появлялась в панели как новая запись: приложение заводит
   миссию само, если работа идёт больше 6 раундов (`missionEnsure`, цель — последняя
   просьба). В чате автозадач это тот же текст задания — «миссия опять появилась».
5. Инструменты агента без id (`missionStep`, `missionFinish`, `missionStatus`) работали
   с самой свежей незакрытой миссией, а не с миссией прогона: можно было закрыть чужую.

### Что сделано

**Новый модуль `src/mission-guard.js`** — чистые решения, без диска и состояния:

| Функция | Правило |
|---|---|
| `adoptable(rec, {chatId})` | продолжать самому можно только **живую** миссию (`active`) и только **своего чата**; пауза, закрытая и чужая — нет |
| `pickAdopted(list, ctx)` | первая подходящая из списка (пауза, лежащая выше, больше не перебивает живую работу) |
| `nudgeStep(state)` | один призыв на первый текстовый ответ; дальше — только если работа сдвинулась. Повтор того же ответа или стояние на месте → **пауза** («жду человека»), потолок призывов → пауза |
| `nudgeText(args)` | в призыве есть **id миссии**, прямое «не пересказывай отчёт — вызови missionFinish(report, done)» и честное «дальше напоминать не буду» |

**Проводка в `src/main.js`:**
- `missionRead()` больше не берёт «любую незакрытую»: только `missionGuard.pickAdopted` по
  текущему чату. Просьба человека (кнопка «▶ Продолжить») сильнее правил — она запоминается
  в `missionClaim` и следующий прогон берёт именно эту миссию.
- Призывы решает `missionGuard.nudgeStep`, текст — `missionGuard.nudgeText`. Условие
  `(active || paused)` убрано и здесь, и в двух соседних местах: пауза больше не повод
  приставать.
- Миссия прогона видна инструментам: `runMissionId` через мост `activeRunMissionId`.
- `mission:resume` возвращает миссию в работу (`active`, `finishedAt: 0`) и отдаёт её чат;
  панель продолжает работу в ТОМ чате, где миссия живёт (раньше — в открытом).

**Инструменты (`src/agent-tools.js`):** помощник `missionOfRun(dir)` — `missionStep`,
`missionFinish` и `missionStatus` без id работают с миссией своего прогона, а к «самой
свежей незакрытой» откатываются только если прогон миссию не ведёт.

**Промпт (`src/renderer/prompts.js`, правило 15):** «Отчёт по ОДНОЙ И ТОЙ ЖЕ работе
присылается один раз: если итог уже отправлен, а миссия закрыта — не пересказывай его и не
повторяй missionFinish, ответь одной строкой».

**Кнопка «🏁 Закрыть» в панели «Миссия»** (человек не мог закрыть миссию руками — только
пауза, продолжение и стоп прогона): главный процесс закрывает её как `stopped` с причиной
«закрыто человеком», мосты в окне и на телефоне, во время прогона кнопка отказывает вслух.

### Проверки

- `npm test`: smoke **490/0** (+5), field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0,
  repo-shape 9/0 — итого **536 ✅ / 0 ❌**.
- Новый `testMissionGuard`: правила подхвата (включая «пауза не подхватывается»), решения
  призывов, петля целиком как её видел человек (повтор отчёта → **один** призыв и пауза),
  текст призыва, работа сторожа с настоящим `mission-store` на диске, и стражи проводки
  (main.js спрашивает сторожа, а не решает сам; инструменты работают со своей миссией).
- Живое нажатие в наборе панели: `btn-mission-finish` закрывает ИМЕННО показанную миссию,
  во время прогона отказывает вслух, а закрытая больше не считается незакрытой.
- **Живая проверка на настоящем приложении** (Electron под Xvfb, фейковый провайдер отвечает
  текстом «Готово.» и миссию не закрывает) — восемь новых проверок раздела [12]:
  призыв прозвучал **один раз** (а не трижды), повтор того же отчёта остановил призывы
  («модель повторила тот же ответ»), миссия ушла в паузу, **следующий прогон паузу не
  подхватил** (события `resume` нет), закрытая миссия больше не всплывает.
  Итог живых наборов: окно — чисто (28 скриптов, обработчик `btn-mission-finish` на месте),
  веб — **60 ✅ / 0 ❌**, десктоп — **69 ✅ / 0 ❌** (было 61).
- OTA-бандл **1.5.125**, 83 файла, 66 JS проверены при сборке, все файлы сверены с диском —
  0 расхождений. Версия приложения — **1.5.114**.

### Что стоит помнить

- Пауза теперь означает «жду человека» **везде**: и при выборе миссии, и в призывах. Если
  понадобится «продолжай паузу сам» — это осознанное решение, а не случайность: раньше именно
  оно и заводило петлю.
- `missionStore.missionActive()` (любая незакрытая) осталась для панели и кнопок человека
  — это её законное место. Прогон её больше не спрашивает.
---

## Этап 3.7, часть 5: строки действий и группа работ — свой модуль (1.5.115)

Последний кусок чата, который держался в окне: как из сообщения инструмента получается
компактная строка действия и как строки складываются в группу «Выполняю действия · N».
Это один предмет, а не два: группа — это ровно те же строки, только собранные вместе.

| Файл | Было строк | Стало строк |
|---|---|---|
| `src/renderer/app.js` | 6616 | **6235** (−381) |
| `src/renderer/chat-work.js` (новый) | — | **445** |

Уехали: словари значков и подписей инструментов (`TOOL_ICON`, `TOOL_LABEL`),
`toolTargetOf` (что именно затронуто: путь, адрес, файл) и `toolArgsPreview` (краткая суть
аргументов), `buildToolEl` (строка действия: значок, подпись, цель, состояние, подробности),
группа работ (`ensureWorkGroup`, `addRow`, `finishGroup`, `resetGroup`) и план хода
(`turnPlan`, `planAdd`, `planSet`, `updatePlanTitle`). Модуль просит три зависимости:
`$`, `isElectron`, `openFile` (проводка — `openToolFile`).

**Сверка переноса:** 381 строка тела совпала с прежним участком **байт в байт**;
осознанных отличий ровно **два** (сравнение нормализует текст и печатает список отличий):

1. `const a = (t && t.args) || {}` → `(t && (t.toolArgs || t.args)) || {}`.
2. `openToolFile(target)` → `openFile(target)` (зовём внедрённую зависимость, а не ищем
   функцию в оболочке).

### Найденная ошибка: строка действия не показывала путь

При написании поведенческого теста выяснилось, что **путь к файлу и ссылка на него
не показывались никогда**: строка читала `m.args`, а сообщения инструментов несут
`toolArgs`. Это не следствие переноса — ошибка жила в коде до него, и ни синтаксис,
ни структурные тесты её не видели, потому что проверяли наличие строки, а не поведение.
Теперь строка показывает и подробности, и ссылку на файл; тест проверяет это нажатием,
а не регуляркой по исходнику.

### Проверки

- `npm test`: smoke **491/0**, field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0,
  repo-shape 9/0 — итого **537 ✅ / 0 ❌**.
- Цена переноса в тестах оказалась дешевле прогноза: **5 старых проверок** (6 строк)
  искали значки и подписи прямо в `app.js` — переведены на интерфейс окна целиком
  (`uiAll()`), где эти файлы теперь и живут. Плюс один новый поведенческий тест.
- Новый тест `testChatWork` запускает модуль в песочнице и проверяет ПОВЕДЕНИЕ: строка из
  сообщения инструмента (значок, подпись, цель), ссылка на файл появляется только у пути
  внутри проекта и нажимается, состояние «идёт / сделано / ошибка», подробности раскрываются,
  группа «Выполняю действия · N» считает строки, закрывается по концу ответа и начинается
  заново, план хода обновляется на месте, забытая зависимость даёт понятную ошибку.
  Отдельно проверяются границы: модуль не упоминает `chatsData`, `session`, `streaming`,
  `msgEls`, `projectDir`, `viewFile` и `window.` — только через deps.
- Живой прогон окна: **29 скриптов** из разметки, `ChatWork` в окне — функция.
  **Негативный контроль**: без тега `chat-work.js` `app.js` падает с
  `window.ChatWork is not a function` (плюс 27 вакансий обработчиков), прогон валится.
- Живые прогоны: `bun run test:live` — **60 ✅ / 0 ❌**; `bun run test:live:desktop` —
  **69 ✅ / 0 ❌**.
- OTA-бандл **1.5.126**, **84 файла** (+1), 67 JS проверены при сборке, все 84 файла
  сверены с диском — 0 расхождений. Версия приложения — **1.5.115**.

### Что дальше

В окне остались настройки (916 строк, ~32 правки тестов — самый дорогой кусок) и панель
проекта (2554, но всего 4 правки тестов, зато нужен шаг 7.1 — разделение хвоста событий).
Потом гиганты вне окна: `main.js` (73 канала IPC), `browser-tools.js`, `agent-tools.js`,
`agent-store.js`, `yandex-cloud.js` и разбиение `test/smoke.test.js` по наборам.
Отдельно — производственная безопасность деплоя (4 пункта, ещё не сделано).
---

## Этап 3.8, часть 1: поиск по настройкам — свой модуль (1.5.116)

Настройки — самый дорогой по проверкам кусок окна (916 строк), и резать их целиком
нельзя. Первой уходит самая обособленная часть: поиск по настройкам. У него нет
своих данных — только дерево разметки и одно число состояния (последняя вкладка).

| Файл | Было строк | Стало строк |
|---|---|---|
| `src/renderer/app.js` | 6235 | **6152** (−83) |
| `src/renderer/settings-search.js` (новый) | — | **118** |

Уехали: `settingsSearchInput`, `settingsSearchActive`, `settingsSearchReset`,
`settingsFieldText` (подпись + подсказки + placeholder и title контролов — поэтому
«sk-», «пароль» и «замерить» находятся даже там, где этих слов нет в подписи) и
`settingsSearchApply` (фильтр по всем вкладкам: совпадение в свёрнутой карточке
раскрывается, пустые вкладки скрываются, результаты подписываются категорией, при
нуле совпадений — честное сообщение). Модуль просит две вещи: `$` и `getLastTab`.

**Сверка переноса:** тело совпало с прежним участком **байт в байт** (4054 байта,
83 строки) — отличается ровно одно выражение: `lastSettingsTab` → `getLastTab()`.
Скрипт выноса падает до записи, если сдвинулись якоря, изменился состав функций,
кусок потянулся за чужим именем состояния или в оболочке остался голый вызов.
Все четыре точки вызова в оболочке переведены на модуль: переключение вкладок
(там поиск сбрасывается), ввод в поле, Esc и кнопка очистки.

### Порядок проводки: раньше первого спрашивающего

Здесь обычного правила «проводка там, где лежал код» мало: о состоянии поиска
спрашивает переключение вкладок, а оно может случиться раньше того места. Поэтому
`SettingsSearch` собран сразу после объявления последней вкладки — до первого
спрашивающего. Заодно `getLastTab` передаётся стрелкой: переменную переписывает
переключение вкладок, копия устарела бы молча.

### Проверки

- `npm test`: smoke **491/0**, field-guard 15/0, ВК 8/0, QR 7/0, mobile-pair 7/0,
  repo-shape 9/0 — итого **537 ✅ / 0 ❌**. Новых тестов не потребовалось: правлены
  два существующих, причём обе правки — по делу.
- Проверка «поиск по всем вкладкам» искала код прямо в `app.js` (пять строк) — теперь
  читает модуль, а от оболочки требует ровно одного: что ввод идёт в `SettingsSearch.apply`.
- Тест логики поиска больше не вырезает функцию из `app.js` (приём всегда был хрупким:
  вырезка ломается от любой правки вокруг), а берёт модуль с диска целиком и собирает
  его ТОЙ ЖЕ фабрикой, что и приложение. Проверяется настоящий код.
- В тот же тест добавлены границы модуля (не упоминает `chatsData`, `session`,
  `streaming`, `msgEls`, `currentPreset`, `PRESETS`, `projectDir`) и негативный контроль
  зависимости: без `$` поиск падает понятной ошибкой.
- **Два негативных контроля:** убран тег модуля из разметки — `app.js` падает с
  `window.SettingsSearch is not a function`; в модуль подложена ссылка на `chatsData` —
  тест падает точным сообщением «модуль поиска ссылается на chatsData без внедрения».
  Второй контроль сначала срабатывал не тем местом (падение при сборке фабрики, а не
  проверка границ), поэтому ссылка подложена внутрь функции — и поймала именно сторож.
- Живой прогон окна: **30 скриптов** из разметки, `SettingsSearch` в окне — функция.
- Живые прогоны: `bun run test:live` — **60 ✅ / 0 ❌**; `bun run test:live:desktop` —
  **69 ✅ / 0 ❌**.
- OTA-бандл **1.5.127**, **85 файлов** (+1), 68 JS проверены при сборке, все 85 файлов
  сверены с диском — 0 расхождений. Версия приложения — **1.5.116**.

### Мелочи, которые стоит помнить

- `vm` в `test/smoke.test.js` не общий: он подключается локально в каждой функции.
  Новый код, собирающий модуль, обязан сделать `const vm = require("vm")` сам.
- Сторож «кусок не тянется за чужим именем» сам оказался слишком широким: имя `settings`
  совпадало с собственными идентификаторами разметки (`settings-search`). Проверка сужена
  до имён состояния — но это хороший урок: сторож тоже нужно проверять негативным контролем.
- Поиск по настройкам и поиск по чату (`isJunkSearchValue`) — разные вещи, общего у них
  только слово. Второй остаётся в оболочке.

### Что дальше в настройках

Следующие части того же этапа: вкладки и сохранённые OpenAI-подключения
(`setPreset`, `fillSettingsUI`, `collectSettingsFromUI`, `openaiProfilesArr`,
`renderOpenaiProfiles`, `applyOpenaiProfile`, `saveOpenaiProfileFromFields`,
`deleteOpenaiProfile`, `profileNameFromUrl`), карточка замера модели (`renderModelHints`,
`renderProbeResult`, `refreshProbeButton`, `renderVisionDetect`) и сохранение с показом
`setSettingsMsg`, `saveSettingsUI`, `toggleKey`. Затем панель проекта (нужен шаг 7.1 —
разделение хвоста событий) и гиганты вне окна.
---

## Этап 3.8, часть 2: сохранённые OpenAI-подключения — свой модуль (1.5.117)

Второй кусок настроек, который держится сам за себя: несколько ключей OpenAI-
совместимых сервисов, переключение между ними в один выбор и удаление с
подтверждением. Своих данных у него нет — только поля разметки и список подключений
внутри настроек.

| Файл | Было строк | Стало строк |
|---|---|---|
| `src/renderer/app.js` | 6152 | **6067** (−85) |
| `src/renderer/openai-profiles.js` (новый) | — | **127** |

Уехали: `profileNameFromUrl` (имя подключения по адресу), `openaiProfilesArr`
(список с защитой от мусора в настройках), `renderOpenaiProfiles` (выпадающий список
с пометкой «(без ключа)»), `applyOpenaiProfile` (перенос значений в поля и подсветка
пресета), `saveOpenaiProfileFromFields` (новое подключение с номером при совпадении
имени или обновление выбранного) и `deleteOpenaiProfile`. Модуль просит шесть вещей:
`$`, `uid`, `getSettings`, `PRESETS`, `persistSettings`, `setSettingsMsg`.

**Сверка переноса:** тело совпало с прежним участком **байт в байт** (4201 байт);
отличается только чтение и запись настроек — `settings.` → `getSettings().` (11 мест).
Скрипт выноса падает до записи, если сдвинулись якоря, изменился состав функций,
кусок потянулся за чужим именем, обращения к настройкам вышли за два поля подключений
или в оболочке остался голый вызов. Все шесть точек вызова переведены на модуль.

### Порядок проводки: раньше веб-режима, но после функций

Проводка стоит **перед** сборкой веб-режима: тот берёт список подключений своим входом
(`OpenaiProfiles.arr`), и ссылка на ещё не собранный модуль была бы пустой. При этом её
зависимости — `persistSettings` и `setSettingsMsg` — объявлены ниже по файлу: это
безопасно, потому что обе объявлены как функции (поднимаются целиком), а настройки
передаются стрелкой. Тест проверяет порядок двух проводок явно.

### Проверки

- `npm test`: smoke **492/0** (+1 новый тест), field-guard 15/0, ВК 8/0, QR 7/0,
  mobile-pair 7/0, repo-shape 9/0 — итого **538 ✅ / 0 ❌**.
- Новая проверка запускает модуль той же фабрикой, что и приложение, и проверяет
  ПОВЕДЕНИЕ: имя по адресу (домен, без `www`, честная замена при мусоре), сохранение
  нового подключения, повторное сохранение обновляет выбранное, а не плодит копии,
  «Новое подключение» с тем же адресом получает номер, обновление выбранного из списка,
  отказ при пустом адресе (словами и без записи), перенос значений в поля при выборе,
  удаление с подтверждением и отказом, запрет удалять «Новое подключение», забытый `$`
  даёт понятную ошибку.
- Первая версия теста ожидала номер `#2` при простом повторном сохранении — а приложение
  так не делает: после записи подключение становится активным в списке, и следующее
  сохранение его же и обновляет. Поведение верное, ожидание в тесте было моё. Теперь
  проверяются оба случая, и это ровно то, что делает человек в окне.
- Живая проверка веб-режима (в наборе про web-chat) теперь требует `OpenaiProfiles.arr`
  и следит за порядком сборки: подключения обязаны собираться раньше веб-режима.
- **Два негативных контроля:** убран тег модуля — `app.js` падает с
  `window.OpenaiProfiles is not a function`; в модуль подложена ссылка на `chatsData` —
  тест падает точным «модуль ссылается на chatsData без внедрения».
- Живой прогон окна: **31 скрипт** из разметки, `OpenaiProfiles` в окне — функция.
- Живые прогоны: `bun run test:live` — **60 ✅ / 0 ❌**; `bun run test:live:desktop` —
  **69 ✅ / 0 ❌**.
- OTA-бандл **1.5.128**, **86 файлов** (+1), 69 JS проверены при сборке, все 86 файлов
  сверены с диском — 0 расхождений. Версия приложения — **1.5.117**.

### Мелочи, которые стоит помнить

- Проверка «в оболочке не осталось голого вызова» сначала ругалась на саму проводку:
  имя модуля в списке зависимостей (`openaiProfilesArr: OpenaiProfiles.arr`) — это ключ
  объекта, а не вызов. Проверка сужена до употребления без двоеточия. Сторож тоже
  нуждается в проверке.
- Образцы точек вызова ищутся после вырезания куска: внутри модуля вызовы друг друга
  остаются как есть, и «ровно один раз» до вырезания не выполняется.

### Что дальше в настройках

Остались: вкладки и заполнение полей (`setPreset`, `fillSettingsUI`,
`collectSettingsFromUI`, `setProviderUI`), карточка замера модели (`renderModelHints`,
`renderProbeResult`, `refreshProbeButton`, `renderVisionDetect`), сохранение настроек
(`saveSettingsUI`, `setSettingsMsg`, `toggleKey`) и открытие панели (`openSettings`).
Затем панель проекта (сначала шаг 7.1 — разделение хвоста событий) и гиганты вне окна.
---

## Лента падала при перерисовке: почему «в чате пусто» (1.5.118)

Человек описал так: «в чате не отображается мышление модели, не включается план и его
действия, не видно вообще ничего; ответ агента вижу только в уведомлении, если не в
приложении». Это не «нет событий» и не «модель молчит»: падала перерисовка ленты.

### Что на самом деле происходило

1. Кнопка «↓» (`.scroll-bottom`) лежала **внутри** `#messages`.
2. `renderMessages` первым делом делает `wrap.innerHTML = ""` — то есть удаляет кнопку
   вместе с содержимым ленты.
3. Вынос ленты (этап 3.7, часть 4) заменил две строки подлинника
   (`pinnedToBottom = true; scrollBottom();`) на `ChatFeed.jumpToBottom()` — а тот трогает
   кнопку: `$("btn-scroll-bottom").classList.add(...)`.
4. На **непустой** истории рендер идёт дальше пустой ветки, доходит до этой строки и падает
   с `Cannot read properties of null (reading 'classList')`.
5. Исключение вылетает из `renderMessages()` в `.then()` загрузки состояния, и **весь
   остаток инициализации не выполняется** — в том числе `api.onAiEvent(onAiEvent)`.
   Окно живо, лента пуста, события прогона никуда не приходят: ни размышлений, ни действий,
   ни плана, ни миссий. Ответ приходит только уведомлением — его строит главный процесс,
   который от окна не зависит.

### Моя ошибка и вторая, старая половина

- Замена вызова — **моя ошибка при выносе**: тело модуля сверялось байт в байт, а точка
  вызова в перерисовке осталась за сверкой. Урок: сверять надо не только перенесённый
  код, но и все заменённые вызовы.
- Вторая половина — старая: кнопка внутри ленты удалялась при каждой перерисовке, поэтому
  и «умная прокрутка» работала только до первого рендера. Это не проявлялось, пока
  перерисовка не дёргала кнопку, — и рухнуло, когда начала.

### Исправление

- Кнопка «↓» вынесена **из** ленты в обёртку `#messages-wrap` (лента внутри неё пустая:
  `<div id="messages"></div>`). Обёртка берёт на себя прежнюю роль ленты в раскладке
  (`flex: 1; min-height: 0; position: relative`), поэтому вид не меняется.
- В модуле появился `pinBottom()` — «прыжок в конец без кнопки»: перерисовка зовёт именно
  его. `jumpToBottom()` (кнопка) остался для человека.
- Обращения к кнопке стали необязательными: нет элемента — прокрутка работает молча.
  Раньше любая разметка без кнопки (старый файл, окно телефона) валила ленту.

### Проверки

- Структурные: **538 ✅ / 0 ❌** (состав модуля, поведение `pinBottom`, отсутствие кнопки,
  пустая лента в разметке, перерисовка не дёргает `jumpToBottom`).
- **Новый раздел [13] живого десктоп-прогона**: непустая история открывается, кнопка
  «↓» на месте и снаружи ленты, ошибок страницы нет, а ответ агента доходит до окна —
  отправка идёт ЧЕРЕЗ ОКНО (ввод → «Отправить»), как у человека. Итог: **74 ✅ / 0 ❌**.
- **Негативный контроль воспроизвёл жалобу дословно**: вернул старую разметку и старый
  вызов — прогон выдал «кнопка «↓» не пережила перерисовку» и «ответ агента не дошёл до
  окна — за 30 с в ленте не появилось ответа» (72 ✅ / 2 ❌). После возврата правок — 74/0.
- Живые прогоны: окно — чисто, веб — **60 ✅ / 0 ❌**, десктоп — **74 ✅ / 0 ❌**.
- OTA-бандл **1.5.129** (86 файлов, все сверены с диском), версия приложения **1.5.118**.

### Почему это не поймали раньше

Живые наборы водят прогон через `window.api` напрямую, а лента — это путь ЧЕРЕЗ ОКНО.
Проверялось всё, кроме того, что видит человек. Теперь у живого десктоп-прогона есть
раздел, который набирает текст в поле, жмёт «Отправить» и смотрит в ленту — и отдельно
проверяет, что груз старой истории не гасит запуск окна.

### Что осталось из жалобы

Кнопки удаления миссии в панели нет — есть «🏁 Закрыть» (закрывает миссию, файлы остаются).
Удаление папки миссии с подтверждением — следующий шаг, если человек хочет чистить список.
---

## Удаление миссии человеком: кнопка, которой не было (1.5.119)

Из той же жалобы: «не вижу кнопку удалять миссию». Её и не было — в панели жили
«↻», «⏸ Пауза», «▶ Продолжить», «⏹ Стоп», «🏁 Закрыть» и «📂». Закрытая миссия уходила
в список прошлых и оставалась там навсегда: чистить список было нечем.

### Что сделано

- `src/mission-store.js`: `missionDelete(workDir, id)` — уносит папку миссии целиком
  (цель, план, журнал, отчёт). Идентификатор проверяется ДО удаления.
- `src/main.js`: канал `mission:delete`. Во время прогона по этой же миссии отказывает —
  агент держит её в памяти и продолжит писать; закрытые и прошлые удаляются свободно.
  После удаления память главного процесса очищается (`missionClaim`).
- `src/preload.js`: `missionDelete` — окно получает только этот вызов, без доступа к файлам.
- Панель (`index.html`, `tasks-mission.js`): кнопка «🗑 Удалить» в карточке миссии и «🗑»
  у каждой прошлой миссии. Обе спрашивают подтверждение (и называют миссию), обе
  отказывают во время прогона вслух, после успеха список обновляется.

### Найденная ошибка: русские буквы в идентификаторе

Первая версия сторожа проверяла идентификатор алфавитом `[A-Za-z0-9._-]` — и**отказывалась
удалять настоящие миссии**: слаги у них русские (`20260915-1030-черновик-на-удаление`).
Поймал это первый же прогон теста склада. Правильная проверка — не алфавит, а путь:
идентификатор обязан быть ОДНИМ сегментом (`mid === path.basename(mid)`), без разделителей,
`.` и `..`. Тогда и «../сосед» отвергается, и русские имена работают.

### Проверки

- Структурные: **540 ✅ / 0 ❌** (+2 теста). Склад: удаление уносит папку, `..`, `../сосед`,
  пустой и несуществующий идентификатор — отказ, а после удаления рабочая папка `.agent`
  цела. Проводка: кнопка в разметке, канал в главном процессе с отказом во время прогона,
  мост, обработчики обеих кнопок и подтверждение в каждом из них.
- **Живой десктоп [12] дополнен**: миссия удаляется ОТ ОКНА до диска — кнопка зовёт канал,
  канал убирает папку, панель больше не показывает миссию, а склад отказывает на «..».
  Итог: **77 ✅ / 0 ❌**.
- Живые прогоны: окно — чисто, веб — **60 ✅ / 0 ❌**.
- OTA-бандл **1.5.130** (86 файлов, все сверены с диском), версия приложения **1.5.119**.

### Что стоит помнить

- Удаление миссии необратимо и стирает журнал работы. Поэтому: подтверждение с именем
  миссии, отказ во время прогона и никакого «удалить всё» одной кнопкой.
- Идентификаторы миссий — русские слаги. Любая проверка «на безопасность имени» обязана
  это учитывать: проверять форму пути, а не набор символов.
---

## Аудит всех выносов сессии: были ли ещё подмены вызовов (1.5.120)

Вопрос человека после истории с кнопкой «↓»: «а не мог ли ты так же заменить и другое?»
Вопрос справедливый — выносов за сессию было восемь. Проверял не на память: написан
аудит (`scripts/audit-extractions.js`, `bun run audit:extract <до> <после> <модули…>`).

### Как устроена проверка

Берутся две ревизии `app.js` (до и после выноса) и модули, куда код переехал. Все строки,
которых в оболочке стало меньше, раскладываются на три группы:

1. **перенесено как есть** — строка нашлась в модуле дословно;
2. **переименование вызова** — после снятия имён модулей строка совпала с модулем;
3. **требует глаз** — всё остальное; каждая такая строка объясняется вручную.

Инструмент возвращает код 1, если третья группа не пуста: его можно ставить шлюзом.

### Что показал аудит

| Этап | Ушло из оболочки | Перенесено как есть | Требует глаз |
|---|---|---|---|
| 1.5.109–1.5.114 (пять выносов) | 385 | 341 | 36 |
| 1.5.115 (строки действий) | 375 | 365 | 10 |
| 1.5.116–1.5.117 (настройки) | 186 | 166 | 20 |

Все «требующие глаз» строки оказались одного из четырёх видов, и каждый вид проверен:

- **Переименования вызовов** (`scrollBottom()` → `ChatFeed.scrollBottom()` и ещё полтора
  десятка имён). Проверено машинно: у каждого имени голых вызовов в оболочке — **0**, все
  идут через модуль, и имя функции совпадает с прежним.
- **Доступ к общим данным** внутри переехавшего кода: `settings.` → `getSettings()`,
  `session.` → `getSession()`, `chatsData.` → `getChatsData()`. Все три — осознанные и
  записанные в заметках; у каждого модуля есть сторож «не упоминает чужое состояние».
- **Склейка двух строк в один вызов** — таких всего два, кроме случая с кнопкой:
  `ensureWorkGroup(); body.appendChild(el)` → `ChatWork.addRow(el)` (сверено: `addRow`
  делает ровно это и добавил проверку пустого элемента) и блок плашки размышлений →
  `ChatThinking.restoreThinkBox(wrap, m.thinking, m.pending)` (сверено построчно: тело
  модуля байт в байт равно перенесённому блоку).
- **Починка данных, найденная тестом**: `toolTargetOf` читал `m.args` вместо `toolArgs` —
  путь и ссылка на файл не показывались никогда. Это исправление ошибки, а не подмена.

**Других подмен не найдено.** Единственной настоящей была та, что уже исправлена.

### Что добавлено, чтобы это не повторилось

- `scripts/audit-extractions.js` (в `package.json` — `bun run audit:extract`).
- Новый сторож в «раскладке интерфейса»: каждый вызов «Модуль.имя(» в окне обязан
  существовать среди того, что модуль отдаёт наружу. Негативный контроль: подмена
  `ChatFeed.pinBottom()` на `ChatFeed.pinBottomX()` роняет проверку с точным сообщением.
- Правило в `ARCHITECTURE.md`: вызовы при выносе только переименовываются; подмена
  вызова другим (даже похожим) — отдельное решение, а не ход выноса; склейка строк в один
  вызов сверяется по коду модуля.
- В чек-лист выноса добавлена живая проверка **через окно** (ввод → «Отправить»), а не
  только через `window.api`: именно этот путь поломку и не видел.

Версия приложения — **1.5.120**, набор обновления — **1.5.131**.

## 1.5.121 — Дозор запуска: окно само говорит, что с ним не так

Жалоба, ради которой это сделано: «в чате пусто — ни размышлений, ни действий, ни
плана; ответ вижу только уведомлением, когда меня нет в приложении». Причину той
поломки нашли (падение перерисовки ленты на кнопке «↓» — см. раздел выше), но нашли
её ПО КОДУ. Человек всё это время видел пустое окно и не мог сказать, что именно
сломалось: падение уходило в консоль, которой в собранном приложении никто не видит.
Дозор закрывает ровно эту дыру — окно рассказывает о себе словами.

- `src/renderer/boot-guard.js` — подключается **первым** скриптом разметки (до
  `provider-config.js`) и отдаётся телефону: мобильный мост знает этот файл. Порядок
  принципиален: подписка должна встать раньше остальных скриптов, иначе падение при их
  загрузке пройдёт мимо дозора.
- Ловит три рода поломок: падение при загрузке (`error` **на окне и на документе**),
  сорванное обещание (`unhandledrejection`), не загрузившийся файл (ошибка ресурса —
  обычно неполный набор обновления, человек видит имя файла) и неполную сборку окна
  (нет узлов `#messages`, `#messages-wrap`, `#input`, `#btn-send`, `#plan-panel`,
  `#work-panel` или нет модулей `ChatFeed` и соседей) — проверка идёт после
  `DOMContentLoaded`, когда узлы уже есть.
- Плашка поверх окна собрана **встроенными стилями** — читаема даже при сломанной
  таблице стилей: причина, «Что именно», «Где» (файл и строка), «Версия кода» из
  OTA-статуса, стек и кнопки «Скопировать разбор» и «Закрыть». Повтор того же падения
  не размножается, после «Закрыть» дозор больше не мешает. Весь текст разбора отдаётся
  функцией `window.bootReport()` — его можно переслать как есть.
- Живой прогон нашёл в дозоре настоящую ошибку: подписка только на документ **не
  видела исключений работы окна** (падение в таймере или в обработчике) — их событие
  приходит на само окно, и до слушателя документа не доходит. Пока этого не исправили,
  проверка «падение показано человеку словами» падала на настоящем приложении.
- Проверки: 4 теста в smoke (решения + плашка на игрушечном DOM; модуль собирается в
  песочнице той же фабрикой, что и в окне) и 8 живых проверок в разделе **[14]**
  десктопного прогона (Electron): пропавший файл назван по имени, падение показано
  словами вместе с местом и версией кода, разбор копируется, плашка закрывается и не
  возвращается на следующую поломку. Прогон десктопа: **86 ✅ / 0 ❌**.
- Сборка: приложение **1.5.121**, набор обновления **1.5.132** (87 файлов, сверка набора
  с диском — 0 расхождений).

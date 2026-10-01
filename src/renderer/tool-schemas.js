"use strict";

/* Таблица инструментов агента: схемы для провайдера (OpenAI-совместимый формат).

   Здесь только описания: имя, пояснение для модели и параметры. Исполнение живёт в
   src/agent-tools.js, права — в src/tool-policy.js, роутер групп — в agent-core.js.

   Вынесено из agent-core.js (разрез ядра, этап 1): это ЧИСТЫЕ ДАННЫЕ без логики и
   зависимостей. Ядро берёт их отсюда и отдаёт наружу под теми же именами, поэтому
   main.js, инструменты и тесты не менялись. Правки текста и схем делаются ЗДЕСЬ: в
   agent-core.js этих строк больше нет. */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ToolSchemas = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
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
        name: "openAdminTerminal",
        description: "Открыть ЖИВОЕ окно PowerShell с правами администратора (Windows): появится системный запрос прав (UAC) — пользователь подтверждает вручную. command — необязательная команда, которую сразу выполнить в этом окне (окно остаётся открытым: -NoExit). Это для работы руками; за разовым результатом с выводом иди в runCommandAsAdmin. На macOS/Linux окно пока не открывается — там используй runCommandAsAdmin.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Необязательная команда, которую сразу выполнить в админском окне (например: winget upgrade --all)" },
          },
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
      description: "Задать вопрос пользователю и дождаться ответа. Используй, когда нужно уточнить намерение перед необратимым действием, выбрать вариант или получить разрешение. question — текст вопроса; options — (необязательно, но очень желательно) 2–6 коротких вариантов ответа: человек выберет кнопкой или напишет своё. Передавай options всегда, когда выбор ограничен («Да»/«Нет», список сайтов, форматов, путей) — кнопкой быстрее и точнее. Прогон ЖДЁТ ответа: пока его нет, ничего другого не делай.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Текст вопроса пользователю" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Варианты ответа кнопками: 2–6 коротких строк, например [\"Да, выполнить\", \"Нет, отменить\"]",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggestRole",
      description: "Предложить пользователю СМЕНИТЬ роль чата, когда задача не по текущей роли (например в роли «Ассистент» просят написать код: у «Разработчика» больше инструментов, и он справится лучше). Пользователю покажется окно с кнопкой переключения — он сам решает; роль НЕ меняется сама. role — id роли: dev (Разработчик), assistant (Ассистент), manager (Менеджер), researcher (Исследователь); принимается и русское название. reason — коротко, почему другая роль подойдёт («нужно править файлы и запускать тесты — это инструменты Разработчика»). Не предлагай текущую роль. Вызов ЖДЁТ ответа человека — ничего другого в этом раунде не делай. Если пользователь откажется — продолжай своими силами и скажи, чего тебе не хватает.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", description: "Роль для предложения: dev | assistant | manager | researcher (принимается и русское название)" },
          reason: { type: "string", description: "Коротко: почему эта роль подойдёт лучше текущей" },
        },
        required: ["role"],
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
      name: "diaryWrite",
      description: "Дописать запись в дневник агента — файл .agent/AGENT.md в самом проекте (человекочитаемый, может уехать в git, как AGENT.md в Codebuff / REPLIT.md в Replit). Пиши сюда ВАЖНОЕ и НАДОЛГО: принятые решения и почему, договорённости с человеком, «где остановились», подводные камни, что уже сделано. Не дублируй мелочи текущего шага и не пересказывай код — только то, что через день поможет продолжить. title — короткий заголовок записи; text — 2–6 предложений по делу. Записи дописываются снизу (свежие — в конце); старые вытесняются, файл не разрастается.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Короткий заголовок записи" },
          text: { type: "string", description: "Текст записи: что решили/сделали и почему (до 8000 символов)" },
        },
        required: ["title", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diaryRead",
      description: "Прочитать дневник агента (.agent/AGENT.md). Загляни сюда В НАЧАЛЕ работы над проектом, когда продолжаешь прерванную задачу, когда что-то кажется знакомым или когда сомневаешься в прежних договорённостях. tail — (необязательно) показать только последние N символов, если нужны лишь свежие записи.",
      parameters: {
        type: "object",
        properties: { tail: { type: "number", description: "Сколько последних символов файла показать (необязательно; по умолчанию — весь файл)" } },
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
      description: "Yandex Cloud: логи ресурса И группы логов (Cloud Logging). Читается внутренним API приложения (группы по REST, записи по gRPC) — внешний yc CLI не нужен. action: logs (по умолчанию — логи ресурса за последние 3 часа), groups (список лог-групп каталога), group (одна группа подробно), createGroup (создать группу), updateGroup (править группу), deleteGroup (удалить группу). Для logs: id — id ресурса (из ycList), service — ключ сервиса (необязателен), sinceHours — окно в часах (по умолчанию 3), limit — сколько записей (по умолчанию 100). Для групп: group — имя или id (необязательно, если группа одна), name — имя при создании, newName — новое имя, description — описание, labels — метки объектом или строкой JSON, retention — срок хранения в часах (пусто/0 — без срока), dataStream — поток данных. Создание, правка и удаление — только при включённых разрешениях агента в настройках. Лог-группа нужна, чтобы собирать логи ревизий контейнера и разбор запросов балансировщика (ycAlb logGroup).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "logs | groups | group | createGroup | updateGroup | deleteGroup (по умолчанию logs)" },
          service: { type: "string", description: "Ключ сервиса для action=logs (необязательно): serverlessContainers | apiGateway | ydb | storage | dns | iam | lockbox | cdn | certificateManager | containerRegistry | logging | vpc" },
          id: { type: "string", description: "id ресурса для action=logs (из ycList)" },
          sinceHours: { type: "integer", description: "За сколько часов читать (1–168, по умолчанию 3)" },
          limit: { type: "integer", description: "Сколько записей вернуть (1–500, по умолчанию 100)" },
          group: { type: "string", description: "Лог-группа (имя или id) для group/updateGroup/deleteGroup" },
          name: { type: "string", description: "Имя новой лог-группы (createGroup)" },
          newName: { type: "string", description: "Новое имя лог-группы (updateGroup)" },
          description: { type: "string", description: "Описание лог-группы (до 256 символов)" },
          labels: { type: "object", description: "Метки лог-группы (ключ — строчная латиница/цифры/дефис)" },
          retention: { type: "integer", description: "Срок хранения в часах; пусто/0 — без срока" },
          dataStream: { type: "string", description: "Имя потока данных (до 512 символов)" },
        },
        required: [],
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
        "Yandex Cloud: работа с Serverless-контейнером «как в консоли» — обзор, редактор, ревизии. action: overview (статус, URL, число ревизий и полные настройки активной) | revisions (список ревизий с фильтром) | revision (детали одной ревизии) | deploy (создать ревизию: настройки берутся из активной ревизии, указанные поля их переопределяют) | rollback (откатить контейнер на выбранную ревизию) | update (имя, описание, метки контейнера). container — имя или id (список: ycList(service: \"serverlessContainers\")). deploy/rollback/update требуют разрешения «Разрешить агенту менять контейнеры и правила сети» и явной просьбы пользователя: новая ревизия сразу получает трафик и тарифицируется. Образ, переменные окружения и ресурсы меняются ТОЛЬКО новой ревизией — контейнер правится через deploy.",
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
  {
    type: "function",
    function: {
      name: "ycSecret",
      description:
        "Yandex Cloud: секреты Lockbox — список, версии и наполнение. action: list (секреты каталога) | versions (версии секрета: id, дата и ИМЕНА ключей) | putversion (новая версия со значениями). secret — имя или id секрета (список: action list). putversion требует разрешения «Разрешить агенту создавать ресурсы» и явной просьбы пользователя. Значения секретов обратно не читаются — наружу уходят только имена ключей. Секрет без версии бесполезен: ревизия контейнера ссылается на ключ, которого нет, поэтому сначала putversion, а потом ycContainer (action deploy) с полем secrets — id, key, environmentVariable.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | versions | putversion" },
          secret: { type: "string", description: "Имя или id секрета (для action versions и putversion)" },
          entries: { type: "object", description: "Пары «ключ → значение» для новой версии: { API_KEY: значение, DB_URL: значение }. Можно списком объектов: [{ key: API_KEY, value: значение }]. Ключ — латиница, цифры и знаки - _ . / и @" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycDns",
      description:
        "Yandex Cloud: записи зоны Cloud DNS — посмотреть, поставить и удалить. action: records (записи зоны) | add (поставить значения для пары «имя+тип»: есть — заменит, нет — добавит) | delete (удалить все значения пары «имя+тип»). zone — имя или id зоны (список: ycList service dns); без zone работает, только если зона в каталоге одна. name — FQDN с точкой на конце: вершина зоны — само её имя (example.com.), поддомен — www.example.com. type — A, AAAA, CNAME, TXT, MX, NS, SRV. value — строка или массив строк (для MX: 10 mx.example.com.). ttl — секунды. add требует чекбокса «Разрешить агенту создавать ресурсы», delete — «Разрешить агенту удалять ресурсы». Помни разницу: имя ЗОНЫ при создании — домен БЕЗ точки, имя ЗАПИСИ — С точкой.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "records | add | delete" },
          zone: { type: "string", description: "Имя или id DNS-зоны (необязательно, если в каталоге одна зона)" },
          name: { type: "string", description: "Имя записи — FQDN с точкой на конце: www.example.com., а для вершины зоны — само её имя example.com." },
          type: { type: "string", description: "Тип записи: A | AAAA | CNAME | TXT | MX | NS | SRV" },
          value: { type: "string", description: "Значение записи (несколько — через запятую или полем values)" },
          values: { type: "array", items: { type: "string" }, description: "Несколько значений одной записи (необязательно)" },
          ttl: { type: "integer", description: "TTL в секундах (по умолчанию 600)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycMonitor",
      description:
        "Yandex Cloud Monitoring: метрики каталога — что вообще измеряется и что показывают сами цифры. action: overview (метаданные каталога: имена метрик, их типы и МЕТКИ) | names (метрики конкретного ресурса по метке service + resource_id) | metrics (данные метрики за период). Имена метрик и их метки у облака меняются от сервиса к сервису, поэтому сначала overview или names, а не метрика по памяти: у машины это cpu_usage, у другого сервиса — своё. Сборка запроса — metric + service + resource: получится cpu_usage{service=\"compute\", resource_id=\"…\"}; можно задать готовый query целиком. minutes — за сколько минут (по умолчанию 60), aggregation — чем прореживать (AVG по умолчанию, ещё MAX/MIN/SUM/LAST/COUNT), maxPoints — сколько точек оставить (по умолчанию 30; облако требует больше 10), gapFilling — что с пропусками (NULL/NONE/PREVIOUS). Ответ — сводка по ряду: среднее, максимум, последнее и число точек, а не сырые точки. ВАЖНО: порог с уведомлением (алерт) этим инструментом поставить НЕЛЬЗЯ — публичного REST для алертов у облака нет, они настраиваются в консоли Monitoring; не выдумывай такое действие. Разрешений не требует (только чтение).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "overview | names | metrics" },
          metric: { type: "string", description: "Имя метрики латиницей, например cpu_usage (для action metrics; что есть — покажет overview)" },
          query: { type: "string", description: "Готовый запрос Monitoring целиком, например cpu_usage{service=\"compute\", resource_id=\"epd…\"} (необязательно: вместо него можно задать metric + service + resource)" },
          service: { type: "string", description: "Метка service: compute, serverless-functions, serverless-containers и т.д." },
          resource: { type: "string", description: "Метка resource_id — идентификатор ресурса (виден в ycList/карточке)" },
          minutes: { type: "integer", description: "За сколько минут читать данные (по умолчанию 60)" },
          aggregation: { type: "string", description: "Прореживание: AVG | MAX | MIN | SUM | LAST | COUNT (по умолчанию AVG)" },
          maxPoints: { type: "integer", description: "Сколько точек оставить (по умолчанию 30, минимум 11)" },
          gapFilling: { type: "string", description: "Заполнение пропусков: NULL | NONE | PREVIOUS" },
          limit: { type: "integer", description: "Сколько имён метрик показать (по умолчанию 200)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycMdb",
      description:
        "Yandex Cloud: управляемые базы (Managed Service for PostgreSQL, MySQL и ClickHouse) — посмотреть кластеры, карточку с хостами и строкой подключения, базы и пользователей, логи, историю операций, классы хостов, включить-выключить, создать и удалить кластер. База задаётся ПОЛЕМ engine: postgresql (а также «postgres», «pg», «постгрес»), mysql, clickhouse. action: overview (кластеры: без engine — сразу все три базы) | card (карточка: состояние, ресурсы, хосты, готовая строка подключения) | hosts (хосты: зоны, роли MASTER/REPLICA, здоровье) | databases (базы) | users (пользователи и их доступ; паролей в чтении нет и быть не может) | logs (записи за minutes минут, serviceType — тип логов сервиса) | operations (история операций: что делалось и чем кончилось) | presets (классы хостов: ядра, память, зоны — список отдаёт само облако) | start | stop (питание) | create | delete. ЧТО ЗНАТЬ: (1) адрес подключения — это ИМЯ ХОСТА (вида c-…rw.mdb.yandexcloud.net), а не кластера: точки входа у кластера нет, поэтому строку подключения собирает card по хосту-мастеру; (2) для PostgreSQL порт подключения 6432 (пулер), MySQL 3306, ClickHouse 9440; (3) ПАРОЛЬ пользователя облако отдаёт РОВНО ОДИН РАЗ — в ответ на create; второй раз его не покажет ни список, ни консоль, поэтому сохрани его в хранилище секретов (ycSecret); (4) СОЗДАНИЕ ПЛАТНОЕ и требует полей name, version, preset и subnet: класс тарифицируется почасово и круглосуточно, а точную цену за час показывает каталог облака — ycBilling { action: \"price\", query: \"PostgreSQL\" }; назови ориентир пользователю и получи согласие ДО вызова с confirm: true; (5) stop экономит деньги за вычисления, но диск и РЕЗЕРВНЫЕ КОПИИ тарифицируются и у остановленного кластера; (6) УДАЛЕНИЕ необратимо и забирает резервные копии вместе с кластером, поэтому требует confirm: true после согласия, а при включённой защите от удаления (deletionProtection) облако откажет — сначала сними защиту в консоли. Требуемые чекбоксы разрешений: create — «Разрешить агенту создавать ресурсы», start/stop — «Разрешить агенту менять контейнеры и правила сети», delete — «Разрешить агенту удалять ресурсы».",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "overview | card | hosts | databases | users | logs | operations | presets | start | stop | create | delete" },
          engine: { type: "string", description: "База: postgresql | mysql | clickhouse (понимает также postgres, pg, постгрес). Без него overview показывает все три" },
          cluster: { type: "string", description: "Имя или id кластера (для card, hosts, databases, users, logs, operations, start, stop, delete)" },
          name: { type: "string", description: "Имя НОВОГО кластера (для create): строчные латинские буквы, цифры и дефис" },
          version: { type: "string", description: "Версия базы (для create): PostgreSQL — 11…18, MySQL — 5.7/8.0/8.4, ClickHouse — например 24.8" },
          preset: { type: "string", description: "Класс хоста (для create) — id из action presets, например s2.micro" },
          diskGb: { type: "integer", description: "Размер диска в ГБ (для create; по умолчанию 20, у ClickHouse 32)" },
          diskType: { type: "string", description: "Тип диска (для create): network-ssd (по умолчанию) или network-hdd (дешевле)" },
          zone: { type: "string", description: "Зона хоста (для create; по умолчанию ru-central1-a). Подсеть должна быть в этой же зоне" },
          subnet: { type: "string", description: "Имя или id подсети (для create) — сеть определится по ней; список: ycVpc { action: \"subnets\" }" },
          user: { type: "string", description: "Имя пользователя базы (для create; по умолчанию admin)" },
          database: { type: "string", description: "Имя базы (для create; по умолчанию db1, у ClickHouse default)" },
          userPassword: { type: "string", description: "Пароль пользователя (необязательно: без него сгенерирую стойкий и покажу один раз)" },
          publicIp: { type: "boolean", description: "Для create: true — выдать хосту публичный адрес (нужен, чтобы подключаться из интернета)" },
          minutes: { type: "integer", description: "За сколько минут читать логи (по умолчанию 60)" },
          serviceType: { type: "string", description: "Тип логов: PostgreSQL — POSTGRESQL/POOLER/REPACK, MySQL — MYSQL/POOLER, ClickHouse — CLICKHOUSE/KEEPER" },
          limit: { type: "integer", description: "Сколько записей логов или операций показать (по умолчанию 100 и 15)" },
          confirm: { type: "boolean", description: "Подтверждение пользователя для create и delete — без него не выполняется" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycAi",
      description:
        "Яндекс AI (тот же токен Yandex Cloud, отдельного ключа API не нужно): перевод, текст с картинки и речь. action: translate (перевести) | languages (языки перевода) | ocr (текст со снимка или PDF) | voices (голоса SpeechKit) | speak (текст в звук) | listen (звук в текст) | models (модели AI Studio каталога) | tokens (посчитать токены текста) | complete (ответ модели AI Studio) | embed (вектор текста). ПРИНИМАЕТ СПИСКИ: targets — несколько языков сразу (перевести на en, de, fr одним вызовом), texts — несколько строк, files — несколько картинок, voices — несколько голосов. Когда что: скриншот или скан → ocr (модель page — обычный текст, handwritten — рукописный, table — таблицы; langs — языки, по умолчанию ru и en); чужой текст или подпись на картинке → translate (source можно не указывать — облако определит язык само); «озвучь» → speak (файлы ложатся в рабочую папку агента, послушать — openPath); «расшифруй запись» → listen (ogg/opus, mp3, lpcm; файл до 1 МБ, примерно минута речи). AI Studio: сначала models — что есть в каталоге (бесплатно), потом tokens — цена запроса по-настоящему ДО отправки (токенизация бесплатна, у каждой модели свой токенизатор), затем complete — ответ модели (prompt, system — роль, temperature 0…1, maxTokens — длина ответа). embed — вектор для поиска по смыслу: документы и запросы векторизуют РАЗНЫМИ моделями (text-search-doc и text-search-query), их пространства несовместимы. Картинка — до 10 МБ; lpcm требует sampleRateHertz; эмоции good/evil понимают только русские голоса. Все сервисы ПЛАТНЫЕ по запросу: перевод — за каждый целевой язык отдельно, SpeechKit — по длине звука, AI Studio — по токенам (models и tokens бесплатны, тариф называет ответ до и после запроса), поэтому переводи пачкой, а не по языку за раз. Разрешений не требует, но speak пишет файл на диск.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "translate | languages | models | tokens | complete | embed | ocr | voices | speak | listen" },
          prompt: { type: "string", description: "Запрос к модели AI Studio (complete) — текст, на который она отвечает" },
          system: { type: "string", description: "Роль модели для complete (system): например «отвечай коротко» — необязательно" },
          temperature: { type: "number", description: "Температура complete: 0…1 (по умолчанию 0.3; ближе к 1 — разгульнее)" },
          maxTokens: { type: "integer", description: "Длина ОТВЕТА complete в токенах: 1…32000 (по умолчанию 2000). Вход считается отдельно — сначала action tokens" },
          text: { type: "string", description: "Текст: что перевести (translate), озвучить (speak), посчитать токены (tokens), превратить в вектор (embed)" },
          texts: { type: "array", items: { type: "string" }, description: "Несколько строк для перевода сразу (необязательно)" },
          target: { type: "string", description: "Язык перевода: ru, en, de, zh… (для translate)" },
          targets: { type: "array", items: { type: "string" }, description: "Несколько языков перевода сразу — каждый станет отдельным запросом" },
          source: { type: "string", description: "Язык источника (необязательно: без него облако определит язык само)" },
          file: { type: "string", description: "Путь к файлу от рабочей папки: картинка для ocr, запись для listen" },
          files: { type: "array", items: { type: "string" }, description: "Несколько картинок для распознавания сразу" },
          langs: { type: "array", items: { type: "string" }, description: "Языки текста на картинке (по умолчанию ru, en)" },
          model: { type: "string", description: "Модель: Vision — page | handwritten | table | markdown | mathmarkdown | page-column-sort; AI Studio — yandexgpt-5-lite | yandexgpt-5.1 | yandexgpt-5-pro | aliceai-llm | text-search-doc | text-search-query, либо полный адрес gpt://<каталог>/<модель>" },
          mimeType: { type: "string", description: "Тип файла (обычно виден по расширению: jpg, png, bmp, tiff, pdf)" },
          voice: { type: "string", description: "Голос SpeechKit: alena, filipp, ermil, jane, omazh, zahar, madirus… (список: action voices)" },
          voices: { type: "array", items: { type: "string" }, description: "Несколько голосов сразу — на каждый будет свой файл" },
          lang: { type: "string", description: "Язык речи для speak и listen (по умолчанию ru-RU)" },
          format: { type: "string", description: "Формат звука: speak — mp3 (по умолчанию) | oggopus | lpcm | wav; listen — oggopus | mp3 | lpcm" },
          speed: { type: "number", description: "Скорость речи speak: 0.1–3.0 (по умолчанию 1.0)" },
          emotion: { type: "string", description: "Эмоция голоса speak: good | evil | neutral (только русские голоса)" },
          out: { type: "string", description: "Куда сохранить звук (необязательно: по умолчанию — рабочая папка агента)" },
          topic: { type: "string", description: "Тема распознавания listen: general (короткие команды) | deferred (длинная речь)" },
          sampleRateHertz: { type: "integer", description: "Частота дискретизации (нужна для lpcm, например 48000)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycIg",
      description:
        "Yandex Cloud: ГРУППЫ ОДИНАКОВЫХ МАШИН (Instance Groups). action: list (группы каталога) | card (карточка: шаблон, машины, операции) | instances (машины группы) | operations (история операций) | create (создать группу) | start | stop (питание) | delete (удалить группу ВМЕСТЕ с машинами). Группа — не список машин: она САМА создаёт машины по шаблону (instanceTemplate), держит их число и пересоздаёт удалённые руками — удалённая машина вернётся, поэтому число меняют размером группы, а не удалением машин. Платят МАШИНЫ группы — как обычные машины Compute Cloud, за каждый час работы (ориентир: ycCosts). Создание и удаление требуют confirm: true после согласия пользователя; удаление забирает машины и их диски — снимки делай заранее. Группа стоит в ОДНОЙ зоне — зоне подсети (subnet обязателен); без publicIp: true публичного адреса у машин нет; если не задать securityGroups, останется группа по умолчанию сети, а она закрывает SSH снаружи. deletionProtection отменяет удаление.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | card | instances | operations | create | start | stop | delete" },
          group: { type: "string", description: "Имя или id группы (для card, instances, operations, start, stop, delete)" },
          name: { type: "string", description: "Имя новой группы (create): строчные латинские буквы, цифры и дефис" },
          subnet: { type: "string", description: "Имя или id подсети (create) — группа встанет в ЕЁ зоне; список: ycVpc { action: \"subnets\" }" },
          size: { type: "integer", description: "Сколько машин держать (create; по умолчанию 2, до 100) — это и есть цена: каждая машина платит за час" },
          cores: { type: "integer", description: "Ядер на машину (create; по умолчанию 2)" },
          memoryGb: { type: "number", description: "Памяти на машину, ГБ (create; по умолчанию 2)" },
          coreFraction: { type: "integer", description: "Гарантированная доля vCPU, % (create; по умолчанию 100)" },
          diskSizeGb: { type: "integer", description: "Диск на машину, ГБ (create; по умолчанию 20, минимум 4)" },
          diskType: { type: "string", description: "Тип диска (create): network-ssd (по умолчанию) | network-hdd" },
          imageFamily: { type: "string", description: "Семейство образа (create; по умолчанию ubuntu-2204-lts; есть и ubuntu-2404-lts)" },
          imageId: { type: "string", description: "Точный id образа (create) — вместо семейства" },
          zone: { type: "string", description: "Зона группы (create; по умолчанию — зона подсети)" },
          platformId: { type: "string", description: "Платформа (create; по умолчанию standard-v3)" },
          publicIp: { type: "boolean", description: "true — каждой машине публичный адрес (create; без него у машин нет внешнего адреса)" },
          preemptible: { type: "boolean", description: "true — прерываемые машины: дешевле, но облако может остановить их в любой момент (create)" },
          securityGroups: { type: "array", items: { type: "string" }, description: "Группы безопасности (create): без них SSH снаружи закрыт группой по умолчанию сети" },
          serviceAccountId: { type: "string", description: "Сервисный аккаунт группы (create) — им группа вызывает API от имени человека" },
          sshPublicKey: { type: "string", description: "Публичный SSH-ключ (create) — попадёт в метаданные шаблона" },
          sshUser: { type: "string", description: "Пользователь ключа (create; для ubuntu — ubuntu)" },
          confirm: { type: "boolean", description: "Подтверждение пользователя для create и delete — без него не выполняется" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycAlb",
      description:
        "Yandex Cloud: ВХОД В ПРИЛОЖЕНИЕ С УЛИЦЫ — Application Load Balancer. Это ЧЕТЫРЕ разных ресурса одного сервиса, и путать их нельзя: ГРУППА ЦЕЛЕЙ (targets, targetnew, tgupdate, targetadd, targetremove, targetdel) — список адресов машин, знает ТОЛЬКО адрес и подсеть; у группы правят только имя и описание (tgupdate: newName, description), а состав меняют точечно (targetadd/targetremove) — поле targets в PATCH заменяет список целиком, и машины так теряются; HTTP-РОУТЕР (routers, routernew, routerupd, routerdel) — правила «домен и путь → группа бэкендов»; БАЛАНСИРОВЩИК (list, card, lbnew, lbupdate, lbstart, lbstop, lbdel) — адреса, зоны и слушатели (http — через роутер, https — роутер и сертификат Certificate Manager со статусом Issued, stream — поток TCP на группу бэкендов); СОСТАВ СЛУШАТЕЛЕЙ меняют точечно: listeneradd, listenerupd и listenerdel — по одному слушателю, а не перезаписью всего списка (лишний listenerSpecs[] стёр бы остальных), а lbupdate правит имя, описание, группы безопасности, доступ-логи, авто-масштаб и допуск к сдвигу зоны: logGroup — группа Cloud Logging для журнала запросов (единственное место, где видно, куда ушёл запрос), noLogs: true — выключить его (одно поле logOptions: или группа, или выключено); minZoneSize и maxSize — ресурсные единицы балансировщика (платные узлы): минимум в КАЖДОЙ зоне (не меньше 2) и максимум всего, где 0 — без предела, и оба числа уходят вместе; allowZonalShift — да или нет. Группы безопасности ЗАМЕНЯЮТСЯ целиком, поэтому перечисли все нужные. ПРАВКА СЛУШАТЕЛЯ — это listenerupd: чего не назвали — ОСТАЁТСЯ прежним (вид, порт, адрес, роутер, сертификат, домены SNI), поэтому «продлить сертификат» — это listenerupd { listenerName: \"web\", certificate: \"новый\" }; переименовать слушателя НЕЛЬЗЯ (имя и есть его адрес внутри балансировщика), а смена вида (http → https) заменяет обработчик целиком, и адрес слушателя при правке оставляют: домены смотрят именно на него. Домены сверх основного живут в SNI (поля sni у lbnew, listeneradd и listenerupd): списком [{ serverNames: [\"shop.example.com\"], certificate: \"shop-cert\" }] или строкой «домен=сертификат» — у каждого домена СВОЙ сертификат, а в правке список ЗАМЕНЯЕТСЯ целиком (пустой убирает все домены). ГРУППА БЭКЕНДОВ (backends, backnew, backupd, backdel) — куда ведут маршруты: в ней живут ПОРТ целей и проверки здоровья; создаётся из группы целей (backnew), а удаляется только когда на неё никто не смотрит — занятую облако отклонит. ПРАВКА РОУТЕРА И ГРУППЫ — ЭТО ЗАМЕНА ВЛОЖЕННОГО СПИСКА: у роутера список virtualHosts[] (вместе с маршрутами), у группы — backends[], и облако не умеет «поменять путь» или «поменять порт» по-другому: routerupd { router: \"main-router\", routeName: \"main\", pathPrefix: \"/api\" } и backupd { group: \"web-backends\", port: 8080 } читают текущий список, меняют в нём названное и возвращают его ЦЕЛИКОМ, поэтому остальные маршруты и бэкенды остаются как были, а вот новые ими не создать — для этого routernew/backnew. Чего в правке не назвали — ОСТАЁТСЯ прежним; port в backupd — это порт, который слушают ЦЕЛИ (машины), а не балансировщик; noHealthCheck: true убирает проверки здоровья совсем (облако начнёт считать здоровой любую цель); переименование в обоих — newName, а путь у маршрута меняется на pathPrefix (префикс) или pathExact (точный), причём домен хоста правится полем host (пустая строка убирает домен). Порядок работы: targetnew → backnew → routernew (или слушатель-поток) → lbnew. Балансировщик ПЛАТНЫЙ: ресурсные единицы и сам ресурс тарифицируются за час, даже без трафика, поэтому lbnew только с confirm: true после согласия человека (ориентир: ycBilling { action: \"price\", query: \"Application Load Balancer\" }); lbdel уносит слушатели и адреса (домен перестанет открываться), routerdel оставляет слушатель без ответа, targetdel теряет список целей — всё с confirm: true. Адрес балансировщика — это адреса его СЛУШАТЕЛЕЙ: пока слушатель не создан, адреса нет, и DNS-запись (ycDns) вешают только после. Состояние целей (здорова или нет) показывает action health: он спрашивает пару «группа бэкендов + группа целей» у балансировщика и отвечает ПО ЗОНАМ; без проверок здоровья в группе бэкендов облако считает здоровой каждую цель.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | card | targets | routers | backends | health | targetnew | tgupdate | targetadd | targetremove | targetdel | routernew | routerupd | routerdel | backnew | backupd | backdel | listeneradd | listenerupd | listenerdel | lbupdate | lbnew | lbstart | lbstop | lbdel" },
          lb: { type: "string", description: "Балансировщик — имя или id (для card, listeneradd, listenerupd, listenerdel, lbupdate, lbstart, lbstop, lbdel; без него работает, только если балансировщик в каталоге один)" },
          listenerName: { type: "string", description: "Имя слушателя (listeneradd, listenerupd, listenerdel): уникально ВНУТРИ балансировщика, строчные латинские буквы, цифры и дефис; список имён показывает card. При listenerupd это ИМЯ ПРАВИМОГО слушателя — переименовать его нельзя" },
          newName: { type: "string", description: "Новое имя ресурса (lbupdate — балансировщик, routerupd — роутер, backupd — группа бэкендов, tgupdate — группа целей); пусто — имя не меняется, а имя обязано быть уникальным в каталоге; переименование не рвёт связей — группы держат друг друга по id" },
          group: { type: "string", description: "Группа целей — имя или id (для tgupdate, targetadd, targetremove, targetdel); для backdel — группа бэкендов" },
          targetGroup: { type: "string", description: "Группа целей — имя или id (для backnew и health: чьё здоровье спрашивают; для backupd — новая группа целей у бэкендов: сюда уйдёт трафик); список: action targets" },
          kind: { type: "string", description: "Вид группы бэкендов (backnew): http (по умолчанию — сайт и API), grpc (сервисы) или stream (поток TCP: базы и брокеры)" },
          healthPath: { type: "string", description: "Путь проверки здоровья для http-группы (backnew, backupd), например /health или /: без проверок облако считает цель здоровой всегда, и упавшая машина останется в ротации; проверка живёт В БЭКЕНДЕ, а не в группе" },
          router: { type: "string", description: "HTTP-роутер — имя или id (для routerupd и routerdel; также для http/https-слушателя: lbnew, listeneradd и listenerupd — при правке пусто значит «прежний»)" },
          name: { type: "string", description: "Имя нового ресурса: группы целей (targetnew), роутера (routernew) или балансировщика (lbnew)" },
          ips: { type: "array", items: { type: "string" }, description: "Адреса целей, например [\"10.10.0.5\", \"10.10.0.6\"] (targetnew, targetadd, targetremove). Цель — это адрес машины; порт задаёт группа бэкендов" },
          subnet: { type: "string", description: "Имя или id подсети: для целей (targetnew, targetadd) — где живут их адреса, для балансировщика (lbnew) — в какой зоне встанет узел; список: ycVpc { action: \"subnets\" }" },
          listener: { type: "string", description: "Вид слушателя (lbnew, listeneradd, listenerupd): http (по умолчанию — через роутер), https (роутер и сертификат) или stream (поток TCP на группу бэкендов вида stream). При listenerupd пусто значит «оставить прежний вид»: называй только при смене (http → https)" },
          port: { type: "integer", description: "Порт слушателя (lbnew, listeneradd, listenerupd; по умолчанию 80, для https — 443; при listenerupd пусто — прежний порт) или порт, который слушают ЦЕЛИ (backnew; по умолчанию 80, у stream обязателен: у базы он свой; в backupd — новый порт целей, пусто — прежний)" },
          certificate: { type: "string", description: "Сертификат Certificate Manager — имя или id (lbnew, listeneradd для https и listenerupd — так продлевают HTTPS; обязан быть в состоянии Issued и в ТОМ ЖЕ каталоге, выпустить: ycCdn { action: \"certnew\" }; карточка card показывает его домены и срок)" },
          sni: { type: "array", items: { type: "object" }, description: "Домены SNI — только для HTTPS (lbnew, listeneradd, listenerupd): [{ serverNames: [\"shop.example.com\"], certificate: \"shop-cert\" }, { serverNames: [\"www.example.com\", \"example.com\"], certificate: \"main-cert\" }]. Строка «домен=сертификат» тоже принимается. У каждого домена СВОЙ сертификат (обязательно Issued), домен нельзя повторить в двух обработчиках, а в listenerupd список ЗАМЕНЯЕТСЯ целиком: пустой [] убирает все дополнительные домены" },
          backendGroup: { type: "string", description: "Группа бэкендов — имя или id: обязательна для stream-слушателя и для маршрута routernew, для health это та группа, чьё здоровье спрашивают, а в routerupd — группа, в которую должен вести маршрут (только вида http); список: action backends" },
          host: { type: "string", description: "Домен виртуального хоста: для routernew — с каким доменом создать (без него роутер отвечает на ЛЮБОЙ домен), для routerupd — новый домен хоста-виртуального сервера (пусто — не менять, строка «нет» или пустое значение — убрать домен)" },
          routeName: { type: "string", description: "Имя маршрута в роутере (routerupd): какой маршрут правим; если в хосте он один, можно не называть. Имена показывает action routers и card" },
          vhost: { type: "string", description: "Имя виртуального хоста в роутере (routerupd): нужно, когда их несколько; если хост один, можно не называть" },
          healthService: { type: "string", description: "Имя службы для проверки gRPC (backnew, backupd): только для группы вида grpc, у http проверка задаётся путём healthPath" },
          noHealthCheck: { type: "boolean", description: "true — убрать проверки здоровья у бэкендов (backupd): облако начнёт считать здоровой ЛЮБУЮ цель, и упавшая машина останется в ротации" },
          backend: { type: "string", description: "Имя бэкенда внутри группы (backupd): правка только его; пусто — правим все бэкенды группы. Имена видны в action backends" },
          pathPrefix: { type: "string", description: "Путь-префикс маршрута (routernew; по умолчанию /; в routerupd — новый путь, пусто значит «оставить прежний»)" },
          pathExact: { type: "string", description: "Точный путь вместо префикса (routernew, routerupd)" },
          address: { type: "string", description: "Статический внешний IPv4-адрес (lbnew; пусто — облако выдаст само). При listenerupd пусто значит «оставить прежний адрес»: домены смотрят на адрес слушателя, и без него вход может переехать на новый адрес" },
          securityGroups: { type: "array", items: { type: "string" }, description: "Группы безопасности (lbnew, lbupdate) — имена или id; список ЗАМЕНЯЕТСЯ целиком, поэтому перечисли все нужные группы; без них порт закрыт снаружи группой по умолчанию" },
          logGroup: { type: "string", description: "Группа Cloud Logging для доступ-логов балансировщика (lbupdate) — имя или id; логи запросов тарифицируются по правилам Cloud Logging, а без группы логи пишутся в группу каталога по умолчанию. Нельзя вместе с noLogs — это одно поле logOptions" },
          noLogs: { type: "boolean", description: "true — выключить доступ-логи балансировщика (lbupdate): журнал запросов перестанет писаться. Включить обратно — logGroup" },
          minZoneSize: { type: "integer", description: "Авто-масштаб балансировщика (lbupdate): минимум ресурсных единиц в КАЖДОЙ зоне, не меньше 2. Ресурсные единицы — платные узлы балансировщика, и минимум × число зон оплачивается даже без трафика" },
          maxSize: { type: "integer", description: "Авто-масштаб балансировщика (lbupdate): максимум ресурсных единиц ВСЕГО; 0 — без верхнего предела. Обязан быть не меньше minZoneSize × число зон, а меняются оба числа вместе" },
          allowZonalShift: { type: "boolean", description: "lbupdate: true — разрешить облаку гасить трафик в зоне при её отказе или обслуживании (остальные зоны подхватят нагрузку), false — запретить (по умолчанию запрещено). Пусто — не менять" },
          confirm: { type: "boolean", description: "true — согласие пользователя: на создание платного балансировщика или на необратимое удаление группы целей, роутера или балансировщика" },
          description: { type: "string", description: "Описание ресурса (в routerupd, backupd и tgupdate — новое описание; пусто значит «не менять»)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycVpc",
      description:
        "Yandex Cloud: сеть VPC — подсети, группы безопасности и статические адреса. action: list (общая картина: сети, подсети, группы, адреса и предупреждение о простаивающих) | subnets (подсети: зона, диапазон, сеть) | addsubnet (создать подсеть) | delsubnet (удалить подсеть) | groups (группы безопасности с их правилами) | addgroup (создать группу) | delgroup (удалить группу) | addrule (добавить правило в группу) | delrule (убрать правило) | addresses (статические адреса: привязан или простаивает) | reserve (закрепить статический адрес) | release (освободить адрес). Подсеть живёт В ОДНОЙ ЗОНЕ и требует диапазон: name, network (имя или id сети), zone (ru-central1-a), cidr (10.10.0.0/24) — без cidr подберу свободный диапазон и скажу, какой выбрал. Правило: group, direction (ingress — вход, egress — выход), protocol (tcp/udp/icmp/any), port (22 или \"8000-8010\"; у icmp и any портов нет), cidr (203.0.113.10/32) или sourceGroup (группа-источник). Что нужно для виртуальной машины: подсеть + группа безопасности + правило на порт 22 ТОЛЬКО с адреса пользователя (/32), а не с 0.0.0.0/0 — правило 0.0.0.0/0 пускает к машине кого угодно. addsubnet/addgroup/reserve требуют чекбокса «Разрешить агенту создавать ресурсы», addrule/delrule — «Разрешить агенту менять контейнеры и правила сети», delsubnet/delgroup/release — «Разрешить агенту удалять ресурсы». Статический адрес платный и тарифицируется даже простаивающим, а освобождённый IP вернуть нельзя — не закрепляй адрес «про запас».",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | subnets | addsubnet | delsubnet | groups | addgroup | delgroup | addrule | delrule | addresses | reserve | release" },
          name: { type: "string", description: "Имя создаваемого объекта (подсеть, группа, адрес): строчные латинские буквы, цифры и дефис" },
          network: { type: "string", description: "Имя или id сети (для addsubnet и addgroup). Без него берётся единственная сеть каталога" },
          zone: { type: "string", description: "Зона: ru-central1-a, ru-central1-b, ru-central1-d. Подсеть и статический адрес выдаются в одной зоне" },
          cidr: { type: "string", description: "Диапазон подсети (10.10.0.0/24) или адрес/сеть правила (203.0.113.10/32, 0.0.0.0/0, fd00::/64)" },
          subnet: { type: "string", description: "Имя или id подсети (для delsubnet)" },
          group: { type: "string", description: "Имя или id группы безопасности (для addrule, delrule, delgroup)" },
          direction: { type: "string", description: "Направление правила: ingress (вход, по умолчанию) или egress (выход)" },
          protocol: { type: "string", description: "Протокол правила: tcp (по умолчанию), udp, icmp или any" },
          port: { type: "string", description: "Порт или диапазон правила: 22 или \"8000-8010\". У icmp и any портов нет" },
          sourceGroup: { type: "string", description: "Группа-источник правила — вместо cidr (трафик от ресурсов этой группы)" },
          target: { type: "string", description: "Предопределённая цель правила: self или all (нужно редко)" },
          address: { type: "string", description: "Для reserve — конкретный IPv4, который нужно закрепить; для release — имя или id адреса" },
          description: { type: "string", description: "Описание создаваемого объекта (необязательно)" },
          protection: { type: "boolean", description: "Для reserve: true — защитить адрес от случайного удаления" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycCompute",
      description:
        "Yandex Cloud: виртуальные машины (Compute Cloud) — весь цикл: посмотреть, поднять, включить-выключить, удалить, снять снимок и увидеть, что внутри. action: list (машины каталога и платные хвосты) | card (одна машина: где, какие диски, какие адреса, сколько стоит) | presets (готовые конфигурации с ценой) | create (создать машину) | delete (удалить машину, при deleteDisks отличном от false — вместе с её дисками) | start | stop | restart (питание) | serial (serial-консоль: текст загрузки и работы — единственный «экран» машины) | metrics (процессор, сеть, диск за последние минуты) | disks (диски: привязан или лежит без дела) | snapshot (снимок диска) | delsnapshot (удалить снимок) | cleansnapshots (чистка старых снимков) | restoredisk (восстановить диск из снимка) | leftovers (что оплачивается, хотя уже не нужно). Создание: name, preset (micro | small | medium | full) либо cores/memoryGb/coreFraction, zone (ru-central1-a), subnet (имя подсети в ТОЙ ЖЕ зоне), publicIp (true — адрес из интернета), sshPublicKey (публичный ключ), diskSizeGb, imageFamily (ubuntu-2204-lts), preemptible. Машина платит ЗА КАЖДЫЙ ЧАС РАБОТЫ, поэтому создание требует confirm: true после согласия пользователя с ценой (цена считается ycCosts), а stop реально экономит деньги. Диски тарифицируются ВСЕГДА — и когда машина остановлена, и после её удаления: перед удалением предложи снимок, а leftovers показывает такие «хвосты». Без sshPublicKey машина создастся, но войти в неё будет нельзя: пароля у неё нет. Ключ SSH делает человек в панели — приватный ключ в ответ инструмента не отдаётся никогда. create/snapshot/restoredisk требуют чекбокса «Разрешить агенту создавать ресурсы», start/stop/restart — «Разрешить агенту менять контейнеры и правила сети», delete/delsnapshot/cleansnapshots(dryRun: false) — «Разрешить агенту удалять ресурсы». Перед удалением всегда спрашивай пользователя: данные на дисках без снимка теряются навсегда.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | card | presets | create | delete | start | stop | restart | serial | metrics | disks | snapshot | delsnapshot | cleansnapshots | restoredisk | leftovers" },
          instance: { type: "string", description: "Имя, id или fqdn машины (для card, start, stop, restart, serial, metrics, delete, snapshot)" },
          id: { type: "string", description: "То же, что instance: id машины (можно instanceId)" },
          name: { type: "string", description: "Имя новой машины при create: строчные латинские буквы, цифры и дефис" },
          preset: { type: "string", description: "Готовый набор: micro | small | medium | full (список с ценами — action presets)" },
          zone: { type: "string", description: "Зона машины: ru-central1-a, ru-central1-b, ru-central1-d. Если не указана, берётся зона подсети" },
          subnet: { type: "string", description: "Имя или id подсети. Обязательна: машина живёт в подсети, и её зона должна совпадать с зоной машины" },
          cores: { type: "number", description: "Число ядер: 2, 4, 6, 8… (уровни производительности — только для 2 и 4 ядер)" },
          memoryGb: { type: "number", description: "Память в гигабайтах (по умолчанию 2)" },
          coreFraction: { type: "number", description: "Уровень производительности ядра: 20 (экономный, по умолчанию), 50 или 100" },
          imageFamily: { type: "string", description: "Семейство образа (ubuntu-2204-lts по умолчанию, debian-12, almalinux-9…). Можно imageId" },
          diskSizeGb: { type: "number", description: "Размер загрузочного диска в гигабайтах (по умолчанию 20)" },
          diskType: { type: "string", description: "Тип диска: network-ssd (по умолчанию), network-hdd (вчетверо дешевле), network-ssd-nonreplicated, network-ssd-io-m3" },
          publicIp: { type: "boolean", description: "true — выдать публичный адрес (без него машина доступна только внутри облака)" },
          staticAddress: { type: "string", description: "Привязать конкретный статический адрес (его IP), закреплённый через ycVpc reserve" },
          securityGroupIds: { type: "string", description: "Группа(ы) безопасности: имена или id через запятую. Без них машина попадает в группу по умолчанию, которая вход запрещает" },
          sshPublicKey: { type: "string", description: "Публичный ключ SSH («ssh-ed25519 AAAA…»). Без него войти в машину будет нельзя — ключ делает пользователь в панели" },
          sshUser: { type: "string", description: "Имя пользователя для ключа (по умолчанию по образу: ubuntu, debian, almalinux…)" },
          preemptible: { type: "boolean", description: "Прерываемая машина: дешевле втрое, но облако может выключить её в любой момент (только для тестов)" },
          dataDiskSizeGb: { type: "number", description: "Дополнительный диск с данными, гигабайты (данные отдельно от системы)" },
          disk: { type: "string", description: "Для disks/snapshot: имя или id диска, с которого делается снимок" },
          snapshot: { type: "string", description: "Для snapshot — имя нового снимка; для delsnapshot/restoredisk — имя или id существующего снимка" },
          diskName: { type: "string", description: "Для restoredisk — имя нового диска (по умолчанию <имя снимка>-restored)" },
          keep: { type: "number", description: "Для cleansnapshots: сколько последних снимков на каждый диск оставить (по умолчанию 2)" },
          olderThanDays: { type: "number", description: "Для cleansnapshots: удалять снимки старше стольких дней" },
          dryRun: { type: "boolean", description: "Для cleansnapshots: false — удалить по-настоящему. По умолчанию true: только показать, что будет удалено" },
          minutes: { type: "number", description: "Для metrics: за сколько последних минут показать нагрузку (по умолчанию 60)" },
          lines: { type: "number", description: "Для serial: сколько последних строк консоли вернуть (по умолчанию 200)" },
          deleteDisks: { type: "boolean", description: "Для delete: false — оставить диски (они останутся платными). По умолчанию true — удалить вместе с машиной" },
          releaseAddress: { type: "boolean", description: "Для delete: true — освободить статический адрес машины. Вернуть именно его потом нельзя" },
          description: { type: "string", description: "Описание создаваемого объекта (необязательно)" },
          confirm: { type: "boolean", description: "true — согласие пользователя на платное действие (create, snapshot, restoredisk). Без него вернётся цена и предупреждения" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycIam",
      description:
        "Yandex Cloud: IAM — сервисные аккаунты («роботы»), их роли и ключи. Каждому, что работает САМО (выкатка, бэкап, скрипт, машина, выгрузка из базы), нужен свой аккаунт с УЗКОЙ ролью: тогда чужие права и утечка одного ключа не касаются остальных. action: list (аккаунты каталога: роли, ключи, предупреждения — «без ролей», «ключей нет», «ключ не использовался») | card (одна карточка: чем занят, что может, чем входит и что сломается при удалении) | keys (ключи одного аккаунта) | rolemap (роли человеческими словами и чем они опасны; работает без подключённого облака) | suggest (каких ролей ХВАТАЕТ для задачи: task site | vm | containers | secrets | db | logs | readonly) | roles (живой список ролей облака, filter — подстрока) | create (завести аккаунт) | update (переименовать или поменять описание) | delete (удалить аккаунт ВМЕСТЕ с его ключами и ролями) | grant (выдать роль на каталог) | revoke (снять роль) | newkey (создать ключ) | delkey (удалить ключ). account — имя или id сервисного аккаунта. Ключи трёх видов (kind): access — S3-совместимый, для Object Storage, скриптов и бэкапов; api — вызов API сервисов (API Gateway, функции); authorized — пара для SSH к машине (публичная часть уходит в метаданные). СЕКРЕТ ОБЛАКО ОТДАЁТ РОВНО ОДИН РАЗ — в ответе на newkey; ни в списке, ни в карточке его нет и не будет (там маска вида ****Ab12cd). Поэтому newkey требует confirm: true после согласия пользователя, а полученный секрет надо сразу положить в хранилище (ycSecret) и не повторять в переписке. Ключ работает ровно с ролями аккаунта: без роли бесполезен, с editor открывает почти всё. Примитивные роли (viewer, editor, admin, auditor) действуют на ВЕСЬ каталог — сначала предлагай узкие (storage.editor, compute.editor, serverless.containers.editor, container-registry.images.puller, lockbox.payloadViewer, ydb.editor, logging.viewer), а «на всякий случай» широкие не выдавай. Смена прав идёт ДЕЛЬТАМИ (ADD/REMOVE) и проверяется перечитыванием: если роль не появилась в списке — прав на выдачу не хватило. create и newkey требуют чекбокса «Разрешить агенту создавать ресурсы», update/grant/revoke — «Разрешить агенту менять контейнеры и правила сети», delete/delkey — «Разрешить агенту удалять ресурсы». Удаление аккаунта необратимо и забирает его ключи и роли — перед ним назови пользователю, что именно перестанет работать. IAM бесплатен: платят за ресурсы, к которым роли дают доступ.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | card | keys | rolemap | suggest | roles | create | update | delete | grant | revoke | newkey | delkey" },
          account: { type: "string", description: "Сервисный аккаунт: имя или id (для card, keys, update, delete, grant, revoke, newkey; можно serviceAccount)" },
          role: { type: "string", description: "Роль для grant/revoke: например storage.editor, compute.editor, lockbox.payloadViewer, viewer. Примитивные роли (viewer/editor/admin/auditor) действуют на весь каталог" },
          task: { type: "string", description: "Для suggest: зачем нужен доступ — site (файлы в бакете), vm (машина), containers (выкатка), secrets (Lockbox), db (таблицы YDB), logs (логи и метрики), readonly (только смотреть)" },
          kind: { type: "string", description: "Вид ключа для newkey/delkey: access (S3-совместимый), api (вызов API), authorized (ключ подписи / SSH к машине). По умолчанию access" },
          keyId: { type: "string", description: "Для delkey: id ключа из списка (ycIam action keys). Если указан account, можно передать и keyId из карточки" },
          filter: { type: "string", description: "Для roles: подстрока по имени роли, например storage или compute" },
          name: { type: "string", description: "Для create: имя аккаунта — строчные латинские буквы, цифры и дефис (например sa-site)" },
          newName: { type: "string", description: "Для update: новое имя аккаунта" },
          description: { type: "string", description: "Описание аккаунта или ключа — зачем он нужен (по нему потом понятно, можно ли удалять)" },
          labels: { type: "object", description: "Для create: метки аккаунта (ключ → значение)" },
          expiresAt: { type: "string", description: "Срок: для create — когда аккаунт перестанет работать, для newkey с kind api — до какого времени действует ключ (RFC3339)" },
          algorithm: { type: "string", description: "Для newkey с kind authorized: RSA_2048 (по умолчанию) или RSA_4096" },
          scopes: { type: "array", items: { type: "string" }, description: "Для newkey с kind api: области действия ключа (обычно оставляют пустым — тогда действуют права аккаунта)" },
          confirm: { type: "boolean", description: "true — согласие пользователя на создание ключа (newkey). Без него вернётся объяснение, потому что секрет показывается один раз" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycFunctions",
      description:
        "Yandex Cloud: Cloud Functions — функции, их версии, теги и вызов. action: list (функции каталога и что с ними не так) | card (одна функция: что отвечает, чем можно звать, что будет при удалении) | versions (версии функции: id, язык, память, статус, теги) | runtimes (доступные языки выполнения) | create (создать функцию) | update (имя, описание, метки) | deploy (создать ВЕРСИЮ — так и только так меняется код) | invoke (вызвать функцию и увидеть её ответ) | tag / untag (поставить или снять тег версии) | delversion (удалить версию) | delete (удалить функцию вместе со всеми версиями) | public / private (открыть функцию всему интернету или закрыть) | access (кому разрешено вызывать). Главное, что надо помнить: у функции НЕТ кода — код живёт в ВЕРСИИ, и вызов всегда попадает в какую-то версию. По умолчанию отвечает САМАЯ НОВАЯ версия (виртуальный тег $latest), поэтому ссылка без тега меняет поведение от каждой выкатки; постоянный тег (v1, prod) даёт стабильный адрес ?tag=v1. Тег `$latest` руками не ставится. deploy принимает код одним из трёх способов: zipFile (путь к ZIP-архиву с кодом), sourceVersionId (скопировать код прежней версии — меняются только переменные и память) или package { bucketName, objectName } (архив уже лежит в бакете). Обязательны runtime (например nodejs22 — номер языка входит в идентификатор) и entrypoint (index.handler). Память задаётся в мегабайтах и округляется вверх кратно 128 МБ (128…8192), executionTimeout — секунды (максимум 600: дольше функция работать не может). Переменные окружения — environment, секреты Lockbox — secrets, доступ в VPC — networkId. Вызов идёт на публичный адрес functions.yandexcloud.net, а не в API сервиса: закрытую функцию может позвать только тот, у кого есть роль serverless.functions.invoker (иначе 403), а public делает её вызываемой для allUsers — то есть для кого угодно из интернета. Удаление функции забирает ВСЕ её версии и теги, поэтому требует confirm: true. Цена: сама функция и её версии бесплатны, платят только за вызовы и время выполнения (первые 1 000 000 вызовов и 10 ГБ×час в месяц не тарифицируются) — для «редко зовут» и «по расписанию» это дешевле машины, и об этом стоит сказать пользователю. create/deploy требуют чекбокса «Разрешить агенту создавать ресурсы», update/tag/public/private — «Разрешить агенту менять контейнеры и правила сети», delete/delversion — «Разрешить агенту удалять ресурсы».",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | card | versions | runtimes | create | update | deploy | invoke | tag | untag | delversion | delete | public | private | access" },
          function: { type: "string", description: "Функция: имя или id (для card, versions, deploy, invoke, tag, untag, delversion, delete, public, private, access; можно name или id)" },
          name: { type: "string", description: "Для create: имя функции — строчные латинские буквы, цифры и дефис, 3–63 символа (например hello-func)" },
          runtime: { type: "string", description: "Для deploy: язык выполнения, например nodejs22, python312, golang122 (полный список — action runtimes). Версия языка входит в идентификатор: nodejs22, а не node22" },
          entrypoint: { type: "string", description: "Для deploy: точка входа — файл и обработчик, например index.handler" },
          zipFile: { type: "string", description: "Для deploy: путь к ZIP-архиву с кодом (до 8 МБ; больше — через package в бакете)" },
          contentBase64: { type: "string", description: "Для deploy: содержимое архива в base64 (если архив уже собран в памяти)" },
          sourceVersionId: { type: "string", description: "Для deploy: id прежней версии — её код копируется, а меняются только переменные, память и теги" },
          package: { type: "object", description: "Для deploy: архив уже в бакете — { bucketName, objectName }" },
          memoryMb: { type: "number", description: "Для deploy: память в мегабайтах, кратно 128 (по умолчанию 128, максимум 8192). Можно «512 МБ» или «1 ГБ»" },
          timeoutSec: { type: "number", description: "Для deploy: время выполнения в секундах (по умолчанию 5, максимум 600)" },
          environment: { type: "object", description: "Для deploy: переменные окружения версии (ключ → значение)" },
          secrets: { type: "array", items: { type: "object" }, description: "Для deploy: секреты Lockbox — [{ id, versionId, key, environmentVariable }]" },
          networkId: { type: "string", description: "Для deploy: id сети VPC, если функции нужен доступ к ресурсам в облаке" },
          concurrency: { type: "number", description: "Для deploy: сколько запросов обрабатывает один экземпляр одновременно (0–16)" },
          serviceAccountId: { type: "string", description: "Для deploy: сервисный аккаунт, от имени которого работает версия" },
          tag: { type: "string", description: "Для deploy/tag/untag/invoke: тег версии — v1, prod, stable (строчные латинские буквы, цифры, дефис, подчёркивание). Для invoke — какую версию вызвать" },
          version: { type: "string", description: "Для tag/untag/delversion: id версии или её тег (по умолчанию — самая новая версия)" },
          payload: { type: "object", description: "Для invoke: полезная нагрузка вызова (объект или строка JSON); для HTTP-обработчика обычно { queryStringParameters, body, httpMethod }" },
          timeoutMs: { type: "number", description: "Для invoke: сколько ждать ответ, миллисекунды (по умолчанию 60000, максимум 300000)" },
          description: { type: "string", description: "Описание функции или версии" },
          labels: { type: "object", description: "Для create/update: метки функции (ключ → значение)" },
          newName: { type: "string", description: "Для update: новое имя функции" },
          confirm: { type: "boolean", description: "true — согласие пользователя на удаление функции вместе со всеми её версиями. Без него вернётся объяснение, что именно уйдёт" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycBilling",
      description:
        "Yandex Cloud: ДЕНЬГИ — платёжный аккаунт, баланс, пороги и «за что мы платим». action: overview (сводка в одном ответе: аккаунт, баланс, пороги, хвосты) | accounts (платёжные аккаунты и баланс) | account (один аккаунт словами) | budgets (пороги-бюджеты) | price (НАСТОЯЩАЯ цена из каталога облака по словам) | services (что вообще тарифицируется) | leaks (платные хвосты в рублях за месяц). account — id или имя платёжного аккаунта (необязательно, если он один), query — что искать по цене («быстрый диск», «ядро», «память», «функция», «запрос»), serviceId — сузить поиск до услуги (список: action services), currency — валюта (по умолчанию RUB). ГЛАВНОЕ, ЧТО НАДО ЗНАТЬ: расход (сумму счёта) облако по API НЕ ОТДАЁТ — ни суммы, ни детализации; в Billing API есть только платёжные аккаунты, бюджеты, каталог услуг и каталог цен. Точные цифры — в консоли (Биллинг → Расходы) или в выгрузке детализации в бакет, и придумывать сумму вместо этого нельзя. Биллинг привязан к ПЛАТЁЖНОМУ АККАУНТУ, а не к каталогу, и требует роли billing.viewer: без неё приходит 403, и это надо объяснить человеку, а не показывать отказ. Баланс — это НЕ расход: отрицательный баланс означает, что облако скоро остановит ресурсы, поэтому о нём сообщают сразу. Порог-бюджет — предупреждение, а не счёт: он заранее пишет на почту, а не показывает потраченное, и создаётся в консоли (по API для него нужен id пользователя для уведомлений). Хвосты (leaks) — это то, за что платят, хотя уже не нужно: диск без машины, снимок удалённого диска, простаивающий статический адрес, снимки старше 90 дней и остановленные машины (их диски платят всегда) — каждая строка с ценой за месяц и с тем, что делать. Перед удалением предложи пользователю снимок и получи его согласие. Образы реестра и версии объектов в бакете считает свой инструмент (ycRegistry, ycStorage). Цены из action price — то, что облако говорит СЕЙЧАС; наши ориентиры (ycCosts) посчитаны по документации и помечены датой, поэтому при расхождении верь облаку и скажи, что ориентир устарел. Инструмент ТОЛЬКО читает: разрешений не требует, ничего не создаёт и не удаляет (в Billing API изменяющих методов нет вовсе).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "overview | accounts | account | budgets | price | services | leaks" },
          account: { type: "string", description: "Платёжный аккаунт: id или имя (необязательно, если он один)" },
          query: { type: "string", description: "Для price: что искать по цене — «быстрый диск», «стандартный диск», «ядро», «память», «функция», «бакет», «запрос»" },
          serviceId: { type: "string", description: "Для price: id услуги из action services — сужает каталог цен" },
          currency: { type: "string", description: "Валюта цен и баланса: RUB (по умолчанию), USD, KZT" },
          limit: { type: "number", description: "Для price: сколько находок показать (по умолчанию 8)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycCdn",
      description:
        "Yandex Cloud: HTTPS-сайт на своём домене — сертификат Certificate Manager (бесплатный, Let's Encrypt) и ресурс Cloud CDN, который раздаёт файлы из бакета. action: overview (сводка: сертификаты и CDN-ресурсы, что не так) | certs / cert (список сертификатов / один: для каких доменов, чем подтверждается, когда истекает, что не так) | certnew (выпустить сертификат от Let's Encrypt) | certimport (загрузить свой сертификат + ключ) | certupdate (имя, описание, метки, защита от удаления; содержимое — только у загруженного) | certdel (удалить, confirm: true) | cdn / cdninfo (список и карточка CDN-ресурсов) | cdncreate (создать ресурс: домен + бакет + сертификат, ПЛАТНО) | cdnupdate (привязать сертификат, включить/выключить, сменить источник, доп. домены) | cdnpurge (очистить кэш) | cdndel (удалить ресурс, confirm: true) | origins / origincreate / originupdate / origindel (группы источников). ГЛАВНОЕ, ЧТО НАДО ЗНАТЬ: сертификат бесплатен, платит CDN-ресурс (150 ₽/мес за ресурс — пакет из 150 ГБ исходящего трафика и 100 млн запросов включён, деньги уходят даже при нулевом трафике), поэтому cdncreate требует confirm: true после согласия пользователя. Домены сертификата ИЗМЕНИТЬ НЕЛЬЗЯ — «добавить домен» значит выпустить новый сертификат. Пока домен не подтверждён (DNS-запись _acme-challenge.<домен> или файл на сайте), сертификат не выпустится и HTTPS не заработает: запись подтверждения — только ОДНА (CNAME или TXT), CNAME подтверждается один раз и продления проходят сами, TXT придётся обновлять каждые 60 дней. Маску (*.example.com) файлом подтвердить нельзя — только DNS. Сертификат и CDN-ресурс должны быть в ОДНОМ каталоге. У ресурса CDN основной домен задаётся один раз и потом не меняется. Для бакета-источника нужен заголовок Host с адресом бакета-сайта (<бакет>.website.yandexcloud.net) — модуль ставит его сам; без него бакет отвечает 404. Удаление сертификата и ресурса необратимо и требует confirm: true: сертификат может носить работающий сайт.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "overview | certs | cert | certnew | certimport | certupdate | certdel | cdn | cdninfo | cdncreate | cdnupdate | cdnpurge | cdndel | origins | origincreate | originupdate | origindel" },
          certificate: { type: "string", description: "Сертификат: имя, id или домен, для которого он выдан (для cert, certupdate, certdel, cdncreate, cdnupdate)" },
          name: { type: "string", description: "Для certnew/certimport/origincreate: имя (строчные латинские буквы, цифры, дефис), например site-cert" },
          domains: { type: "array", items: { type: "string" }, description: "Для certnew: домены сертификата, например [\"cdn.example.com\"] или [\"example.com\", \"*.example.com\"]" },
          challengeType: { type: "string", description: "Для certnew: DNS (запись в зоне — по умолчанию, годится и для маски) или HTTP (файл на сайте)" },
          certificateText: { type: "string", description: "Для certimport: содержимое сертификата в PEM (весь файл целиком)" },
          privateKey: { type: "string", description: "Для certimport: приватный ключ в PEM (весь файл целиком)" },
          chain: { type: "string", description: "Для certimport: цепочка сертификатов в PEM (если есть)" },
          cname: { type: "string", description: "Для cdncreate: основной домен сайта, например cdn.example.com — задаётся один раз и больше не меняется" },
          bucket: { type: "string", description: "Для cdncreate: имя бакета-источника; облако само создаст группу источников и поставит нужный заголовок Host" },
          originGroupId: { type: "string", description: "Для cdncreate/cdnupdate: id готовой группы источников (список: action origins)" },
          secondaryHostnames: { type: "array", items: { type: "string" }, description: "Для cdncreate/cdnupdate: дополнительные домены ресурса" },
          website: { type: "boolean", description: "Для cdncreate: false — бакет без хостинга статики (по умолчанию true: бакет как сайт, отдаёт index.html)" },
          originProtocol: { type: "string", description: "Для cdncreate/cdnupdate: HTTP, HTTPS или MATCH (автоматически); для бакета по умолчанию HTTP" },
          active: { type: "boolean", description: "Для cdncreate/cdnupdate: false — ресурс выключен и ничего не отдаёт" },
          disableSsl: { type: "boolean", description: "Для cdnupdate: true — отвязать сертификат и оставить сайт только по http" },
          resource: { type: "string", description: "Для cdninfo/cdnupdate/cdnpurge/cdndel: CDN-ресурс — домен или id" },
          paths: { type: "array", items: { type: "string" }, description: "Для cdnpurge: что вычистить из кэша — /index.html, /img/* (звёздочка только в конце). До 10 путей за раз" },
          all: { type: "boolean", description: "Для cdnpurge: true — очистить кэш целиком (нагрузка на источник)" },
          group: { type: "string", description: "Для originupdate/origindel: имя или id группы источников" },
          origins: { type: "array", items: { type: "object" }, description: "Для origincreate/originupdate: источники целиком — [{ bucket: \"имя-бакета\" }] или [{ source: \"files.example.com\", backup: true }]. Список ЗАМЕНЯЕТСЯ целиком" },
          useNext: { type: "boolean", description: "Для origincreate/originupdate: при ошибке источника брать следующий (по умолчанию true)" },
          newName: { type: "string", description: "Для certupdate/originupdate: новое имя" },
          description: { type: "string", description: "Для certnew/certimport/certupdate: описание" },
          labels: { type: "object", description: "Для certnew/certupdate/cdncreate/cdnupdate: метки (ключ → значение)" },
          deletionProtection: { type: "boolean", description: "Для certnew/certupdate: защита сертификата от удаления" },
          confirm: { type: "boolean", description: "true — согласие пользователя: на создание платного CDN-ресурса (150 ₽/мес за ресурс) или на необратимое удаление сертификата, ресурса или группы источников" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycRegistry",
      description:
        "Yandex Cloud: образы Container Registry — посмотреть и почистить. action: images (образы реестра: имя, теги, размер, id) | delete (удалить образ ВМЕСТЕ со всеми его тегами). registry — имя или id реестра (список: ycList service containerRegistry); без registry работает, только если реестр в каталоге один. image — id образа (из action images) или его тег. Образы копятся с каждой выкаткой и занимают платное хранилище, но delete необратим: спрашивай пользователя перед удалением и не удаляй тег, на который ссылается работающий контейнер. delete требует чекбокса «Разрешить агенту удалять ресурсы».",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "images | delete" },
          registry: { type: "string", description: "Имя или id реестра (необязательно, если в каталоге один реестр)" },
          image: { type: "string", description: "id образа или его тег (можно также imageId или tag)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycDb",
      description:
        "Yandex Cloud: таблицы и записи базы YDB (создать базу: ycCreate service ydb). Две половины. ДОКУМЕНТНЫЕ таблицы (Document API, DynamoDB-совместимый): action: tables (список таблиц) | create (создать таблицу) | describe (структура и число записей) | put (положить запись) | get (одна запись по key) | scan (показать записи) | delete (убрать запись) | drop (удалить таблицу вместе с записями, необратимо). В этих таблицах в колонках живёт ТОЛЬКО первичный ключ: keys — поля ключа, например { \"id\": \"S\" } (первый — ключ поиска, остальные — сортировки, тип S/N/B), item и key — обычные пары «поле → значение», типы API ставит сам. ОБЫЧНЫЕ таблицы и любые запросы — action query с полем query (YQL, тот же язык, что в консоли облака): SELECT, CREATE TABLE с настоящими колонками, INSERT, UPSERT и т.д. (например query: \"CREATE TABLE pets (id Uint64, name Utf8, PRIMARY KEY (id))\" или \"SELECT * FROM pets LIMIT 10\"). database — имя или id базы (без него работает, только если база в каталоге одна). create, put и изменяющие query (CREATE/INSERT/UPSERT/UPDATE) требуют чекбокса «Разрешить агенту создавать ресурсы»; delete, drop и необратимые query (DROP/DELETE/ALTER/TRUNCATE) — «…удалять ресурсы». YQL идёт по gRPC (Ydb.Query) — интернетом и токеном, внешний yc-клиент не нужен.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "tables | create | describe | put | get | scan | delete | drop | query" },
          database: { type: "string", description: "Имя или id базы YDB (необязательно, если в каталоге одна база)" },
          table: { type: "string", description: "Имя таблицы. Обязательно для всех действий, кроме tables и query" },
          keys: { type: "object", description: "Для create: поля первичного ключа, например { \"id\": \"S\" }" },
          item: { type: "object", description: "Для put: запись полями, например { \"id\": \"1\", \"name\": \"Tom\", \"price\": 10.5 }" },
          key: { type: "object", description: "Для get/delete: значения полей первичного ключа записи" },
          limit: { type: "integer", description: "Для scan: сколько записей показать (по умолчанию 20, максимум 100)" },
          query: { type: "string", description: "Для query: текст на YQL, например SELECT * FROM pets LIMIT 10 или CREATE TABLE … (…). Опасные запросы (DROP/DELETE/ALTER/TRUNCATE) требуют разрешения на удаление" },
          maxRows: { type: "integer", description: "Для query: сколько строк набора показать (по умолчанию 50)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycApiGw",
      description:
        "Yandex Cloud: API-шлюз (API Gateway) — создать из OpenAPI-спецификации, посмотреть её, поправить и удалить. Шлюз — «вход» в приложение: он принимает запросы по своему адресу <id>.apigw.yandexcloud.net и разбирает их по спецификации. action: list (шлюзы каталога: имя, статус, адрес) | gateway (карточка шлюза) | spec (текст OpenAPI-спецификации) | create (создать шлюз ИЗ спецификации) | update (правка спецификации, имени, меток, времени) | delete (удалить, необратимо). name — имя нового шлюза (строчные латинские буквы, цифры и дефис), spec — текст OpenAPI (JSON или YAML) — обязателен при create и нужен при update; без спецификации шлюз нечего обслуживать. gateway — имя, id или адрес шлюза. Правка идёт МАСКОЙ: меняется только то, что заполнено. create требует чекбокса «Разрешить агенту создавать ресурсы», update — «…менять ресурсы», delete — «…удалять ресурсы». Куда уводить запрос, задаёт интеграция x-yc-apigateway-integration внутри метода спецификации (dummy — ответ без ресурсов, cloud-functions — функция, container — контейнер, object-storage — файл бакета). Удаление меняет адрес: всё, что на него ссылалось (DNS, сайт, бот), получит ошибку — спрашивай пользователя.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | gateway | spec | create | update | delete" },
          gateway: { type: "string", description: "Имя, id или адрес шлюза (для gateway/spec/update/delete)" },
          name: { type: "string", description: "Для create: имя нового шлюза (строчные латиница/цифры/дефис, 2–63 символа)" },
          newName: { type: "string", description: "Для update: новое имя шлюза" },
          spec: { type: "string", description: "Текст OpenAPI-спецификации (JSON или YAML). Обязателен при create, при update — если меняется" },
          format: { type: "string", description: "Для spec: формат ответа — YAML или JSON (по умолчанию как задано)" },
          description: { type: "string", description: "Описание шлюза" },
          executionTimeout: { type: "string", description: "Время выполнения одного вызова в секундах (например 5)" },
          labels: { type: "object", description: "Метки (ключ → значение)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycStorage",
      description:
        "Yandex Cloud: файлы в бакете Object Storage — посмотреть, положить, забрать, убрать и открыть наружу. action: list (что лежит в бакете, можно prefix — «папка») | upload (положить файл) | download (забрать объект к себе) | delete (убрать объект) | public (открыть бакет для чтения из интернета) | private (закрыть обратно). bucket — имя или id бакета (список: ycList service storage); без bucket работает, только если бакет в каталоге один. key — путь объекта в бакете (site/index.html), file — путь файла на ПК от рабочей папки, content — готовый текст вместо файла, to — куда сохранить скачанное. Для public/private key не нужен — права меняются у всего бакета. upload требует чекбокса «Разрешить агенту создавать ресурсы», delete — «Разрешить агенту удалять ресурсы», public/private — «Разрешить агенту делать бакет публичным». Тип содержимого ставится по расширению ключа. Важно: открытый адрес объекта (https://storage.yandexcloud.net/<бакет>/<ключ>) работает у других, только если у бакета включён публичный доступ на чтение. Про action public: файлы станет читать кто угодно из интернета и они будут видны поисковикам — поэтому вызывай его ТОЛЬКО по явной просьбе пользователя и никогда для бакета с паролями или личными файлами (для закрытых данных есть ycSecret).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | upload | download | delete | public | private" },
          bucket: { type: "string", description: "Имя или id бакета (необязательно, если в каталоге один бакет)" },
          key: { type: "string", description: "Путь объекта в бакете, например site/index.html (можно также object)" },
          file: { type: "string", description: "Для upload: путь файла от рабочей папки. Для download: куда сохранить (можно to)" },
          content: { type: "string", description: "Для upload: готовое содержимое вместо файла с ПК" },
          to: { type: "string", description: "Для download: путь, куда сохранить объект (по умолчанию — имя объекта в рабочей папке)" },
          prefix: { type: "string", description: "Для list: показывать только объекты с таким началом ключа («папка»)" },
          limit: { type: "integer", description: "Для list: сколько объектов показать (по умолчанию 1000)" },
          contentType: { type: "string", description: "Для upload: тип содержимого вручную (по умолчанию по расширению ключа)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sheetWrite",
      description:
        "Собрать таблицу в НАСТОЯЩИЙ файл Excel (.xlsx) или .csv в рабочей папке. Так собираются отчёты, сметы, выгрузки, которые человек потом открывает в Excel. Данные можно передать как rows (двумерный массив строк), objects (массив объектов — шапка соберётся из ключей), csv (готовый текст с разделителями) или sheets (несколько листов: [{ name, rows }]). Числа и булевы остаются числами (в Excel считаются формулами), строки с запятыми и кавычками экранируются. Формат: xlsx (по умолчанию) или csv. Пример: sheetWrite { path: \"отчёт.xlsx\", rows: [[\"Клиент\",\"Сумма\"],[\"ООО Ромашка\",120000]] }.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Куда сохранить — от рабочей папки (report.xlsx, отчёты/март.csv)" },
          format: { type: "string", description: "xlsx (по умолчанию) или csv; определяет расширение файла" },
          name: { type: "string", description: "Имя листа при одном листе (по умолчанию «Лист1»)" },
          rows: { type: "array", description: "Данные: массив строк (каждая строка — массив ячеек)" },
          objects: { type: "array", description: "Данные: массив объектов — первая строка станет шапкой из ключей" },
          csv: { type: "string", description: "Готовый CSV/TSV-текст с данными" },
          sheets: {
            type: "array",
            description: "Несколько листов книги: [{ name, rows }]. Если задано — rows/objects/csv игнорируются",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Имя листа" },
                rows: { type: "array", description: "Строки этого листа" },
              },
            },
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sheetRead",
      description:
        "Прочитать таблицу из файла (.xlsx или .csv) в рабочей папке и показать её модели таблицей. Для .xlsx можно указать лист (sheet) по имени; as: \"json\" вернёт массив объектов (шапка — первая строка). Используй, чтобы проверить собранный отчёт или разобрать чужой файл Excel.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Файл таблицы от рабочей папки (.xlsx/.csv)" },
          sheet: { type: "string", description: "Имя листа в книге (по умолчанию — первый)" },
          limit: { type: "integer", description: "Сколько строк показать (по умолчанию 200)" },
          as: { type: "string", description: "Формат ответа: table (по умолчанию) или json" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gSheetRead",
      description:
        "Прочитать диапазон Google-таблицы («живой», общей) через API по ключу service account. spreadsheet — ссылка на таблицу или её id, range — диапазон в A1-нотации (например \"Лист1!A1:D20\"). Ключ берётся из настроек (Настройки → Таблицы → «Ключ service account»); без ключа инструмент не падает, а вернёт рецепт браузерного пути (browserOpen + vaultFill). Таблицу надо расшарить на e-mail сервис-аккаунта.",
      parameters: {
        type: "object",
        properties: {
          spreadsheet: { type: "string", description: "Ссылка на Google-таблицу или её id (можно url/id)" },
          range: { type: "string", description: "Диапазон A1, например \"Лист1!A1:D20\" (по умолчанию A1)" },
          limit: { type: "integer", description: "Сколько строк показать (по умолчанию 200)" },
          as: { type: "string", description: "Формат ответа: table (по умолчанию) или json" },
        },
        required: ["spreadsheet"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gSheetWrite",
      description:
        "Записать (перезаписать) диапазон Google-таблицы через API по ключу service account. spreadsheet — ссылка/id, range — куда писать (\"Лист1!A1\"), values — массив строк или массив объектов. Требуется редактирование (роль Редактор у сервис-аккаунта). Без ключа вернёт браузерный рецепт.",
      parameters: {
        type: "object",
        properties: {
          spreadsheet: { type: "string", description: "Ссылка на Google-таблицу или её id" },
          range: { type: "string", description: "Куда писать, A1-нотация (по умолчанию A1)" },
          values: { type: "array", description: "Данные: массив строк или массив объектов" },
        },
        required: ["spreadsheet", "values"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gSheetAppend",
      description:
        "Добавить строки В КОНЕЦ Google-таблицы через API по ключу service account (не затирая существующие). spreadsheet — ссылка/id, range — лист/начало (\"Лист1!A1\"), values — массив строк или объектов. Так ведут общую таблицу заявок, журнал, отчёт, куда копится по строке.",
      parameters: {
        type: "object",
        properties: {
          spreadsheet: { type: "string", description: "Ссылка на Google-таблицу или её id" },
          range: { type: "string", description: "Лист/начало, A1-нотация (по умолчанию A1)" },
          values: { type: "array", description: "Данные: массив строк или массив объектов" },
        },
        required: ["spreadsheet", "values"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gSheetInfo",
      description:
        "Показать, что за Google-таблица: название, id и листы с их размерами. Полезно перед чтением/записью, чтобы узнать имена листов. spreadsheet — ссылка или id; ключ берётся из настроек.",
      parameters: {
        type: "object",
        properties: {
          spreadsheet: { type: "string", description: "Ссылка на Google-таблицу или её id" },
        },
        required: ["spreadsheet"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gSheetCreate",
      description:
        "Создать новую Google-таблицу по ключу service account. title — название. Вернёт id и ссылку. Важно: таблица принадлежит сервис-аккаунту — чтобы её видел человек, открой ссылку и расшарь на свой аккаунт, либо веди её через gSheetWrite/gSheetAppend.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Название новой таблицы" },
        },
        required: ["title"],
      },
    },
  },
];
  return { TOOL_DEFINITIONS };
});

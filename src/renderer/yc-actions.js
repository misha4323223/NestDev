"use strict";

/* ─── Действия облака в интерфейсе (не только у агента) ──────────────────────
   Зачем этот модуль. Части 69–73 научили агента работать с машинами, IAM,
   функциями, деньгами и HTTPS-сайтом, но в окне из этого не было НИЧЕГО: плитки
   показывали списки, а создать машину, выдать роль, выкатить версию функции или
   выпустить сертификат можно было только попросив модель. Так родился «разрыв»:
   каналы IPC и мост окна существовали, а виджета, который их зовёт, не было.

   Что здесь есть. Одна таблица `ACTIONS`: для каждого семейства — действия с
   русской подписью, полями формы и видом результата. Тела запросов в облако
   по-прежнему живут в модулях главного процесса (src/yc-*.js) — здесь только
   выбор действия, сборка аргументов и показ ответа словами.

   Правила, которые нельзя терять при правке:
     • НЕОБРАТИМОЕ спрашивается у человека ДО запроса (окно подтверждения), а
       платное — сначала у облака: канал отвечает `needsConfirm` и ценой, и
       только второе нажатие «Подтвердить» отправляет запрос. Так цена видна
       ровно та, которую считает облако, а не выдуманная в интерфейсе.
     • СЕКРЕТ (ключ IAM, пара ключей SSH) показывается ОДИН РАЗ и в отдельной
       рамке: облако отдаёт его единственным ответом, второго не будет. В журнал
       действий значение не попадает — только подпись «ключ создан».
     • Галочки «Разрешить АГЕНТУ…» здесь НЕ спрашиваются: они ограничивают
       МОДЕЛЬ, а человек в своём окне действует сам — так же, как у записей DNS и
       версий секрета в консоли.
     • Список допустимых действий (`OPS`) обязан совпадать с тем, что принимает
       src/yc-ipc.js: иначе кнопка обещает действие, на которое канал отвечает
       отказом. Это сверяет test/yc-actions.test.js разбором самих отказов.

   Модуль самодостаточный (как yc-console.js): зависимости берёт из window
   лениво, поэтому не требует проводки в app.js и не ломает игрушечное окно.  */

(function () {
  // Семейство → канал моста, который его обслуживает.
  const CHANNELS = {
    compute: "ycCompute",
    vpc: "ycVpc",
    iam: "ycIam",
    cloudFunctions: "ycFunctions",
    cdn: "ycCdn",
    // Сертификаты живут своей плиткой, а канал у них общий с CDN: тела запросов
    // Certificate Manager и Cloud CDN лежат в одном модуле (src/yc-cdn.js).
    certificateManager: "ycCdn",
    billing: "ycBilling",
    // Monitoring: метрики каталога. Тела запросов — в src/yc-monitoring.js;
    // канал — «yc:monitoring» в src/yc-ipc.js.
    monitoring: "ycMonitoring",
    // Яндекс AI: перевод, текст со снимка и речь. Тела запросов — в src/yc-ai.js
    // (тот же модуль, что у агента), канал — «yc:ai» в src/yc-ipc.js.
    ai: "ycAi",
    // Managed-базы: PostgreSQL, MySQL и ClickHouse — один канал на три базы
    // (у них один API, mdb.api.cloud.yandex.net): база выбирается полем engine,
    // которое подставляет семейство (FAMILIES[...].fixed), а не поле формы.
    postgresql: "ycMdb",
    mysql: "ycMdb",
    clickhouse: "ycMdb",
    // DNS-зоны и записи: записи умели агент и карточка зоны, а у плитки действий
    // не было вовсе. Канал один на зоны и записи: они живут вместе.
    dns: "ycDns",
    // Группы машин (Instance Groups): тот же модуль, что у агента (src/yc-ig.js),
    // канал — «yc:ig». Формы как у машин, но ресурс другой: группа сама создаёт
    // машины по шаблону и держит их число.
    instanceGroups: "ycIg",
    // Application Load Balancer (часть 91, заход 2): балансировщики, группы
    // целей, HTTP-роутеры и чтение групп бэкендов — один канал «yc:alb».
    alb: "ycAlb",
    // Serverless-контейнеры (часть 91, заход 8): у сервиса уже был список,
    // создание пустого контейнера и откат из карточки, а новая ревизия, тёплые
    // экземпляры и публичный доступ — только у агента. Канал «yc:container»
    // зовёт те же функции (src/yandex-cloud.js).
    serverlessContainers: "ycContainer",
    // База YDB (часть 91, заход 9): таблицы и записи через Document API. До этого
    // у сервиса были только создание базы и ПРОСМОТР таблиц в карточке, а у
    // плитки действий — ничего. Канал «yc:db» зовёт тот же экземпляр
    // src/yc-db.js, что и агент (один кэш IAM-токена, одна ошибка сети).
    ydb: "ycDb",
    // Object Storage (часть 91, заход 10): файлы бакета. До этого объекты умел
    // только агент (`ycStorage`), а карточка бакета — лишь показывать список и
    // удалять по одному файлу. Канал «yc:storage» зовёт ту же S3-часть
    // src/yandex-cloud.js, что и агент (IAM-токен БЕЗ подписи AWS, XML-ответы,
    // предел одного запроса).
    storage: "ycStorage",
    // Группы логов (часть 91, заход 11): группа — это «куда собирать логи», и
    // без неё ни ревизия контейнера, ни разбор запросов балансировщика некуда
    // направить. Записи читаются по gRPC (канал yc:logs), а сами группы — обычный
    // REST того же хоста: канал «yc:logGroups» зовёт тот же src/yc-logs.js.
    logging: "ycLogGroups",
    // API-шлюз (часть 91, заход 12): у сервиса была только плитка-список и
    // общее создание пустого ресурса, а шлюз целиком задаётся OpenAPI-
    // спецификацией. Канал «yc:apigw» зовёт тот же src/yc-apigw.js, что и агент:
    // создать из спецификации, показать её, поправить и удалить.
    apiGateway: "ycApiGw",
    // Lockbox (часть 91, заход 14): у сервиса была плитка-список, а посмотреть
    // секрет и версии, выдать доступ и удалить — только в консоли облака. Канал
    // «yc:lockbox» зовёт тела запросов из src/yandex-cloud.js, проверки — из
    // src/yc-lockbox.js.
    lockbox: "ycLockbox",
    // Container Registry (часть 91, заход 14): реестр был списком, образы — в
    // карточке; создать реестр, посмотреть образы, убрать их пачкой — впервые.
    // Канал «yc:registry» зовёт src/yandex-cloud.js и src/yc-registry.js.
    containerRegistry: "ycRegistry",
  };

  // Допустимые действия каждого канала. Сверяется с отказами в src/yc-ipc.js.
  const OPS = {
    compute: ["list", "card", "create", "delete", "start", "stop", "restart", "serial", "metrics", "snapshot", "delsnapshot", "cleansnapshots", "restoredisk", "sshkey"],
    vpc: ["list", "subnets", "groups", "addresses", "addsubnet", "delsubnet", "addgroup", "delgroup", "addrule", "delrule", "reserve", "release"],
    iam: ["list", "card", "keys", "roles", "create", "update", "delete", "grant", "revoke", "newkey", "delkey"],
    cloudFunctions: ["list", "card", "versions", "runtimes", "create", "update", "deploy", "invoke", "tag", "untag", "delversion", "delete", "public", "private", "access"],
    cdn: ["overview", "certs", "cert", "certnew", "certimport", "certupdate", "certdel", "cdn", "cdnlist", "cdninfo", "cdncreate", "cdnupdate", "cdnpurge", "cdndel", "origins", "origincreate", "originupdate", "origindel"],
    billing: ["overview", "accounts", "account", "budgets", "price", "services", "leaks"],
    monitoring: ["overview", "names", "metrics"],
    ai: ["translate", "languages", "detect", "ocr", "voices", "speak", "listen", "models", "tokens", "complete", "embed"],
    postgresql: ["list", "presets", "card", "create", "hosts", "databases", "users", "logs", "operations", "start", "stop", "delete"],
    mysql: ["list", "presets", "card", "create", "hosts", "databases", "users", "logs", "operations", "start", "stop", "delete"],
    clickhouse: ["list", "presets", "card", "create", "hosts", "databases", "users", "logs", "operations", "start", "stop", "delete"],
    dns: ["zones", "card", "records", "add", "delete"],
    instanceGroups: ["list", "card", "instances", "operations", "create", "start", "stop", "delete"],
    alb: ["list", "card", "targets", "routers", "backends", "health", "targetnew", "tgupdate", "targetadd", "targetremove", "targetdel", "routernew", "routerupd", "routerdel", "backnew", "backupd", "backdel", "listeneradd", "listenerupd", "listenerdel", "lbupdate", "lbnew", "lbstart", "lbstop", "lbdel"],
    serverlessContainers: ["list", "card", "revisions", "revision", "newrev", "rollback", "update", "public", "private"],
    ydb: ["list", "tables", "table", "create", "scan", "get", "put", "delete", "drop", "query"],
    storage: ["list", "objects", "upload", "download", "delete", "url", "access", "public", "private"],
    logging: ["list", "group", "create", "update", "delete"],
    apiGateway: ["list", "gateway", "spec", "create", "update", "delete"],
    lockbox: ["list", "secret", "versions", "create", "putversion", "grant", "delete"],
    containerRegistry: ["list", "images", "create", "delimage", "clean", "delete"],
  };

  const FAMILIES = {
    compute: { title: "Виртуальные машины", ru: "машина" },
    vpc: { title: "Сети VPC", ru: "сеть" },
    iam: { title: "Сервисные аккаунты", ru: "аккаунт" },
    cloudFunctions: { title: "Функции", ru: "функция" },
    cdn: { title: "Сертификаты и CDN", ru: "ресурс" },
    certificateManager: { title: "Сертификаты", ru: "сертификат" },
    billing: { title: "Деньги в облаке", ru: "аккаунт" },
    monitoring: { title: "Monitoring", ru: "метрика" },
    // «Запрос», а не «ресурс»: у Яндекс AI нет объектов каталога — платят за сам
    // запрос к сервису, и подпись обязана говорить об этом прямо.
    ai: { title: "Яндекс AI", ru: "запрос" },
    // Managed-базы: три семейства (у каждой базы своя плитка), но один канал.
    // `fixed` — это то, чем формы трёх баз отличаются друг от друга: поле
    // engine подставляется самим семейством, чтобы не спрашивать человека
    // «какая это база», когда он уже нажал кнопку в конкретной плитке.
    postgresql: { title: "PostgreSQL", ru: "кластер", fixed: { engine: "postgresql" } },
    mysql: { title: "MySQL", ru: "кластер", fixed: { engine: "mysql" } },
    clickhouse: { title: "ClickHouse", ru: "кластер", fixed: { engine: "clickhouse" } },
    dns: { title: "DNS-зоны", ru: "запись" },
    instanceGroups: { title: "Группы машин", ru: "группа" },
    alb: { title: "Application Load Balancer", ru: "балансировщик" },
    serverlessContainers: { title: "Serverless-контейнеры", ru: "контейнер" },
    // «База», а не «таблица»: кнопка стоит на плитке «YDB», а таблиц внутри базы
    // может быть много — спрашивают именно базу.
    ydb: { title: "YDB", ru: "база" },
    storage: { title: "Object Storage", ru: "бакет" },
    // «Лог-группа», а не «лог»: плитка спрашивает про группу — место, куда
    // собираются логи, а не про сами записи.
    logging: { title: "Логи", ru: "лог-группа" },
    // «Шлюз», а не «ресурс»: кнопка стоит на плитке «API-шлюз» и спрашивает
    // про шлюз — тот, что отвечает на запросы по своему адресу.
    apiGateway: { title: "API-шлюзы", ru: "шлюз" },
    // «Секрет», а не «ресурс»: кнопка стоит на плитке «Секреты» и спрашивает про
    // секрет — место, где живёт ключ или пароль.
    lockbox: { title: "Секреты", ru: "секрет" },
    // «Реестр», а не «образ»: кнопка стоит на плитке «Реестр образов» и
    // спрашивает про сам реестр, а образы — уже внутри него.
    containerRegistry: { title: "Реестр образов", ru: "реестр" },
  };

  // Действия управляемой базы. Одна форма на три базы: набор полей у PostgreSQL,
  // MySQL и ClickHouse одинаков, различаются только версии и типы логов
  // (у ClickHouse явного списка версий в справочнике API нет — её называют
  // вручную). Пароль пользователя при создании генерируется на стороне модуля и
  // показывается ОДИН раз — поэтому у действия стоит secretLabel.
  function dbActions(engine) {
    const versions = { postgresql: ["11", "12", "13", "14", "15", "16", "17", "18"], mysql: ["5.7", "8.0", "8.4"], clickhouse: [] }[engine] || [];
    const logTypes = { postgresql: ["POSTGRESQL", "POOLER", "REPACK"], mysql: ["MYSQL", "POOLER"], clickhouse: ["CLICKHOUSE", "KEEPER"] }[engine] || [];
    const needCluster = target("Кластер (имя или id)", "cluster");
    const presetOptions = from(engine, "presets", (r) => (r.presets || []).map((p) => p.id), { engine: engine });
    return [
      { id: "list", ru: "Кластеры", op: "list", view: "lines" },
      { id: "presets", ru: "Классы хостов (ядра и память)", op: "presets", view: "lines" },
      { id: "card", ru: "Карточка: состояние, хосты, подключение", op: "card", view: "lines", target: needCluster },
      { id: "create", ru: "＋ Создать кластер (платно)", op: "create", view: "lines", paid: true, confirmArg: "confirm",
        secretLabel: "Пароль пользователя базы — показывается один раз",
        fields: [
          fld("name", "Имя кластера", { required: true, placeholder: "db-1" }),
          versions.length
            ? fld("version", "Версия базы", { required: true, type: "select", options: versions, value: versions[versions.length - 1] })
            : fld("version", "Версия базы", { required: true, placeholder: "например 24.8" }),
          fld("preset", "Класс хоста", { required: true, hint: "s2.micro — самый маленький; список — действием «Классы хостов»", options: presetOptions }),
          fld("subnet", "Подсеть", { required: true, hint: "Сеть определится по подсети; подсеть и зона — одной зоны", options: from("vpc", "subnets", (r) => (r.subnets || []).map((s) => s.name)) }),
          fld("diskGb", "Диск, ГБ", { type: "number", value: "20" }),
          fld("diskType", "Тип диска", { type: "select", options: ["network-ssd", "network-hdd"], value: "network-ssd" }),
          fld("zone", "Зона", { value: "ru-central1-a", hint: "Подсеть должна быть в этой же зоне" }),
          fld("user", "Пользователь базы", { value: "admin" }),
          fld("database", "Имя базы", { value: "db1" }),
          fld("publicIp", "Публичный адрес хосту", { type: "check" }),
        ] },
      { id: "hosts", ru: "Хосты (роли, зоны, адреса)", op: "hosts", view: "lines", target: needCluster },
      { id: "databases", ru: "Базы", op: "databases", view: "lines", target: needCluster },
      { id: "users", ru: "Пользователи и доступ", op: "users", view: "lines", target: needCluster },
      { id: "logs", ru: "Логи за период", op: "logs", view: "lines", target: needCluster,
        fields: [
          fld("minutes", "За сколько минут", { type: "number", value: "60" }),
          fld("serviceType", "Тип логов", { type: "select", options: logTypes }),
        ] },
      { id: "operations", ru: "История операций", op: "operations", view: "lines", target: needCluster },
      { id: "start", ru: "▶ Запустить", op: "start", view: "lines", target: needCluster },
      { id: "stop", ru: "■ Остановить (экономит деньги)", op: "stop", view: "lines", target: needCluster },
      { id: "delete", ru: "🗑 Удалить кластер", op: "delete", view: "lines", danger: true, confirmArg: "confirm", target: needCluster },
    ];
  }

  // ── Поля форм ─────────────────────────────────────────────────────────────
  function fld(key, label, extra) {
    return Object.assign({ key: key, label: label, type: "text" }, extra || {});
  }
  function target(label, key) {
    return fld(key || "name", label, { required: true });
  }
  // Подсказки-варианты берутся у облака (наборы, подсети, зоны, языки). Не
  // пришли — поле остаётся обычным текстом: действие всё равно выполнимо.
  const from = (channel, op, pick, args) => ({ channel: channel, op: op, pick: pick, args: args || null });

  // ── База YDB: таблицы и записи ──────────────────────────────────────────
  // Таблицы умели агент и read-only карточка базы, а у плитки действий не было
  // ни таблиц, ни записи, ни удаления. Работа идёт через Document API, и он
  // диктует честную форму: «создать таблицу» спрашивает КЛЮЧ, а не колонки — в
  // колонках документной таблицы живёт ровно ключ, остальные поля лежат в самих
  // записях. Произвольные колонки (YQL-таблицы) — другой протокол, и кнопки,
  // которая за него ничего не делает, здесь нет.
  //
  // «Удалить таблицу» и «Удалить запись» помечены опасными и спрашивают дважды
  // (окно и канал): данные из окна вернуть нечем.
  // ── Object Storage: файлы бакета ────────────────────────────────────────
  // Бакет создаётся «для файлов и статики», а положить в него файл из окна было
  // нечем: объекты умел только агент, а карточка — лишь показывать список и
  // удалять по одному. Файл выбирает СИСТЕМНЫЙ диалог (его каналы — в
  // src/cloud-files-ipc.js), а байты читает и кладёт канал тем же S3-кодом, что
  // и агент: так у предела одного запроса одна копия.
  // Платность честная: платят за ОБЪЁМ (ГБ·месяц), а не за штуку файлов,
  // поэтому «Загрузить файл» помечено платным и говорит про объём, а не про
  // выдуманную цену за файл. Открытие бакета и оба удаления необратимы (danger).
  function storageActions() {
    const needBucket = fld("bucket", "Бакет (имя или id)", {
      required: true,
      hint: "Имя из действия «Бакеты и их состояние»; подсказка подставит список.",
      options: from("storage", "list", (r) => (r.buckets || []).map((b) => b.name)),
    });
    const needKey = fld("key", "Ключ в бакете (путь файла)", { required: true, placeholder: "site/index.html", hint: "Слеши делают «папки»: site/assets/app.js. Список — действием «Объекты бакета»." });
    return [
      { id: "list", ru: "Бакеты и их состояние", op: "list", view: "lines" },
      { id: "objects", ru: "Объекты бакета", op: "objects", view: "lines", target: needBucket,
        fields: [
          fld("prefix", "Префикс (папка в бакете)", { placeholder: "site/" }),
          fld("limit", "Сколько показать", { type: "number", value: "50" }),
        ] },
      { id: "upload", ru: "⬆ Загрузить файл", op: "upload", view: "lines", paid: true, confirmArg: "confirmed", target: needBucket,
        fields: [
          fld("file", "Файл на ПК", { type: "pick", required: true, pickApi: "pickCloudFile", fill: "key", hint: "Файл выбирается системным окном; его имя подставится в ключ бакета." }),
          needKey,
          fld("contentType", "Тип содержимого", { hint: "Пусто — определится по расширению. Для статики это важно: с неверным типом браузер скачает файл вместо того, чтобы показать." }),
        ] },
      { id: "download", ru: "⬇ Скачать объект", op: "download", view: "lines", target: needBucket,
        fields: [
          needKey,
          fld("to", "Куда сохранить", { type: "pick", pickApi: "pickCloudSave", pickArgs: (v) => ({ name: v && v.key ? String(v.key).split("/").pop() : "" }), hint: "Пусто — файл ляжет в рабочую папку агента под именем объекта." }),
        ] },
      { id: "url", ru: "🔗 Ссылка на объект", op: "url", view: "lines", target: needBucket,
        fields: [needKey] },
      { id: "access", ru: "Публичный доступ бакета", op: "access", view: "lines", target: needBucket },
      { id: "public", ru: "⚠ Открыть бакет для всех", op: "public", view: "lines", danger: true, confirmArg: "confirmed", target: needBucket },
      { id: "private", ru: "🔒 Закрыть бакет", op: "private", view: "lines", target: needBucket },
      { id: "delete", ru: "🗑 Удалить объект", op: "delete", view: "lines", danger: true, confirmArg: "confirmed", target: needBucket,
        fields: [needKey] },
    ];
  }

  // ── Группы логов Cloud Logging ────────────────────────────────────────────
  // Группа логов — «куда собирать логи». До захода её можно было только
  // ПОСМОТРЕТЬ списком на полке (сервис «Логи» уже был), а создать, переименовать
  // или удалить — только в консоли облака. Между тем без неё ни ревизия
  // контейнера, ни разбор запросов балансировщика некуда направить. Формы
  // честные: срок хранения — в часах (пусто/0 — без срока), метки — JSON, а
  // удаление необратимо и спрашивает подтверждение ДВАЖДЫ (окно и канал).
  function loggingActions() {
    const needGroup = fld("group", "Лог-группа (имя или id)", {
      required: true,
      hint: "Имя из действия «Лог-группы и их состояние»; подсказка подставит список.",
      options: from("logging", "list", (r) => (r.groups || []).map((g) => g.name)),
    });
    return [
      { id: "list", ru: "Лог-группы и их состояние", op: "list", view: "lines" },
      { id: "group", ru: "Подробности лог-группы", op: "group", view: "lines", target: needGroup },
      { id: "create", ru: "＋ Создать лог-группу", op: "create", view: "lines",
        fields: [
          fld("name", "Имя лог-группы", { required: true, placeholder: "app-logs", hint: "Строчная латиница, цифры и дефис, 2–63 символа; имя уникально в каталоге." }),
          fld("description", "Описание", { hint: "До 256 символов. Для чего группа — это единственная память о замысле." }),
          fld("retention", "Хранение, часов", { type: "number", hint: "Пусто или 0 — без срока. Хранение логов платное за объём." }),
          fld("dataStream", "Поток данных", { hint: "Необязательное имя потока (до 512 символов) для выгрузки в Data Streams." }),
          fld("labels", "Метки (JSON)", { type: "textarea", placeholder: '{"env":"prod"}', hint: "Ключ — строчная латиница/цифры/дефис, значение — до 64 символов." }),
        ] },
      { id: "update", ru: "✎ Править лог-группу", op: "update", view: "lines", target: needGroup,
        fields: [
          fld("newName", "Новое имя", { hint: "Пусто — имя не меняется." }),
          fld("description", "Описание", { hint: "Пусто — не меняется." }),
          fld("retention", "Хранение, часов", { type: "number", hint: "Пусто — не меняется; 0 — без срока." }),
          fld("dataStream", "Поток данных", { hint: "Пусто — не меняется." }),
          fld("labels", "Метки (JSON)", { type: "textarea", placeholder: '{"env":"prod"}', hint: "Пусто — метки не меняются." }),
        ] },
      { id: "delete", ru: "🗑 Удалить лог-группу", op: "delete", view: "lines", danger: true, confirmArg: "confirmed", target: needGroup },
    ];
  }

  // ── API-шлюз (API Gateway) ────────────────────────────────────────────────
  // Шлюз целиком задаётся OpenAPI-спецификацией: её и спрашиваем при создании.
  // «Посмотреть спецификацию» — отдельное действие: источников у шлюза нет
  // отдельным полем, всё живёт в тексте (интеграции x-yc-apigateway-integration).
  // Правка уходит МАСКОЙ (меняется только то, что заполнено), а удаление
  // необратимо: адрес <id>.apigw.yandexcloud.net перестанет отвечать — поэтому
  // оно опасное и спрашивает подтверждение дважды (окно и канал).
  function apigwActions() {
    const needGw = fld("gateway", "Шлюз (имя, id или адрес)", {
      required: true,
      hint: "Имя из действия «API-шлюзы и их состояние»; подсказка подставит список.",
      options: from("apiGateway", "list", (r) => (r.gateways || []).map((g) => g.name)),
    });
    const specField = (label) =>
      fld("spec", label, {
        type: "textarea",
        placeholder: "openapi: 3.0.0\ninfo:\n  title: my-api\npaths:\n  /hello:\n    get:\n      x-yc-apigateway-integration:\n        type: dummy",
        hint: "Текст OpenAPI (JSON или YAML). Куда уводить запрос, говорит интеграция x-yc-apigateway-integration внутри метода: dummy — ответ без ресурсов, cloud-functions — функция, container — контейнер, object-storage — файл бакета.",
      });
    return [
      { id: "list", ru: "API-шлюзы и их состояние", op: "list", view: "lines" },
      { id: "gateway", ru: "Подробности шлюза", op: "gateway", view: "lines", target: needGw },
      { id: "spec", ru: "Спецификация шлюза", op: "spec", view: "lines", target: needGw,
        fields: [fld("format", "Формат (YAML или JSON)", { hint: "Пусто — тот формат, в котором спецификацию задали." })] },
      { id: "create", ru: "＋ Создать шлюз из спецификации", op: "create", view: "lines",
        fields: [
          fld("name", "Имя шлюза", { required: true, placeholder: "my-api", hint: "Строчная латиница, цифры и дефис, 2–63 символа; имя уникально в каталоге." }),
          Object.assign(specField("OpenAPI-спецификация"), { required: true }),
          fld("description", "Описание", { hint: "До 256 символов. Для чего шлюз — это единственная память о замысле." }),
          fld("executionTimeout", "Время выполнения, секунд", { type: "number", hint: "Пусто — по умолчанию. Сколько максимум может считаться один вызов." }),
          fld("labels", "Метки (JSON)", { type: "textarea", placeholder: '{"env":"prod"}', hint: "Ключ — строчная латиница/цифры/дефис, значение — до 64 символов." }),
        ] },
      { id: "update", ru: "✎ Править шлюз", op: "update", view: "lines", target: needGw,
        fields: [
          fld("newName", "Новое имя", { hint: "Пусто — имя не меняется." }),
          fld("description", "Описание", { hint: "Пусто — не меняется." }),
          specField("Новая спецификация (пусто — не меняется)"),
          fld("executionTimeout", "Время выполнения, секунд", { type: "number", hint: "Пусто — не меняется." }),
          fld("labels", "Метки (JSON)", { type: "textarea", placeholder: '{"env":"prod"}', hint: "Метки ЗАМЕНЯЮТСЯ целиком: пусто — не меняются." }),
        ] },
      { id: "delete", ru: "🗑 Удалить шлюз", op: "delete", view: "lines", danger: true, confirmArg: "confirmed", target: needGw },
    ];
  }

  // ── Секреты Lockbox ────────────────────────────────────────────────────
  // Секрет — место, где живёт ключ или пароль; значение подставляет само облако,
  // а ревизия получает только ссылку. У плитки действий этого не было вовсе.
  // «Новая версия» принимает пары «ключ → значение»: значения уходят в облако и
  // обратно НИКОГДА не читаются — второй раз их не покажут, поэтому подсказка об
  // этом прямо в поле. Выдача доступа — это ПРАВО, а не чтение: роль по умолчанию
  // ровно та, что нужна ревизии. Удаление необратимо и спрашивает дважды.
  function lockboxActions() {
    const needSecret = fld("secret", "Секрет (имя или id)", {
      required: true,
      hint: "Имя из действия «Секреты и их состояние»; подсказка подставит список.",
      options: from("lockbox", "list", (r) => (r.secrets || []).map((s) => s.name)),
    });
    return [
      { id: "list", ru: "Секреты и их состояние", op: "list", view: "lines" },
      { id: "secret", ru: "Карточка секрета", op: "secret", view: "lines", target: needSecret },
      { id: "versions", ru: "Версии и имена ключей", op: "versions", view: "lines", target: needSecret },
      { id: "create", ru: "＋ Создать секрет", op: "create", view: "lines",
        fields: [fld("name", "Имя секрета", { required: true, placeholder: "app-env", hint: "Строчная латиница, цифры и дефис, 2–63 символа; имя уникально в каталоге." })] },
      { id: "putversion", ru: "↑ Новая версия (ключи и значения)", op: "putversion", view: "lines", target: needSecret,
        fields: [fld("entries", "Пары «ключ → значение» (JSON)", { type: "textarea", required: true, placeholder: '{"API_KEY":"…","DB_URL":"…"}', hint: "Значения уходят в облако и обратно не читаются — второй раз их не покажут. Ключ — латиница, цифры и знаки - _ . / \\ @." })] },
      { id: "grant", ru: "🔑 Выдать доступ сервисному аккаунту", op: "grant", view: "lines", target: needSecret,
        fields: [
          fld("serviceAccountId", "Сервисный аккаунт (id)", { required: true, hint: "Кому читать секрет — обычно сервисный аккаунт ревизии (плитка «Сервисные аккаунты»)." }),
          fld("role", "Роль", { value: "lockbox.payloadViewer", hint: "Ровно то, что нужно ревизии, чтобы прочитать значения. Без нужды не расширяй." }),
        ] },
      { id: "delete", ru: "🗑 Удалить секрет", op: "delete", view: "lines", danger: true, confirmArg: "confirmed", target: needSecret },
    ];
  }

  // ── Реестр образов Container Registry ──────────────────────────────────
  // Реестр копит образы с каждой выкаткой, а они занимают ПЛАТНОЕ хранилище.
  // «Убрать образы» берёт все или только старше N дней — так реестр чистят, не
  // удаляя по одному. Облако НЕ удаляет непустой реестр: удаление честно говорит
  // об этом, а не падает с 400. Оба удаления необратимы и спрашивают дважды.
  function registryActions() {
    const needReg = fld("registry", "Реестр (имя или id)", {
      required: true,
      hint: "Имя из действия «Реестры и их состояние»; подсказка подставит список.",
      options: from("containerRegistry", "list", (r) => (r.registries || []).map((x) => x.name)),
    });
    return [
      { id: "list", ru: "Реестры и их состояние", op: "list", view: "lines" },
      { id: "images", ru: "Образы реестра", op: "images", view: "lines", target: needReg },
      { id: "create", ru: "＋ Создать реестр", op: "create", view: "lines",
        fields: [fld("name", "Имя реестра", { required: true, placeholder: "app", hint: "Строчная латиница, цифры и дефис, 2–63 символа; имя уникально в каталоге. Адрес образов: cr.yandex/<id>/<образ>:<тег>." })] },
      { id: "delimage", ru: "🗑 Удалить образ", op: "delimage", view: "lines", danger: true, confirmArg: "confirmed", target: needReg,
        fields: [fld("image", "Образ (id или тег)", { required: true, hint: "Список и id — действием «Образы реестра». Удаление забирает ВСЕ теги образа; вернуть его нельзя." })] },
      { id: "clean", ru: "🧹 Убрать образы (все или старше N дней)", op: "clean", view: "lines", danger: true, confirmArg: "confirmed", target: needReg,
        fields: [fld("olderThanDays", "Старше, дней", { type: "number", hint: "Пусто или 0 — убрать ВСЕ образы реестра. Больше нуля — только старше N дней." })] },
      { id: "delete", ru: "🗑 Удалить реестр", op: "delete", view: "lines", danger: true, confirmArg: "confirmed", target: needReg },
    ];
  }

  // «Опасный» YQL-запрос определяем по ПЕРВОМУ слову каждого оператора (до «;») —
  // так SELECT с колонкой delete не пугает, а «SELECT 1; DROP TABLE x» — да. Это
  // ТОЛЬКО предварительный вопрос окна; канал (src/yc-yql.js) проверяет то же САМ
  // и отвечает needsConfirm — канал зовут не только кнопкой.
  function isDangerousQuery(text) {
    const kw = String(text || "")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .split(";")
      .map((p) => ((/[A-Za-z]+/.exec(p) || [""])[0] + "").toUpperCase());
    return kw.some((k) => k === "DROP" || k === "TRUNCATE" || k === "ALTER" || k === "DELETE");
  }

  function ydbActions() {
    const needDb = fld("database", "База (имя или id)", {
      hint: "Пусто — единственная база каталога; если баз несколько, выбери тут.",
      options: from("ydb", "list", (r) => (r.databases || []).map((d) => d.name)),
    });
    const needTable = fld("table", "Таблица", { required: true, hint: "Имя таблицы — список в действии «Таблицы базы»." });
    return [
      { id: "list", ru: "Базы YDB и их состояние", op: "list", view: "lines" },
      { id: "tables", ru: "Таблицы базы", op: "tables", view: "lines", target: needDb },
      { id: "table", ru: "Структура таблицы (ключ и размер)", op: "table", view: "lines", target: needDb,
        fields: [needTable] },
      { id: "create", ru: "＋ Создать таблицу", op: "create", view: "lines", target: needDb,
        fields: [
          needTable,
          fld("keys", "Поля первичного ключа (JSON)", { type: "textarea", required: true, placeholder: '{"id":"S"}', hint: "Первый ключ — ключ поиска (HASH), остальные — сортировки (RANGE). Тип: S — строка, N — число, B — байты. В колонках таблицы живёт только ключ." }),
        ] },
      { id: "scan", ru: "Записи таблицы", op: "scan", view: "lines", target: needDb,
        fields: [needTable, fld("limit", "Сколько записей", { type: "number", value: "20" })] },
      { id: "get", ru: "Прочитать запись по ключу", op: "get", view: "lines", target: needDb,
        fields: [needTable, fld("key", "Поля ключа (JSON)", { type: "textarea", required: true, placeholder: '{"id":"1"}', hint: "Значения полей первичного ключа — ключ виден в действии «Структура таблицы»." })] },
      { id: "put", ru: "↑ Положить запись", op: "put", view: "lines", target: needDb,
        fields: [needTable, fld("item", "Запись (JSON)", { type: "textarea", required: true, placeholder: '{"id":"1","name":"Tom","price":10.5}', hint: "Запись кладётся целиком: прежние поля такой же записи заменяются этим набором. Поля ключа в ней обязательны." })] },
      { id: "delete", ru: "🗑 Удалить запись", op: "delete", view: "lines", danger: true, confirmArg: "confirmed", target: needDb,
        fields: [needTable, fld("key", "Поля ключа (JSON)", { type: "textarea", required: true, placeholder: '{"id":"1"}' })] },
      { id: "drop", ru: "🗑 Удалить таблицу (вместе с записями)", op: "drop", view: "lines", danger: true, confirmArg: "confirmed", target: needDb,
        fields: [needTable] },
      // YQL — вторая половина YDB: в Document API выше в колонках живёт только
      // ключ, а настоящие колонки и SELECT — это YQL по gRPC (src/yc-yql.js).
      // Помечено опасным (вдруг запрос необратим) и спрашивает подтверждение
      // ПО ТЕКСТУ запроса: SELECT проходит без вопроса, DROP — с ним.
      { id: "query", ru: "Выполнить запрос YQL (SQL)", op: "query", view: "lines", danger: true, confirmArg: "confirmed",
        dangerIf: (v) => isDangerousQuery(v && v.query), target: needDb,
        fields: [
          fld("query", "Запрос YQL", { type: "textarea", required: true, placeholder: "SELECT * FROM pets LIMIT 10", hint: "YQL — язык YDB (тот же, что в консоли облака). Здесь настоящие колонки и таблицы: CREATE TABLE pets (id Uint64, name Utf8, PRIMARY KEY (id)). Опасные запросы (DROP, DELETE, ALTER, TRUNCATE) спросят подтверждение." }),
          fld("maxRows", "Сколько строк показать", { type: "number", value: "50" }),
        ] },
    ];
  }

  const ACTIONS = {
    // ── Виртуальные машины ──
    compute: [
      { id: "list", ru: "Машины, диски и хвосты", op: "list", view: "computeList" },
      { id: "card", ru: "Карточка машины", op: "card", view: "lines", target: target("Машина (имя или id)") },
      { id: "create", ru: "＋ Создать машину", op: "create", view: "lines", paid: true, confirmArg: "confirmed",
        fields: [
          fld("name", "Имя машины", { required: true, placeholder: "web-1" }),
          fld("preset", "Набор конфигурации", { hint: "micro / small / medium / full", options: from("compute", "list", (r) => r.presetKeys) }),
          fld("subnet", "Подсеть", { options: from("compute", "list", (r) => (r.subnets || []).map((s) => s.name)) }),
          fld("imageFamily", "Образ (семейство)", { value: "ubuntu-2204-lts" }),
          fld("diskSizeGb", "Диск, ГБ", { type: "number", value: "20" }),
          fld("publicIp", "Публичный адрес", { type: "check", value: true }),
          fld("sshPublicKey", "Публичный ключ SSH", { type: "textarea", hint: "Без ключа в машину не войти: пароля у неё нет. Пару ключей можно создать действием «Пара ключей SSH»." }),
        ] },
      { id: "start", ru: "▶ Запустить", op: "start", view: "lines", target: target("Машина (имя или id)") },
      { id: "stop", ru: "■ Остановить (экономит деньги)", op: "stop", view: "lines", target: target("Машина (имя или id)") },
      { id: "restart", ru: "↻ Перезагрузить", op: "restart", view: "lines", target: target("Машина (имя или id)") },
      { id: "serial", ru: "Экран машины (serial)", op: "serial", view: "lines", target: target("Машина (имя или id)"),
        fields: [fld("lines", "Сколько последних строк", { type: "number", value: "40" })] },
      { id: "metrics", ru: "Нагрузка (метрики)", op: "metrics", view: "lines", target: target("Машина (имя или id)"),
        fields: [fld("minutes", "За сколько минут", { type: "number", value: "60" })] },
      { id: "snapshot", ru: "Снимок диска", op: "snapshot", view: "lines", paid: true, confirmArg: "confirmed",
        fields: [target("Машина (имя или id)"), fld("snapshotName", "Имя снимка", { placeholder: "web-1-before-update" })] },
      { id: "cleansnapshots", ru: "Чистка снимков", op: "cleansnapshots", view: "lines",
        fields: [
          fld("disk", "Диск (имя или id)"),
          fld("olderThanDays", "Старее, дней", { type: "number", value: "30" }),
          fld("keep", "Сколько свежих оставить", { type: "number", value: "3" }),
          fld("dryRun", "Только показать, что удалится", { type: "check", value: true }),
        ] },
      { id: "delsnapshot", ru: "Удалить снимок", op: "delsnapshot", view: "lines", danger: true, confirmArg: "confirmed",
        target: target("Снимок (имя или id)") },
      { id: "restoredisk", ru: "Восстановить диск из снимка", op: "restoredisk", view: "lines", paid: true, confirmArg: "confirmed",
        fields: [
          target("Снимок (имя или id)"),
          fld("diskName", "Имя нового диска", { required: true, placeholder: "restored-1" }),
          fld("zone", "Зона", { options: from("compute", "list", (r) => r.zones) }),
        ] },
      { id: "sshkey", ru: "Пара ключей SSH", op: "sshkey", view: "secret", secretLabel: "Личный ключ SSH",
        fields: [fld("name", "Подпись ключа", { placeholder: "web-1" })] },
      { id: "delete", ru: "🗑 Удалить машину", op: "delete", view: "lines", danger: true, confirmArg: "confirmed",
        target: target("Машина (имя или id)"),
        fields: [fld("deleteDisks", "Удалить и её диски", { type: "check", value: true }), fld("releaseAddress", "Освободить статический адрес", { type: "check" })] },
    ],

    // ── Сеть ──
    vpc: [
      { id: "list", ru: "Сети, подсети, адреса", op: "list", view: "vpcList" },
      { id: "subnets", ru: "Только подсети", op: "subnets", view: "objectList", of: (r) => r.subnets, cols: ["name", "zoneId", "v4CidrBlocks", "status"] },
      { id: "groups", ru: "Группы безопасности", op: "groups", view: "objectList", of: (r) => r.securityGroups, cols: ["name", "id", "description"] },
      { id: "addresses", ru: "Статические адреса", op: "addresses", view: "objectList", of: (r) => r.addresses, cols: ["address", "name", "used", "zoneId"] },
      { id: "addsubnet", ru: "＋ Создать подсеть", op: "addsubnet", view: "lines",
        fields: [
          fld("name", "Имя подсети", { required: true, placeholder: "app-subnet" }),
          fld("zone", "Зона", { required: true, options: from("vpc", "list", () => ["ru-central1-a", "ru-central1-b", "ru-central1-d"]) }),
          fld("cidr", "Диапазон", { required: true, hint: "Свободный диапазон рядом с занятыми облако подсказывает в списке сети.", options: from("vpc", "list", (r) => (r.suggestedCidr ? [r.suggestedCidr] : [])) }),
          fld("network", "Сеть", { options: from("vpc", "list", (r) => (r.networks || []).map((n) => n.name)) }),
        ] },
      { id: "delsubnet", ru: "Удалить подсеть", op: "delsubnet", view: "lines", danger: true, target: target("Подсеть (имя или id)") },
      { id: "addgroup", ru: "＋ Создать группу безопасности", op: "addgroup", view: "lines",
        fields: [
          fld("name", "Имя группы", { required: true, placeholder: "web-sg" }),
          fld("network", "Сеть", { options: from("vpc", "list", (r) => (r.networks || []).map((n) => n.name)) }),
          fld("description", "Описание"),
        ] },
      { id: "delgroup", ru: "Удалить группу безопасности", op: "delgroup", view: "lines", danger: true, target: target("Группа (имя или id)") },
      { id: "addrule", ru: "＋ Правило в группу", op: "addrule", view: "lines",
        fields: [
          fld("group", "Группа", { required: true, options: from("vpc", "list", (r) => (r.securityGroups || []).map((g) => g.name)) }),
          fld("direction", "Направление", { type: "select", options: ["ingress", "egress"], value: "ingress" }),
          fld("protocol", "Протокол", { type: "select", options: ["tcp", "udp", "any"], value: "tcp" }),
          fld("port", "Порт", { placeholder: "22" }),
          fld("cidr", "Источник (CIDR)", { hint: "Для SSH бери /32 со своим адресом, а не 0.0.0.0/0." }),
          fld("sourceGroup", "Или группа-источник"),
          fld("description", "Описание"),
        ] },
      { id: "delrule", ru: "Удалить правило", op: "delrule", view: "lines", danger: true,
        fields: [
          fld("group", "Группа", { required: true, options: from("vpc", "list", (r) => (r.securityGroups || []).map((g) => g.name)) }),
          fld("direction", "Направление", { type: "select", options: ["ingress", "egress"], value: "ingress" }),
          fld("protocol", "Протокол", { type: "select", options: ["tcp", "udp", "any"], value: "tcp" }),
          fld("port", "Порт", { placeholder: "22" }),
          fld("cidr", "Источник (CIDR)"),
        ] },
      { id: "reserve", ru: "Закрепить статический адрес", op: "reserve", view: "lines", paid: true,
        fields: [
          fld("name", "Имя адреса", { required: true, placeholder: "web-1-ip" }),
          fld("zone", "Зона", { options: from("vpc", "list", () => ["ru-central1-a", "ru-central1-b", "ru-central1-d"]) }),
          fld("protection", "Защита от удаления", { type: "check" }),
        ] },
      { id: "release", ru: "🗑 Освободить адрес", op: "release", view: "lines", danger: true, target: target("Адрес (IP, имя или id)") },
    ],

    // ── IAM ──
    iam: [
      { id: "list", ru: "Аккаунты, роли и ключи", op: "list", view: "lines" },
      { id: "card", ru: "Карточка аккаунта", op: "card", view: "lines", target: target("Сервисный аккаунт", "account") },
      { id: "keys", ru: "Ключи аккаунта", op: "keys", view: "iamKeys", target: target("Сервисный аккаунт", "account") },
      { id: "roles", ru: "Справочник ролей", op: "roles", view: "objectList", of: (r) => r.roles, cols: ["id", "name"], fields: [fld("filter", "Что искать (например serverless)")] },
      { id: "create", ru: "＋ Создать аккаунт", op: "create", view: "lines",
        fields: [fld("account", "Имя аккаунта", { required: true, placeholder: "site-robot" }), fld("description", "Описание")] },
      { id: "update", ru: "Переименовать / описание", op: "update", view: "lines", target: target("Сервисный аккаунт", "account"),
        fields: [fld("newName", "Новое имя"), fld("description", "Описание")] },
      { id: "grant", ru: "Выдать роль", op: "grant", view: "lines", target: target("Сервисный аккаунт", "account"),
        fields: [fld("role", "Роль (id)", { required: true, placeholder: "storage.viewer" })] },
      { id: "revoke", ru: "Снять роль", op: "revoke", view: "lines", danger: true, target: target("Сервисный аккаунт", "account"),
        fields: [fld("role", "Роль (id)", { required: true, placeholder: "storage.viewer" })] },
      { id: "newkey", ru: "🔑 Создать ключ", op: "newkey", view: "secret", secretLabel: "Секрет ключа",
        target: target("Сервисный аккаунт", "account"),
        fields: [fld("kind", "Вид ключа", { type: "select", options: ["access", "api", "authorized"], value: "access", hint: "access — для S3 и API, api — для сервисов по API-ключу, authorized — ключ самого аккаунта." }), fld("description", "Описание")] },
      { id: "delkey", ru: "🗑 Удалить ключ", op: "delkey", view: "lines", danger: true,
        target: target("Сервисный аккаунт", "account"),
        fields: [fld("keyId", "Id ключа", { required: true }), fld("kind", "Вид ключа", { type: "select", options: ["access", "api", "authorized"], value: "access" })] },
      { id: "delete", ru: "🗑 Удалить аккаунт", op: "delete", view: "lines", danger: true, target: target("Сервисный аккаунт", "account") },
    ],

    // ── Функции ──
    cloudFunctions: [
      { id: "list", ru: "Функции и их состояние", op: "list", view: "lines" },
      { id: "card", ru: "Карточка функции", op: "card", view: "lines", target: target("Функция (имя или id)", "name") },
      { id: "versions", ru: "Версии функции", op: "versions", view: "objectList", of: (r) => r.versions, cols: ["id", "runtime", "status", "createdAt"], target: target("Функция (имя или id)", "name") },
      { id: "runtimes", ru: "Языки и их версии", op: "runtimes", view: "objectList", of: (r) => r.runtimes, cols: ["id", "name"], empty: "Облако не отдало список языков — укажи язык строкой (например python312)." },
      { id: "create", ru: "＋ Создать функцию", op: "create", view: "lines",
        fields: [fld("name", "Имя функции", { required: true, placeholder: "hello" }), fld("description", "Описание")] },
      { id: "update", ru: "Переименовать / описание", op: "update", view: "lines", target: target("Функция (имя или id)", "name"),
        fields: [fld("newName", "Новое имя"), fld("description", "Описание")] },
      { id: "deploy", ru: "↑ Выкатить версию из архива", op: "deploy", view: "lines", target: target("Функция (имя или id)", "name"),
        fields: [
          fld("runtime", "Язык", { required: true, placeholder: "python312", options: from("cloudFunctions", "runtimes", (r) => (r.runtimes || []).map((x) => x.id)) }),
          fld("entrypoint", "Точка входа", { required: true, placeholder: "index.handler" }),
          fld("zipFile", "Архив на ПК (путь к zip)", { required: true }),
          fld("memoryMb", "Память, МБ", { type: "number", value: "128" }),
          fld("timeoutSec", "Таймаут, с", { type: "number", value: "5" }),
          fld("tag", "Тег версии", { hint: "Тег — это постоянный адрес. Без тега зовётся самая новая версия, и следующая выкатка меняет то, что отвечает." }),
        ] },
      { id: "invoke", ru: "▶ Позвать функцию", op: "invoke", view: "invoke", target: target("Функция (имя или id)", "name"),
        fields: [fld("tag", "Тег (необязательно)"), fld("payload", "Что передать (JSON)", { type: "textarea" })] },
      { id: "tag", ru: "Поставить постоянный тег", op: "tag", view: "lines", target: target("Функция (имя или id)", "name"),
        fields: [fld("version", "Версия (id)", { required: true }), fld("tag", "Тег", { required: true, placeholder: "prod" })] },
      { id: "access", ru: "Кто может звать (привязки)", op: "access", view: "lines", target: target("Функция (имя или id)", "name") },
      { id: "untag", ru: "Снять постоянный тег", op: "untag", view: "lines", target: target("Функция (имя или id)", "name"),
        fields: [fld("tag", "Тег", { required: true, placeholder: "prod", hint: "После снятия адрес без тега будет вести на самую новую версию —то есть начнёт меняться от каждой выкатки." })] },
      { id: "public", ru: "⚠ Открыть всему интернету", op: "public", view: "lines", danger: true, target: target("Функция (имя или id)", "name"),
        fields: [fld("tag", "Тег")] },
      { id: "private", ru: "Закрыть от интернета", op: "private", view: "lines", target: target("Функция (имя или id)", "name"),
        fields: [fld("tag", "Тег")] },
      { id: "delversion", ru: "🗑 Удалить версию", op: "delversion", view: "lines", danger: true, target: target("Функция (имя или id)", "name"),
        fields: [fld("version", "Версия (id)", { required: true })] },
      { id: "delete", ru: "🗑 Удалить функцию", op: "delete", view: "lines", danger: true, confirmArg: "confirmed", target: target("Функция (имя или id)", "name") },
    ],

    // ── Сертификаты и CDN ──
    cdn: [
      { id: "overview", ru: "Сертификаты и ресурсы", op: "overview", view: "lines" },
      { id: "certs", ru: "Только сертификаты", op: "certs", view: "objectList", of: (r) => r.certificates, cols: ["name", "domains", "status", "challengeType"] },
      { id: "cert", ru: "Карточка сертификата и запись для DNS", op: "cert", view: "lines", target: target("Сертификат (имя или id)", "certificate") },
      { id: "certnew", ru: "＋ Бесплатный сертификат Let's Encrypt", op: "certnew", view: "lines",
        fields: [
          fld("name", "Имя сертификата", { required: true, placeholder: "site-cert" }),
          fld("domains", "Домены (через запятую)", { required: true, placeholder: "example.com, www.example.com" }),
          fld("challengeType", "Как подтвердить", { type: "select", options: ["DNS", "HTTP"], value: "DNS", hint: "DNS годится и для маски *.домен, HTTP — только для обычных имён и требует файл на сайте." }),
        ] },
      { id: "cdn", ru: "CDN-ресурсы", op: "cdn", view: "objectList", of: (r) => r.resources, cols: ["cname", "status", "sslCertificateId", "active"] },
      { id: "cdninfo", ru: "Карточка CDN-ресурса", op: "cdninfo", view: "lines", target: target("Ресурс (домен или id)", "resource") },
      { id: "cdncreate", ru: "＋ Создать CDN-ресурс (платно)", op: "cdncreate", view: "lines", paid: true, confirmArg: "confirm",
        fields: [
          fld("cname", "Основной домен", { required: true, placeholder: "example.com" }),
          fld("bucket", "Бакет с сайтом", { required: true, placeholder: "my-site" }),
          fld("certificate", "Сертификат (имя или id)", { hint: "Сертификат должен быть Issued и лежать в том же каталоге." }),
        ] },
      { id: "origins", ru: "Группы источников", op: "origins", view: "lines" },
      { id: "origincreate", ru: "＋ Группа источников из бакета", op: "origincreate", view: "lines",
        fields: [fld("name", "Имя группы", { required: true, placeholder: "site-origins" }), fld("bucket", "Бакет", { required: true }), fld("useNext", "Брать следующий источник при отказе", { type: "check", value: true })] },
      { id: "originupdate", ru: "Переименовать группу источников", op: "originupdate", view: "lines",
        fields: [target("Группа (имя или id)", "group"), fld("newName", "Новое имя"), fld("origins", "Источники (через запятую)", { hint: "Список заменяется ЦЕЛИКОМ — перечисли все источники, которые должны остаться." })] },
      { id: "origindel", ru: "🗑 Удалить группу источников", op: "origindel", view: "lines", danger: true, confirmArg: "confirm",
        fields: [target("Группа (имя или id)", "group"), fld("force", "Удалить даже используемую ресурсом", { type: "check" })] },
      { id: "cdnupdate", ru: "Сменить сертификат ресурса", op: "cdnupdate", view: "lines", target: target("Ресурс (домен или id)", "resource"),
        fields: [fld("certificate", "Сертификат (имя или id)", { required: true })] },
      { id: "cdnpurge", ru: "Очистить кэш", op: "cdnpurge", view: "lines", target: target("Ресурс (домен или id)", "resource"),
        fields: [fld("paths", "Пути через запятую", { placeholder: "/index.html, /style.css" }), fld("all", "Очистить всё", { type: "check" })] },
      { id: "cdndel", ru: "🗑 Удалить CDN-ресурс", op: "cdndel", view: "lines", danger: true, confirmArg: "confirm", target: target("Ресурс (домен или id)", "resource") },
    ],

    // ── Сертификаты (своя плитка в полке) ──
    certificateManager: [
      { id: "certs", ru: "Сертификаты и их состояние", op: "certs", view: "lines" },
      { id: "cert", ru: "Карточка и запись для DNS", op: "cert", view: "lines", target: target("Сертификат (имя или id)", "certificate") },
      { id: "certimport", ru: "Загрузить свой сертификат (PEM)", op: "certimport", view: "lines",
        fields: [
          fld("name", "Имя сертификата", { required: true, placeholder: "site-cert" }),
          fld("pem", "Сертификат (PEM)", { type: "textarea", required: true }),
          fld("chain", "Цепочка промежуточных (PEM)", { type: "textarea", hint: "Без полной цепочки часть браузеров не примет сертификат." }),
          fld("key", "Закрытый ключ (PEM)", { type: "textarea", required: true, hint: "Ключ уедет в облако один раз, обратно его не отдают — сохрани свою копию." }),
        ] },
      { id: "certupdate", ru: "Переименовать / описание", op: "certupdate", view: "lines", target: target("Сертификат (имя или id)", "certificate"),
        fields: [fld("newName", "Новое имя"), fld("description", "Описание")] },
      { id: "certnew", ru: "＋ Бесплатный сертификат Let's Encrypt", op: "certnew", view: "lines",
        fields: [
          fld("name", "Имя сертификата", { required: true, placeholder: "site-cert" }),
          fld("domains", "Домены (через запятую)", { required: true, placeholder: "example.com, www.example.com" }),
          fld("challengeType", "Как подтвердить", { type: "select", options: ["DNS", "HTTP"], value: "DNS" }),
        ] },
      { id: "cdncreate", ru: "＋ CDN-ресурс на бакет (платно)", op: "cdncreate", view: "lines", paid: true, confirmArg: "confirm",
        fields: [
          fld("cname", "Основной домен", { required: true, placeholder: "example.com" }),
          fld("bucket", "Бакет с сайтом", { required: true, placeholder: "my-site" }),
          fld("certificate", "Сертификат (имя или id)", { required: true }),
        ] },
      { id: "certdel", ru: "🗑 Удалить сертификат", op: "certdel", view: "lines", danger: true, confirmArg: "confirm", target: target("Сертификат (имя или id)", "certificate") },
    ],

    // ── Деньги ──
    billing: [
      { id: "overview", ru: "Счёт, баланс и хвосты", op: "overview", view: "lines" },
      { id: "accounts", ru: "Платёжные аккаунты", op: "accounts", view: "lines" },
      { id: "account", ru: "Один платёжный аккаунт", op: "account", view: "objectList", of: (r) => (r.account ? [r.account] : []), cols: ["name", "id", "currency", "active", "balance"], target: target("Аккаунт (id или имя)", "account") },
      { id: "budgets", ru: "Пороги-бюджеты", op: "budgets", view: "lines" },
      { id: "leaks", ru: "Платные хвосты", op: "leaks", view: "lines" },
      { id: "price", ru: "Цена по слову", op: "price", view: "lines", fields: [fld("query", "Что искать", { required: true, placeholder: "быстрый диск" })] },
      { id: "services", ru: "Услуги в каталоге цен", op: "services", view: "objectList", of: (r) => r.services, cols: ["id", "name"] },
    ],

    // ── Monitoring: метрики ──
    // Показываем то, что облако измеряет само. Кнопки «создать алерт» здесь НЕТ
    // намеренно: публичный справочник API у Monitoring знает только данные метрик
    // и их метаданные, отдельного REST для алертов у облака нет — а кнопка, за
    // которой ничего нет, хуже её отсутствия.
    monitoring: [
      { id: "overview", ru: "Что вообще измеряется", op: "overview", view: "lines" },
      { id: "names", ru: "Метрики ресурса (селектор)", op: "names", view: "lines",
        fields: [
          fld("service", "Сервис (метка service)", { placeholder: "compute" }),
          fld("resource", "Ресурс (метка resource_id)", { placeholder: "идентификатор ресурса" }),
        ] },
      { id: "metrics", ru: "Данные метрики за период", op: "metrics", view: "lines",
        fields: [
          fld("metric", "Имя метрики (латиницей)", { required: true, placeholder: "cpu_usage" }),
          fld("service", "Сервис (метка service)", { placeholder: "compute" }),
          fld("resource", "Ресурс (метка resource_id)", { placeholder: "идентификатор ресурса" }),
          fld("minutes", "За сколько минут", { type: "number", placeholder: "60" }),
          fld("aggregation", "Прореживание: AVG / MAX / MIN / SUM / LAST / COUNT", { placeholder: "AVG" }),
          fld("maxPoints", "Сколько точек оставить", { type: "number", placeholder: "30" }),
        ] },
    ],

    // ── Яндекс AI: перевод, снимок и речь ──
    // Четыре сервиса в одном семействе, потому что задача у них одна: превратить
    // одно в другое. Платит каждый ЗАПРОС, а не ресурс, поэтому действия не
    // просят согласия (`confirm`) — но четыре из них помечены платными, и ответ
    // честно называет тариф.
    // «Несколько сразу» — суть этих сервисов и потому встроено в формы: targets
    // (языки), files (снимки), voices (голоса) принимают списки через запятую или
    // по одному значению в строке.
    ai: [
      { id: "languages", ru: "Языки перевода", op: "languages", view: "lines" },
      { id: "voices", ru: "Голоса SpeechKit", op: "voices", view: "lines" },
      { id: "detect", ru: "Язык текста", op: "detect", view: "lines",
        fields: [fld("text", "Текст", { type: "textarea", required: true, placeholder: "Вставь отрывок на неизвестном языке" })] },
      { id: "translate", ru: "Перевести (можно на несколько языков сразу)", op: "translate", view: "lines", paid: true,
        fields: [
          fld("text", "Текст", { type: "textarea", required: true, placeholder: "Что перевести" }),
          fld("targets", "Языки перевода (через запятую)", { required: true, placeholder: "en, de, zh" }),
          fld("source", "Язык исходного текста (если знаешь)", { placeholder: "ru" }),
        ] },
      { id: "ocr", ru: "Снимок или PDF → текст (распознать)", op: "ocr", view: "lines", paid: true,
        fields: [
          fld("files", "Пути к файлам (по одному в строке)", { type: "textarea", required: true, placeholder: "C:\\снимки\\договор.png" }),
          fld("langs", "Языки на снимке (через запятую)", { placeholder: "ru, en" }),
          fld("model", "Модель распознавания", { type: "select", options: ["page", "page-column-sort", "handwritten", "table", "markdown", "mathmarkdown"], value: "page" }),
        ] },
      { id: "speak", ru: "Озвучить текст (можно несколькими голосами)", op: "speak", view: "lines", paid: true,
        fields: [
          fld("text", "Текст", { type: "textarea", required: true, placeholder: "Что сказать" }),
          fld("voices", "Голоса (через запятую)", { placeholder: "alena, filipp — пусто = alena" }),
          fld("format", "Формат звука", { type: "select", options: ["mp3", "oggopus", "wav", "lpcm"], value: "mp3" }),
          fld("lang", "Язык голоса", { value: "ru-RU" }),
          fld("speed", "Скорость (0.1–3.0)", { placeholder: "1.0" }),
          fld("emotion", "Эмоция (только для русских голосов)", { placeholder: "neutral / good / evil" }),
        ] },
      { id: "listen", ru: "Запись → текст (расшифровать)", op: "listen", view: "lines", paid: true,
        fields: [
          fld("file", "Путь к записи", { required: true, placeholder: "C:\\записи\\голос.ogg" }),
          fld("lang", "Язык записи", { value: "ru-RU" }),
          fld("format", "Формат звука", { type: "select", options: ["oggopus", "mp3", "lpcm"], value: "oggopus" }),
          fld("topic", "Тема (general — короткая команда, deferred — длинная речь)", { placeholder: "general" }),
        ] },
      // ── AI Studio: модели каталога, ответ, токены и векторы ──
      // Список моделей и токенизация бесплатны; ответ модели и вектор платные,
      // поэтому у них стоит пометка paid, а тариф называет ответ канала.
      { id: "models", ru: "Модели AI Studio (список каталога)", op: "models", view: "lines" },
      { id: "tokens", ru: "Токены текста (бесплатно)", op: "tokens", view: "lines",
        fields: [
          fld("text", "Текст или запрос", { type: "textarea", required: true, placeholder: "Сколько токенов в этом тексте?" }),
          fld("model", "Модель", { value: "yandexgpt-5-lite", hint: "Имя из списка моделей; у каждой модели свой токенизатор." }),
        ] },
      { id: "complete", ru: "＋ Спросить модель (платно)", op: "complete", view: "lines", paid: true,
        fields: [
          fld("model", "Модель", { value: "yandexgpt-5-lite", hint: "yandexgpt-5-lite / yandexgpt-5.1 / yandexgpt-5-pro / aliceai-llm — или адрес gpt://<каталог>/<модель>." }),
          fld("system", "Роль (system)", { type: "textarea", placeholder: "Ты — помощник, отвечай коротко и по делу." }),
          fld("prompt", "Запрос", { type: "textarea", required: true, placeholder: "Что спросить у модели" }),
          fld("temperature", "Температура 0…1", { type: "number", value: "0.3", hint: "0.3 — спокойно и предсказуемо, 1 — разгульно." }),
          fld("maxTokens", "Длина ответа, токенов", { type: "number", value: "2000", hint: "Это длина ОТВЕТА; вход считается отдельно — посчитай его действием «Токены текста»." }),
        ] },
      { id: "embed", ru: "＋ Вектор текста (платно)", op: "embed", view: "lines", paid: true,
        fields: [
          fld("text", "Текст", { type: "textarea", required: true, placeholder: "Текст, который превратить в вектор" }),
          fld("model", "Модель", { type: "select", options: ["text-search-doc", "text-search-query"], value: "text-search-doc", hint: "doc — для документов, query — для поисковых запросов; пространства разные." }),
        ] },
    ],

    // ── Группы машин (Instance Groups) ──
    // Группа — не «несколько машин»: она сама создаёт машины по шаблону, держит
    // их число и пересоздаёт удалённые. Платят МАШИНЫ группы — за час работы,
    // как обычные, поэтому создание помечено paid и спрашивает согласие, а
    // удаление забирает машины вместе с дисками (danger).
    instanceGroups: [
      { id: "list", ru: "Группы машин", op: "list", view: "lines" },
      { id: "card", ru: "Карточка: шаблон, машины, операции", op: "card", view: "lines", target: target("Группа (имя или id)", "group") },
      { id: "instances", ru: "Машины группы", op: "instances", view: "lines", target: target("Группа (имя или id)", "group") },
      { id: "operations", ru: "История операций", op: "operations", view: "lines", target: target("Группа (имя или id)", "group") },
      { id: "create", ru: "＋ Создать группу (платно)", op: "create", view: "lines", paid: true, confirmArg: "confirm",
        fields: [
          fld("name", "Имя группы", { required: true, placeholder: "web" }),
          fld("subnet", "Подсеть", { required: true, hint: "Группа встанет в зоне подсети", options: from("vpc", "subnets", (r) => (r.subnets || []).map((s) => s.name)) }),
          fld("size", "Машин в группе", { type: "number", value: "2", hint: "Каждая машина платит за час работы" }),
          fld("cores", "Ядер на машину", { type: "number", value: "2" }),
          fld("memoryGb", "Памяти на машину, ГБ", { type: "number", value: "2" }),
          fld("coreFraction", "Гарантированная доля vCPU, %", { type: "number", value: "100" }),
          fld("diskSizeGb", "Диск на машину, ГБ", { type: "number", value: "20" }),
          fld("diskType", "Тип диска", { type: "select", options: ["network-ssd", "network-hdd"], value: "network-ssd" }),
          fld("imageFamily", "Образ (семейство)", { value: "ubuntu-2204-lts" }),
          fld("publicIp", "Публичный адрес машинам", { type: "check" }),
          fld("preemptible", "Прерываемые машины (дешевле)", { type: "check" }),
          fld("securityGroups", "Группы безопасности (через запятую)", { placeholder: "без них SSH снаружи закрыт" }),
          fld("sshPublicKey", "Публичный SSH-ключ", { type: "textarea", placeholder: "ssh-ed25519 AAAA… user@pc" }),
          fld("serviceAccountId", "Сервисный аккаунт", { placeholder: "id или имя — необязательно" }),
        ] },
      { id: "start", ru: "▶ Запустить", op: "start", view: "lines", target: target("Группа (имя или id)", "group") },
      { id: "stop", ru: "■ Остановить (машины перестают платить)", op: "stop", view: "lines", target: target("Группа (имя или id)", "group") },
      { id: "delete", ru: "🗑 Удалить группу (вместе с машинами)", op: "delete", view: "lines", danger: true, confirmArg: "confirm", target: target("Группа (имя или id)", "group") },
    ],

    // ── Application Load Balancer ──
    // Четыре ресурса одной семьи — один канал. Порядок работы такой: группа
    // целей (адреса машин) → группа бэкендов (порт целей и проверки здоровья) →
    // HTTP-роутер (правила домена и пути) → балансировщик со слушателем (адрес,
    // порт, сертификат). Здоровье целей спрашивают отдельным действием: оно
    // живёт у пары «группа бэкендов + группа целей».
    alb: [
      { id: "list", ru: "Балансировщики", op: "list", view: "lines" },
      { id: "card", ru: "Карточка: слушатели, роутеры, цели", op: "card", view: "lines", target: target("Балансировщик (имя или id)", "lb") },
      { id: "targets", ru: "Группы целей", op: "targets", view: "lines" },
      { id: "routers", ru: "HTTP-роутеры", op: "routers", view: "lines" },
      { id: "backends", ru: "Группы бэкендов", op: "backends", view: "lines" },
      { id: "health", ru: "Здоровье целей: спросить у облака", op: "health", view: "lines", target: target("Балансировщик (имя или id)", "lb"),
        fields: [
          fld("backendGroup", "Группа бэкендов (имя или id)", { placeholder: "если она у балансировщика одна — можно не указывать", options: from("alb", "backends", (r) => (r.backendGroups || []).map((b) => b.name)) }),
          fld("targetGroup", "Группа целей (имя или id)", { required: true, placeholder: "web-targets", options: from("alb", "targets", (r) => (r.targetGroups || []).map((g) => g.name)) }),
        ] },
      { id: "backnew", ru: "＋ Создать группу бэкендов", op: "backnew", view: "lines",
        fields: [
          fld("name", "Имя группы бэкендов", { required: true, placeholder: "web-backends" }),
          fld("kind", "Вид группы", { type: "select", options: ["http", "grpc", "stream"], value: "http", hint: "http — сайт и API, grpc — сервисы, stream — базы и брокеры (поток TCP)." }),
          fld("targetGroup", "Группа целей (имя или id)", { required: true, placeholder: "web-targets", hint: "Группа бэкендов без группы целей никуда не ведёт." }),
          fld("port", "Порт целей", { type: "number", value: "80", hint: "Порт, который слушают МАШИНЫ (у базы он свой: у PostgreSQL 6432); у потока его назвать обязательно." }),
          fld("healthPath", "Путь проверки здоровья (http)", { placeholder: "/health", hint: "Без проверок облако считает цель здоровой всегда — упавшая машина останется в ротации." }),
        ] },
      { id: "backdel", ru: "🗑 Удалить группу бэкендов", op: "backdel", view: "lines", danger: true, confirmArg: "confirm", target: target("Группа бэкендов (имя или id)", "group") },
      // Слушателей правят ТОЧЕЧНЫМИ действиями: создание балансировщика задаёт
      // одного слушателя, а PATCH с listenerSpecs[] стёр бы всех, кого нет в
      // списке, — поэтому добавление и удаление идут по одному.
      { id: "listeneradd", ru: "＋ Добавить слушателя", op: "listeneradd", view: "lines", target: target("Балансировщик (имя или id)", "lb"),
        fields: [
          fld("listenerName", "Имя слушателя", { required: true, placeholder: "web", hint: "Имя уникально ВНУТРИ балансировщика: строчные латинские буквы, цифры и дефис." }),
          fld("listener", "Вид слушателя", { type: "select", options: ["http", "https", "stream"], value: "http", hint: "http и https — через роутер; stream — поток TCP на группу бэкендов вида stream." }),
          fld("port", "Порт", { type: "number", value: "80" }),
          fld("router", "HTTP-роутер (имя или id)", { placeholder: "нужен для http и https" }),
          fld("certificate", "Сертификат (имя или id)", { placeholder: "нужен для https; сертификат обязан быть выпущен" }),
          fld("backendGroup", "Группа бэкендов (для stream)", { placeholder: "нужна группа вида stream" }),
          fld("address", "Статический адрес", { placeholder: "пусто — облако выдаст само" }),
          fld("sni", "Доп. домены (SNI), по строке", { type: "textarea", placeholder: "shop.example.com=shop-cert\nwww.example.com,example.com=main-cert", hint: "Одна строка — один домен (или несколько через запятую) и его сертификат через «=». Каждый домен отвечает СВОИМ сертификатом, а остальным достаётся основной." }),
        ] },
      { id: "listenerupd", ru: "✎ Править слушателя: порт, сертификат, домены", op: "listenerupd", view: "lines", target: target("Балансировщик (имя или id)", "lb"),
        fields: [
          fld("listenerName", "Какой слушатель правим", { required: true, hint: "Переименовать слушателя нельзя: это тот же слушатель с новыми настройками. Имена слушателей — в карточке." }),
          fld("listener", "Вид (пусто — оставить прежний)", { type: "select", options: ["http", "https", "stream"], hint: "Смена вида заменяет обработчик целиком: HTTP → HTTPS — обычный шаг, когда сертификат уже выпущен." }),
          fld("port", "Порт (пусто — прежний)", { type: "number" }),
          fld("router", "HTTP-роутер (имя или id)", { placeholder: "пусто — прежний" }),
          fld("certificate", "Сертификат (имя или id)", { placeholder: "пусто — прежний; так продлевают HTTPS" }),
          fld("backendGroup", "Группа бэкендов (для потока)", { placeholder: "пусто — прежняя" }),
          fld("address", "Адрес", { placeholder: "пусто — прежний (его и надо оставлять)", hint: "Домены смотрят на АДРЕС слушателя: новый адрес придётся переводить в DNS заново." }),
          fld("sni", "Домены SNI (пусто — прежние, «нет» — убрать)", { type: "textarea", placeholder: "shop.example.com=shop-cert", hint: "Одна строка — один домен (или несколько через запятую) и его сертификат через «=». Список ЗАМЕНЯЕТСЯ целиком: домены, которых нет, убираются вместе со своими сертификатами. Впиши «нет», чтобы убрать все." }),
        ] },
      { id: "listenerdel", ru: "🗑 Убрать слушателя (вход закроется)", op: "listenerdel", view: "lines", danger: true, confirmArg: "confirm", target: target("Балансировщик (имя или id)", "lb"),
        fields: [
          fld("listenerName", "Имя слушателя", { required: true, hint: "Вместе со слушателем закрываются его порт и адрес — состав показывает карточка." }),
        ] },
      { id: "lbupdate", ru: "✎ Правка балансировщика: имя, логи и авто-масштаб", op: "lbupdate", view: "lines", target: target("Балансировщик (имя или id)", "lb"),
        fields: [
          fld("newName", "Новое имя", { placeholder: "пусто — имя не меняется" }),
          fld("description", "Описание", { placeholder: "короткая подпись, что это за вход" }),
          fld("securityGroups", "Группы безопасности (через запятую)", { hint: "Список ЗАМЕНЯЕТСЯ целиком: перечисли ВСЕ нужные группы, иначе вход закроется снаружи." }),
          fld("logGroup", "Группа логов Cloud Logging (доступ-логи)", { placeholder: "имя или id группы; пусто — не менять", hint: "Доступ-логи — единственный журнал, где видно, куда балансировщик отправлял запросы. Включение снимает «выключено»." }),
          fld("noLogs", "Выключить доступ-логи", { type: "check", hint: "Журнал запросов перестанет писаться. Включить обратно — поле группы логов." }),
          fld("minZoneSize", "Авто-масштаб: минимум единиц на зону", { type: "number", placeholder: "по умолчанию 2", hint: "Ресурсные единицы — платные узлы: минимум × число зон оплачивается даже без трафика. Оба числа заменяются вместе." }),
          fld("maxSize", "Авто-масштаб: максимум всего (0 — без предела)", { type: "number", placeholder: "пусто — прежний" }),
          fld("allowZonalShift", "Допуск к сдвигу зоны", { type: "select", options: ["да", "нет"], hint: "«Да» — при отказе или обслуживании зоны облако само погасит в ней трафик, остальные зоны подхватят. По умолчанию запрещено; «не менять» — оставь пустым." }),
        ] },
      { id: "targetnew", ru: "＋ Создать группу целей", op: "targetnew", view: "lines",
        fields: [
          fld("name", "Имя группы целей", { required: true, placeholder: "web-targets" }),
          fld("ips", "Адреса целей (через запятую)", { placeholder: "10.10.0.5, 10.10.0.6", hint: "Цель — это адрес машины; порт задаёт группа бэкендов, а не группа целей." }),
          fld("subnet", "Подсеть адресов", { options: from("vpc", "subnets", (r) => (r.subnets || []).map((s) => s.name)) }),
        ] },
      // Группа целей правится по имени и описанию; состав целей здесь НЕ
      // трогается — его меняют точечно (targetadd/targetremove), а в PATCH
      // список целей заменяется целиком.
      { id: "tgupdate", ru: "✎ Правка группы целей: имя и описание", op: "tgupdate", view: "lines", target: target("Группа целей (имя или id)", "group"),
        fields: [
          fld("newName", "Новое имя группы", { placeholder: "пусто — имя не меняется", hint: "Имя обязано быть уникальным в каталоге: занятое отбивается до запроса. Переименование не рвёт связей — маршруты держат группу по id." }),
          fld("description", "Новое описание", { placeholder: "пусто — не меняется" }),
        ] },
      { id: "targetadd", ru: "＋ Добавить цели", op: "targetadd", view: "lines", target: target("Группа целей (имя или id)", "group"),
        fields: [
          fld("ips", "Адреса (через запятую)", { required: true, placeholder: "10.10.0.7" }),
          fld("subnet", "Подсеть новых целей", { options: from("vpc", "subnets", (r) => (r.subnets || []).map((s) => s.name)) }),
        ] },
      { id: "targetremove", ru: "— Убрать цели", op: "targetremove", view: "lines", target: target("Группа целей (имя или id)", "group"),
        fields: [
          fld("ips", "Адреса (через запятую)", { required: true, placeholder: "10.10.0.7" }),
        ] },
      { id: "targetdel", ru: "🗑 Удалить группу целей", op: "targetdel", view: "lines", danger: true, confirmArg: "confirm", target: target("Группа целей (имя или id)", "group") },
      { id: "routernew", ru: "＋ Создать HTTP-роутер", op: "routernew", view: "lines",
        fields: [
          fld("name", "Имя роутера", { required: true, placeholder: "main-router" }),
          fld("host", "Домен (что пришло в заголовке Host)", { placeholder: "site.example.com", hint: "Без домена роутер отвечает на ЛЮБОЙ домен." }),
          fld("pathPrefix", "Путь (префикс)", { value: "/" }),
          fld("backendGroup", "Группа бэкендов (имя или id)", { required: true, placeholder: "web-backends", hint: "Маршрут обязан вести в существующую группу — список в действии «Группы бэкендов»." }),
        ] },
      // Правка роутера и группы бэкендов идёт заменой ВЛОЖЕННОГО списка (облако
      // не умеет «поменять порт» или «поменять путь»): модуль читает текущий
      // список, меняет в нём одно место и возвращает целиком — поэтому в полях
      // прямо написано, что пустое значит «оставить прежнее».
      { id: "routerupd", ru: "✎ Править роутер: имя, домен, путь, маршрут", op: "routerupd", view: "lines", target: target("Роутер (имя или id)", "router"),
        fields: [
          fld("routeName", "Имя маршрута", { placeholder: "пусто — если в хосте он один", hint: "Имена маршрутов видны в карточке балансировщика и в действии «HTTP-роутеры»." }),
          fld("vhost", "Имя виртуального хоста", { placeholder: "пусто — если хост один", hint: "Новый маршрут здесь не создаётся: облако принимает список хостов только заменой." }),
          fld("host", "Домен хоста (пусто — не менять, «нет» — убрать)", { placeholder: "site.example.com", hint: "Это заголовок Host: без домена хост отвечает на ЛЮБОЙ. Сертификат задаёт слушатель." }),
          fld("pathPrefix", "Путь (префикс)", { placeholder: "пусто — оставить прежний" }),
          fld("pathExact", "Точный путь", { placeholder: "пусто — оставить префикс" }),
          fld("backendGroup", "Новая группа бэкендов", { placeholder: "пусто — прежняя", hint: "Маршрут ведёт только в группу вида http." }),
          fld("newName", "Новое имя роутера", { placeholder: "пусто — имя не меняется" }),
          fld("description", "Описание", { placeholder: "пусто — не меняется" }),
        ] },
      { id: "routerdel", ru: "🗑 Удалить HTTP-роутер", op: "routerdel", view: "lines", danger: true, confirmArg: "confirm", target: target("Роутер (имя или id)", "router") },
      { id: "backupd", ru: "✎ Правка группы бэкендов: порт целей и проверки", op: "backupd", view: "lines", target: target("Группа бэкендов (имя или id)", "group"),
        fields: [
          fld("port", "Порт целей (пусто — прежний)", { type: "number", hint: "Это порт, который слушают МАШИНЫ, а не балансировщик: если там слушают другой порт, вход начнёт отдавать 502." }),
          fld("healthPath", "Путь проверки здоровья (http)", { placeholder: "пусто — прежняя" }),
          fld("healthService", "Служба проверки (grpc)", { placeholder: "для gRPC-группы" }),
          fld("noHealthCheck", "Убрать проверки здоровья", { type: "check", hint: "Без проверок облако считает цель здоровой ВСЕГДА — упавшая машина останется в ротации." }),
          fld("targetGroup", "Новая группа целей", { placeholder: "пусто — прежняя" }),
          fld("backend", "Какой бэкенд правим", { placeholder: "пусто — все бэкенды группы" }),
          fld("newName", "Новое имя группы", { placeholder: "пусто — имя не меняется" }),
          fld("description", "Описание", { placeholder: "пусто — не меняется" }),
        ] },
      { id: "lbnew", ru: "＋ Создать балансировщик (платно)", op: "lbnew", view: "lines", paid: true, confirmArg: "confirm",
        fields: [
          fld("name", "Имя балансировщика", { required: true, placeholder: "web-lb" }),
          fld("subnet", "Подсеть узла", { required: true, hint: "Балансировщик встанет в зоне подсети", options: from("vpc", "subnets", (r) => (r.subnets || []).map((s) => s.name)) }),
          fld("listener", "Слушатель", { type: "select", options: ["http", "https", "stream"], value: "http", hint: "http и https — через роутер; stream — поток TCP на группу бэкендов." }),
          fld("port", "Порт", { type: "number", value: "80" }),
          fld("router", "HTTP-роутер (имя или id)", { placeholder: "нужен для http и https" }),
          fld("certificate", "Сертификат (имя или id)", { placeholder: "нужен для https; выпустить: ycCdn certnew" }),
          fld("backendGroup", "Группа бэкендов (для stream)", { placeholder: "нужна для потока TCP" }),
          fld("address", "Статический адрес", { placeholder: "пусто — облако выдаст само" }),
          fld("securityGroups", "Группы безопасности (через запятую)", { placeholder: "без них порт закрыт снаружи" }),
          fld("sni", "Доп. домены (SNI), по строке", { type: "textarea", placeholder: "shop.example.com=shop-cert", hint: "Только для HTTPS: один слушатель отвечает на несколько доменов, у каждого — свой сертификат." }),
        ] },
      { id: "lbstart", ru: "▶ Запустить", op: "lbstart", view: "lines", target: target("Балансировщик (имя или id)", "lb") },
      { id: "lbstop", ru: "■ Остановить (платится всё равно)", op: "lbstop", view: "lines", target: target("Балансировщик (имя или id)", "lb") },
      { id: "lbdel", ru: "🗑 Удалить балансировщик", op: "lbdel", view: "lines", danger: true, confirmArg: "confirm", target: target("Балансировщик (имя или id)", "lb") },
    ],

    // ── Serverless-контейнеры ──
    // Контейнер — это образ с настройками, то есть РЕВИЗИЯ. Имя и описание живут
    // на самом контейнере, а образ, переменные окружения и ресурсы — только в
    // ревизии. Поэтому «правка» и «новая ревизия» здесь разные действия, как в
    // консоли облака. Платность честная: сама ревизия бесплатна, платят за
    // вызовы и за ТЁПЛЫЕ экземпляры (minInstances > 0) — о них предупреждает
    // поле и ответ, а не ложная пометка «платно» на всей выкатке.
    serverlessContainers: [
      { id: "list", ru: "Контейнеры и их состояние", op: "list", view: "lines" },
      { id: "card", ru: "Карточка: активная ревизия и настройки", op: "card", view: "lines", target: target("Контейнер (имя или id)", "container") },
      { id: "revisions", ru: "Ревизии (образ и ресурсы)", op: "revisions", view: "lines", target: target("Контейнер (имя или id)", "container") },
      { id: "revision", ru: "Одна ревизия подробно", op: "revision", view: "lines", target: target("Контейнер (имя или id)", "container"),
        fields: [fld("revisionId", "Id ревизии", { required: true })] },
      { id: "newrev", ru: "↑ Новая ревизия (образ, переменные, ресурсы)", op: "newrev", view: "lines", target: target("Контейнер (имя или id)", "container"),
        fields: [
          fld("image", "Образ", { required: true, placeholder: "cr.yandex/<registry-id>/<image>:latest", hint: "Образ лежит в Container Registry (плитка «Реестр образов»)." }),
          fld("env", "Переменные окружения (JSON)", { type: "textarea", placeholder: '{"KEY":"value","PORT":"8080"}', hint: "Добавляются к переменным активной ревизии. Пусто — остаются как были." }),
          fld("memoryMb", "Память, МБ", { type: "number", value: "256" }),
          fld("cores", "Ядра", { type: "number", value: "1" }),
          fld("timeoutSec", "Таймаут, с", { type: "number", value: "30" }),
          fld("minInstances", "Тёплых экземпляров (minInstances)", { type: "number", value: "0", hint: "0 — контейнер запускается только под запрос. Больше нуля — платные экземпляры, которые держат контейнер готовым всегда." }),
          fld("networkId", "Сеть (id сети VPC)", { hint: "Без сети контейнер не видит ни VPC, ни управляемые базы. Пусто — как у активной ревизии." }),
          fld("serviceAccountId", "Сервисный аккаунт (id)", { hint: "Нужен для доступа к секретам Lockbox и облачным сервисам." }),
          fld("runtime", "Режим запуска", { type: "select", options: ["http", "task"], value: "http", hint: "http — внутри контейнера HTTP-сервер; task — процесс запускается на каждый запрос." }),
          fld("logGroupId", "Лог-группа (id)", { hint: "Пусто — логи каталога по умолчанию." }),
          fld("description", "Описание ревизии"),
        ] },
      { id: "rollback", ru: "↩ Сделать ревизию активной (откат)", op: "rollback", view: "lines", target: target("Контейнер (имя или id)", "container"),
        fields: [fld("revisionId", "Id ревизии", { required: true, hint: "Список и id — действием «Ревизии»." })] },
      { id: "update", ru: "Переименовать / описание", op: "update", view: "lines", target: target("Контейнер (имя или id)", "container"),
        fields: [fld("newName", "Новое имя"), fld("description", "Описание")] },
      { id: "public", ru: "⚠ Открыть всему интернету", op: "public", view: "lines", danger: true, target: target("Контейнер (имя или id)", "container") },
      { id: "private", ru: "🔒 Закрыть от интернета", op: "private", view: "lines", target: target("Контейнер (имя или id)", "container") },
    ],

    // ── База YDB: таблицы и записи ──
    // Действия собираются функцией: ключ, запись и ключ поиска повторяются в
    // шести действиях, и одна копия на всех — единственный способ не разойтись.
    ydb: ydbActions(),

    // ── Object Storage: файлы бакета ──
    // Действия собираются функцией: бакет и ключ повторяются почти в каждом —
    // одна копия на всех, чтобы подписи и подсказки не разошлись.
    storage: storageActions(),

    // ── Группы логов Cloud Logging ──
    logging: loggingActions(),

    // ── API-шлюз (API Gateway) ──
    apiGateway: apigwActions(),

    // ── Секреты Lockbox ──
    lockbox: lockboxActions(),

    // ── Реестр образов Container Registry ──
    containerRegistry: registryActions(),

    // ── Managed-базы: PostgreSQL, MySQL и ClickHouse ──
    // Три семейства в трёх плитках, но один канал и одна форма: набор действий
    // у баз одинаков (список, классы, карточка, создание, хосты, базы,
    // пользователи, логи, операции, питание, удаление).
    postgresql: dbActions("postgresql"),
    mysql: dbActions("mysql"),
    clickhouse: dbActions("clickhouse"),

    // ── DNS-зоны и записи ──
    // Записи в Cloud DNS живут парами «имя+тип»: пара — это один НАБОР значений,
    // поэтому кнопка одна, «добавить или заменить»: что именно случилось, скажет
    // ответ. Удаление необратимо для тех, кто на запись смотрит (домен, сайт,
    // почта), поэтому оно опасное и спрашивает дважды — окно и облако.
    dns: [
      { id: "zones", ru: "Зоны и записи", op: "zones", view: "lines" },
      { id: "records", ru: "Записи зоны", op: "records", view: "lines", target: target("Зона (имя или id)", "zone") },
      { id: "card", ru: "Карточка зоны", op: "card", view: "lines", target: target("Зона (имя или id)", "zone") },
      { id: "add", ru: "＋ Добавить или заменить запись", op: "add", view: "lines", target: target("Зона (имя или id)", "zone"),
        fields: [
          fld("name", "Имя записи (FQDN с точкой)", { required: true, placeholder: "www.example.com." }),
          fld("type", "Тип", { type: "select", options: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"], value: "A" }),
          fld("ttl", "TTL, секунд", { type: "number", value: "600" }),
          fld("values", "Значения (через запятую)", { type: "textarea", required: true, placeholder: "203.0.113.10", hint: "У A — адрес, у CNAME — домен с точкой, у MX — «приоритет домен.», у TXT — сам текст." }),
        ] },
      { id: "delete", ru: "🗑 Удалить запись", op: "delete", view: "lines", danger: true, confirmArg: "confirm", target: target("Зона (имя или id)", "zone"),
        fields: [
          fld("name", "Имя записи (FQDN с точкой)", { required: true, placeholder: "www.example.com." }),
          fld("type", "Тип", { type: "select", options: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"], value: "A" }),
        ] },
    ],
  };

  // ── Вид результата ────────────────────────────────────────────────────────
  // Канал отдаёт либо готовые строки (lines) — их и показываем, — либо данные,
  // которые здесь собираются в те же строки. «Пусто» и «ошибка» — тоже строки:
  // человек не должен видеть пустую рамку без объяснения.
  function val(row, key) {
    let v = row;
    for (const part of String(key).split(".")) {
      if (v == null) return "";
      v = v[part];
    }
    if (Array.isArray(v)) return v.length ? v.join(", ") : "";
    if (typeof v === "boolean") return v ? "да" : "нет";
    if (v == null || v === "") return "—";
    return String(v);
  }

  function objectRows(action, result) {
    let rows = [];
    try {
      rows = (action.of ? action.of(result) : []) || [];
    } catch (e) {
      rows = [];
    }
    if (!Array.isArray(rows) || !rows.length) return { lines: [action.empty || "Пусто."] };
    const cols = action.cols || ["name", "id"];
    const lines = rows.slice(0, 60).map((r) => cols.map((c) => val(r, c)).join(" · "));
    if (rows.length > 60) lines.push("… и ещё " + (rows.length - 60));
    return { lines: lines };
  }

  const VIEWS = {
    lines: (a, r) => ({ lines: r.lines && r.lines.length ? r.lines : [r.message || "Готово."] }),
    message: (a, r) => ({ lines: [r.message || "Готово."] }),
    secret: (a, r) => ({ lines: [r.message || "Готово."] }),
    objectList: objectRows,
    invoke: (a, r) => ({
      lines: ["Код ответил: " + (r.status != null ? r.status : "—") + " за " + (r.ms != null ? r.ms : "—") + " мс" + (r.url ? " · " + r.url : ""), String(r.text == null ? "" : r.text).slice(0, 4000) || "(пустой ответ)"],
      warn: r.hint ? [r.hint] : [],
    }),
    computeList: (a, r) => {
      const inst = r.instances || [];
      const lines = [];
      if (!inst.length) lines.push("Машин в каталоге нет — их можно создать кнопкой «＋ Создать машину».");
      for (const i of inst) {
        lines.push(
          (i.running ? "● " : "○ ") + i.name + " — " + (i.statusHuman || i.status || "—") + ", " + (i.zoneId || "—") + ", " +
            i.cores + "×" + i.coreFraction + "%" + (i.guaranteedVcpu ? " (" + i.guaranteedVcpu + " vCPU)" : "") + ", " + (i.memoryHuman || "—") +
            (i.hasExternalIp ? ", " + i.externalIp : ", без внешнего адреса") + (i.uptime ? " · работает " + i.uptime : "")
        );
      }
      if (inst.length) lines.push("Машин: " + inst.length + " · дисков: " + (r.disks || []).length + " · снимков: " + (r.snapshots || []).length);
      const lo = r.leftovers || { total: 0, lines: [] };
      if (lo.total) {
        lines.push("Платные хвосты (" + lo.total + "):");
        for (const l of lo.lines || []) lines.push("  " + l);
      }
      return {
        lines: lines,
        warn: lo.total ? ["За это платят каждый час, хотя пользоваться уже нечем: удали или привяжи."] : [],
      };
    },
    vpcList: (a, r) => {
      const nets = r.networks || [];
      const subs = r.subnets || [];
      const groups = r.securityGroups || [];
      const addrs = r.addresses || [];
      const lines = ["Сетей: " + nets.length + " · подсетей: " + subs.length + " · групп безопасности: " + groups.length + " · статических адресов: " + addrs.length];
      for (const n of nets) lines.push("Сеть " + n.name + " — id " + n.id);
      for (const s of subs) lines.push("  подсеть " + s.name + " — " + (s.zoneId || "—") + ", " + ((s.v4CidrBlocks || []).join(", ") || "—"));
      for (const g of groups) lines.push("  группа " + g.name + " — правил: " + ((g.ingress || 0) + (g.egress || 0)));
      for (const ad of addrs) lines.push("  адрес " + (ad.address || ad.name) + (ad.used ? " — привязан" : " — ПРОСТАИВАЕТ (платный)"));
      if (r.suggestedCidr) lines.push("Свободный диапазон для новой подсети: " + r.suggestedCidr);
      return { lines: lines, warn: (r.idleAddresses || []).length ? ["Простаивающие статические адреса тарифицируются, даже когда ими не пользуются."] : [] };
    },
    iamKeys: (a, r) => {
      const lines = [];
      const push = (title, rows) => {
        for (const k of rows || []) lines.push(title + ": " + (k.description || k.id || "—") + " · id " + (k.id || "—") + (k.keyId ? " · keyId " + k.keyId : "") + (k.createdAt ? " · создан " + k.createdAt : ""));
      };
      push("Статический ключ", r.keys);
      push("API-ключ", r.accessKeys);
      push("Ключ аккаунта", r.apiKeys);
      push("Авторизованный ключ", r.authorizedKeys);
      if (!lines.length) lines.push("Ключей у аккаунта нет: он ничего не сможет подписать.");
      for (const t of r.troubles || []) lines.push("⚠ " + t);
      return { lines: lines };
    },
  };

  // ── Сборка запроса и разбор ответа (чистые функции — их и проверяет набор) ─
  function findAction(service, id) {
    const list = ACTIONS[service] || [];
    return list.find((a) => a.id === id) || null;
  }

  // Поля действия вместе с целью (машиной, аккаунтом, функцией). Цель объявлена
  // отдельно, но в форме и в запросе она обычное поле: одна правда на два места —
  // иначе запрос из карточки потерял бы имя ресурса, а форма показывала бы его
  // дважды.
  function fieldsFor(action) {
    const fields = (action.fields || []).slice();
    if (action.target && !fields.some((f) => f.key === action.target.key)) fields.unshift(action.target);
    return fields;
  }

  function request(service, id, values, confirmed) {
    const action = findAction(service, id);
    if (!action) return null;
    const channel = CHANNELS[service];
    if (!channel) return null;
    const v = values || {};
    // Постоянные аргументы семейства: у Managed-баз это engine (у PostgreSQL,
    // MySQL и ClickHouse один канал, и различает их только он).
    const fam = FAMILIES[service] || {};
    const args = Object.assign({ op: action.op }, fam.fixed || {});
    for (const f of fieldsFor(action)) {
      const raw = v[f.key];
      if (raw === undefined || raw === null || raw === "") continue;
      if (f.type === "check") args[f.key] = raw === true || raw === "true";
      else if (f.type === "number") args[f.key] = Number(raw);
      else args[f.key] = String(raw).trim();
    }
    // Аргумент согласия уходит ТОЛЬКО когда человек действительно подтвердил:
    // канал проверяет `=== true`, а лишний `false` в теле сбивает агентские
    // проверки «платное без согласия».
    if (confirmed && action.confirmArg) args[action.confirmArg] = true;
    return { channel: channel, args: args, action: action };
  }

  function summarize(service, id, result) {
    const action = findAction(service, id);
    const r = result || {};
    if (!action) return { ok: false, lines: ["Неизвестное действие."], warn: [], secret: "", secretLabel: "", audios: [] };
    if (r.ok === false) {
      // Цена и предупреждения — не ошибка, а вопрос: показываем их вместе с
      // подсказкой «нажми ещё раз», иначе платное кажется сломанным.
      const extra = (r.lines || []).slice(0, 8);
      return {
        ok: false,
        needsConfirm: r.needsConfirm === true,
        lines: [r.error || "Облако отказало без объяснения."].concat(extra),
        warn: (r.warnings || []).slice(0, 6),
        secret: "",
        secretLabel: "",
        audios: [],
      };
    }
    const view = VIEWS[action.view] || VIEWS.lines;
    const out = view(action, r) || {};
    const secret = r.secret || r.privateKey || "";
    const secretLabel = action.secretLabel || "Секрет";
    const lines = (out.lines || []).filter((x) => x !== "" && x != null);
    // Предупреждения модулей — отдельным списком: их читают перед «готово».
    const warn = (out.warn || []).concat(r.warnings || []).slice(0, 8);
    // Пара ключей SSH — это ДВА разных значения и оба нужны: публичную строку
    // вставляют в машину, личный ключ сохраняют. Показываем оба: иначе человек
    // унёс бы только секрет и не смог войти.
    if (r.publicKey) lines.unshift("Публичный ключ (вставляй в машину): " + r.publicKey);
    // Синтезированная речь приходит СОДЕРЖИМЫМ (base64): её проигрывает окно,
    // а не внешний плеер — иначе «озвучить» заканчивалось бы поиском файла.
    const audios = (Array.isArray(r.audios) ? r.audios : []).filter((x) => x && x.base64);
    return { ok: true, needsConfirm: false, lines: lines, warn: warn, secret: secret, secretLabel: secretLabel, audios: audios };
  }

  // ── Рисование ─────────────────────────────────────────────────────────────
  const state = {
    open: false,
    service: "",
    target: "",
    targetLabel: "",
    actionId: "",
    values: {},
    log: [],
    onDone: null,
    busy: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function say(msg) {
    const t = window.uiToast;
    if (typeof t === "function") t(msg);
  }

  function askConfirm(title, text, go, danger) {
    if (typeof window.uiConfirm === "function") {
      window.uiConfirm(title, text, go, danger !== false);
      return;
    }
    if (window.confirm ? window.confirm(title + "\n\n" + text) : true) go();
  }

  function callApi(channel, args) {
    const api = window.api;
    if (!api || typeof api[channel] !== "function") {
      return Promise.resolve({ ok: false, error: "Это действие доступно в приложении на ПК (desktop)." });
    }
    return Promise.resolve(api[channel](args)).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
  }

  function ensureBox() {
    const panel = $("sp-cloud");
    if (!panel) return null;
    let box = $("yc-actions");
    if (!box) {
      box = el("div", "yc-act hidden");
      box.id = "yc-actions";
      panel.appendChild(box);
    }
    return box;
  }

  function setVisible(on) {
    const box = ensureBox();
    const dash = $("yc-dash");
    const sum = $("yc-summary");
    if (box) box.classList.toggle("hidden", !on);
    if (dash) dash.classList.toggle("hidden", on);
    if (sum) sum.classList.toggle("hidden", on);
  }

  function isOpen() {
    return state.open;
  }

  function open(opts) {
    const o = opts || {};
    const service = String(o.service || "");
    if (!CHANNELS[service]) return;
    const box = ensureBox();
    if (!box) return;
    state.open = true;
    state.service = service;
    state.target = String(o.target || "");
    state.targetLabel = String(o.targetLabel || "");
    state.actionId = "";
    state.values = {};
    state.log = [];
    state.onDone = typeof o.onDone === "function" ? o.onDone : null;
    state.busy = false;
    setVisible(true);
    render();
  }

  function close() {
    state.open = false;
    setVisible(false);
    const box = $("yc-actions");
    if (box) box.innerHTML = "";
  }

  function render() {
    const box = ensureBox();
    if (!box) return;
    box.innerHTML = "";
    const fam = FAMILIES[state.service] || { title: state.service };

    const head = el("div", "yc-act-head");
    const back = el("button", "yc-act-back", "← К списку");
    back.type = "button";
    back.title = "Вернуться к полке сервисов";
    back.onclick = () => close();
    head.appendChild(back);
    const title = el("div", "yc-act-title");
    title.appendChild(el("b", "", "Действия: " + fam.title));
    if (state.target) title.appendChild(el("span", "yc-act-target", " · " + state.target));
    head.appendChild(title);
    box.appendChild(head);

    const note = el("div", "yc-act-note");
    note.textContent = "Это настоящие действия в твоём облаке — они выполняются сразу и могут стоить денег. Платные и необратимые облако сначала называет ценой и предупреждением.";
    box.appendChild(note);

    const action = state.actionId ? findAction(state.service, state.actionId) : null;
    if (!action) {
      const grid = el("div", "yc-act-grid");
      for (const a of ACTIONS[state.service] || []) {
        const btn = el("button", "yc-act-btn" + (a.danger ? " danger" : a.paid ? " paid" : ""), a.ru);
        btn.type = "button";
        btn.onclick = () => startAction(a.id);
        grid.appendChild(btn);
      }
      box.appendChild(grid);
      box.appendChild(logBox());
      return;
    }

    const form = el("div", "yc-act-form");
    form.appendChild(el("div", "yc-act-form-title", action.ru));
    const fields = fieldsFor(action);
    const inputs = {};
    for (const f of fields) {
      const row = el("label", "yc-act-field");
      const lab = el("span", "yc-act-label", f.label + (f.required ? " *" : ""));
      row.appendChild(lab);
      let input;
      if (f.type === "textarea") {
        input = el("textarea", "yc-act-input");
        input.rows = 4;
      } else if (f.type === "select") {
        input = el("select", "yc-act-input");
        const opts = Array.isArray(f.options) ? f.options : [];
        const empty = el("option", "", "— выбери —");
        empty.value = "";
        input.appendChild(empty);
        for (const o of opts) {
          const op = el("option", "", String(o));
          op.value = String(o);
          input.appendChild(op);
        }
      } else if (f.type === "check") {
        input = el("input", "yc-act-check");
        input.type = "checkbox";
      } else {
        input = el("input", "yc-act-input");
        input.type = f.type === "number" ? "text" : "text";
        // Поле-файл: путь выбирает системное окно, руками его не печатают —
        // иначе опечатка в пути выглядела бы как «файла нет» в облаке.
        if (f.type === "pick") input.readOnly = true;
      }
      if (f.type === "check") {
        input.checked = f.value === true;
        row.classList.add("check");
        row.appendChild(input);
      } else {
        if (f.placeholder) input.placeholder = f.placeholder;
        // Целевой ресурс (машина, аккаунт, функция) уже известен из карточки —
        // подставляем, но оставляем возможность исправить.
        if (action.target && f.key === action.target.key && state.target) input.value = state.target;
        else if (f.value != null) input.value = String(f.value);
        row.appendChild(input);
        if (f.type === "pick") row.appendChild(pickButton(f, inputs, input));
      }
      if (f.hint) row.appendChild(el("span", "yc-act-hint", f.hint));
      form.appendChild(row);
      inputs[f.key] = input;
      // Подсказки-варианты: спрашиваем облако НЕ блокируя форму. Не ответило —
      // поле остаётся обычным текстом и действие всё равно выполнимо.
      if (f.options && typeof f.options === "object" && f.options.pick && f.type !== "select") {
        const listId = "yc-act-dl-" + f.key;
        const dl = document.createElement("datalist");
        dl.id = listId;
        input.setAttribute("list", listId);
        form.appendChild(dl);
        callApi(CHANNELS[f.options.channel] || CHANNELS[state.service], Object.assign({ op: f.options.op }, f.options.args || {})).then((r) => {
          if (!r || r.ok === false) return;
          let opts = [];
          try {
            opts = f.options.pick(r) || [];
          } catch (e) {
            opts = [];
          }
          for (const o of opts.slice(0, 80)) {
            const op = document.createElement("option");
            op.value = String(o);
            dl.appendChild(op);
          }
        });
      }
    }

    const actionsRow = el("div", "yc-act-actionsrow");
    const run = el("button", "btn btn-primary btn-small", action.danger && !action.dangerIf ? "Выполнить (спросит подтверждение)" : "Выполнить");
    run.type = "button";
    run.onclick = () => {
      const values = {};
      for (const key of Object.keys(inputs)) {
        const inp = inputs[key];
        values[key] = inp.type === "checkbox" ? !!inp.checked : inp.value;
      }
      const need = fields.filter((f) => f.required && !String(values[f.key] == null ? "" : values[f.key]).trim());
      if (need.length) {
        say("❌ Заполни: " + need.map((f) => f.label).join(", "));
        return;
      }
      state.values = values;
      // `dangerIf` уточняет пометку по САМОМУ запросу: кнопка одна, а опасность
      // зависит от текста (SELECT — нет, DROP — да). Канал всё равно проверит сам.
      const dangerNow = typeof action.dangerIf === "function" ? !!action.dangerIf(values) : !!action.danger;
      if (dangerNow) {
        askConfirm("Подтверди действие", action.ru + (state.target ? " («" + state.target + "»)" : "") + ": отменить это будет нельзя.", () => runAction(false), true);
      } else {
        runAction(false);
      }
    };
    actionsRow.appendChild(run);
    const cancel = el("button", "btn btn-ghost btn-small", "Отмена");
    cancel.type = "button";
    cancel.onclick = () => {
      state.actionId = "";
      render();
    };
    actionsRow.appendChild(cancel);
    form.appendChild(actionsRow);
    box.appendChild(form);
    box.appendChild(outBox());
    box.appendChild(logBox());

    const first = form.querySelector("input, select, textarea");
    if (first && first.focus) first.focus();
  }

  // Кнопка «Выбрать…» рядом с полем-файлом. Открывает системное окно (его каналы
  // живут в src/cloud-files-ipc.js) и кладёт выбранный путь в поле. Выбранное имя
  // подставляется ещё и в поле, названное `fill` (обычно это ключ бакета):
  // печатать имя файла второй раз незачем. Отмена ничего не меняет.
  function pickButton(f, inputs, input) {
    const btn = el("button", "btn btn-ghost btn-small yc-act-pick", "Выбрать…");
    btn.type = "button";
    btn.onclick = () => {
      const api = window.api;
      const name = String(f.pickApi || "");
      if (!api || typeof api[name] !== "function") {
        say("Выбор файла доступен в приложении на ПК (desktop).");
        return;
      }
      const values = {};
      for (const k of Object.keys(inputs)) {
        const inp = inputs[k];
        values[k] = inp.type === "checkbox" ? !!inp.checked : inp.value;
      }
      const args = typeof f.pickArgs === "function" ? f.pickArgs(values) || {} : f.pickArgs || {};
      btn.disabled = true;
      Promise.resolve(api[name](args))
        .then((r) => {
          btn.disabled = false;
          if (typeof r === "string") {
            say("❌ " + r);
            return;
          }
          if (!r || !r.path) return; // отмена диалога — ничего не меняется
          input.value = r.path;
          if (f.fill && inputs[f.fill]) inputs[f.fill].value = r.name || "";
        })
        .catch(() => {
          btn.disabled = false;
        });
    };
    return btn;
  }

  function startAction(id) {
    const action = findAction(state.service, id);
    if (!action) return;
    state.actionId = id;
    state.values = {};
    // Действию без полей и без цели спрашивать нечего — выполняем сразу (это
    // чтение: списки, карточки, деньги). Всё, что что-то меняет или требует
    // назвать ресурс, сначала показывает форму.
    if (!(action.fields || []).length && !action.target) {
      runAction(false);
      return;
    }
    render();
  }

  function runAction(confirmed) {
    const action = findAction(state.service, state.actionId);
    if (!action || state.busy) return;
    const req = request(state.service, state.actionId, state.values, confirmed);
    if (!req) {
      say("❌ Действие недоступно");
      return;
    }
    state.busy = true;
    const out = $("yc-act-out");
    if (out) {
      out.classList.remove("hidden");
      out.innerHTML = "";
      out.appendChild(el("div", "yc-act-busy", "⏳ Спрашиваю облако…"));
    }
    callApi(req.channel, req.args).then((r) => {
      state.busy = false;
      const sum = summarize(state.service, state.actionId, r);
      renderResult(action, sum, req);
      if (sum.ok) {
        // Журнал — только подписи: секретов в нём нет по построению.
        state.log.unshift({ ru: action.ru, text: sum.lines[0] || "готово" });
        state.log = state.log.slice(0, 12);
        // Что-то изменилось (или, может, нет) — пусть хозяин окна перечитает
        // список ресурсов: работать с устаревшей полкой нельзя.
        if (state.onDone) {
          try {
            state.onDone();
          } catch (e) {}
        }
      }
    });
  }

  function outBox() {
    let out = $("yc-act-out");
    if (!out) {
      out = el("div", "yc-act-out hidden");
      out.id = "yc-act-out";
    }
    return out;
  }

  function renderResult(action, sum, req) {
    const box = ensureBox();
    if (!box) return;
    let out = $("yc-act-out");
    if (!out) {
      out = outBox();
      box.appendChild(out);
    }
    out.classList.remove("hidden");
    out.innerHTML = "";
    out.classList.toggle("bad", !sum.ok && !sum.needsConfirm);

    const head = el("div", "yc-act-out-head", sum.needsConfirm ? "⚠ Нужно согласие" : sum.ok ? "✅ Готово" : "❌ Не получилось");
    out.appendChild(head);

    for (const line of sum.lines) out.appendChild(el("div", "yc-act-line", line));
    for (const w of sum.warn || []) out.appendChild(el("div", "yc-act-warn", "⚠ " + w));

    if (sum.secret) {
      // Секрет живёт ТОЛЬКО здесь и показывается один раз: облако второго раза
      // не даёт, поэтому рядом кнопка «скопировать» и честная подпись.
      const sec = el("div", "yc-act-secret");
      sec.appendChild(el("div", "yc-act-secret-title", sum.secretLabel + " — показывается один раз, сохрани сейчас:"));
      const code = el("code", "yc-act-secret-value", sum.secret);
      sec.appendChild(code);
      const copy = el("button", "btn btn-ghost btn-small", "Скопировать");
      copy.type = "button";
      copy.onclick = () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sum.secret);
        } catch (e) {}
        say("Скопировано — сохрани в хранилище паролей");
      };
      sec.appendChild(copy);
      out.appendChild(sec);
    }

    if (sum.needsConfirm) {
      const go = el("button", "btn btn-primary btn-small", "Подтвердить и выполнить");
      go.type = "button";
      go.onclick = () => runAction(true);
      const row = el("div", "yc-act-actionsrow");
      row.appendChild(go);
      out.appendChild(row);
    }

    // Речь — слышимая, а не только написанная: канал вернул её содержимым,
    // поэтому плеер живёт здесь же, в ответе. Файл при этом тоже записан (его
    // путь — в строке выше), так что забрать запись потом можно.
    for (const au of sum.audios || []) {
      const wrap = el("div", "yc-act-audio");
      wrap.appendChild(el("div", "yc-act-audio-voice", "🔊 " + (au.voice || "голос") + (au.path ? " · " + au.path : "")));
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "none";
      player.src = "data:" + (au.mime || "audio/mpeg") + ";base64," + au.base64;
      wrap.appendChild(player);
      out.appendChild(wrap);
    }
  }

  function logBox() {
    const wrap = el("div", "yc-act-log");
    if (!state.log.length) return wrap;
    wrap.appendChild(el("div", "yc-act-log-title", "Что уже сделано"));
    for (const l of state.log) wrap.appendChild(el("div", "yc-act-log-line", l.ru + " — " + l.text));
    return wrap;
  }

  const api = {
    CHANNELS: CHANNELS,
    OPS: OPS,
    FAMILIES: FAMILIES,
    ACTIONS: ACTIONS,
    VIEWS: VIEWS,
    forService: (service) => (ACTIONS[service] || []).map((a) => a.id),
    actionsFor: (service) => (ACTIONS[service] || []).slice(),
    channels: () => Object.keys(CHANNELS).map((k) => CHANNELS[k]),
    // Классификация YQL-запроса — точки для проверок (та же, что у канала).
    isDangerousQuery: isDangerousQuery,
    request: request,
    summarize: summarize,
    open: open,
    close: close,
    isOpen: isOpen,
    render: render,
    // Точка для проверок и для панели: описание действия без DOM.
    describe: (service, id) => {
      const a = findAction(service, id);
      if (!a) return null;
      return { id: a.id, ru: a.ru, op: a.op, channel: CHANNELS[service], danger: !!a.danger, paid: !!a.paid, confirmArg: a.confirmArg || "", fields: (a.fields || []).map((f) => f.key) };
    },
  };

  window.YcActions = api;
})();

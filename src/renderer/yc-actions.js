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
  };

  // Допустимые действия каждого канала. Сверяется с отказами в src/yc-ipc.js.
  const OPS = {
    compute: ["list", "card", "create", "delete", "start", "stop", "restart", "serial", "metrics", "snapshot", "delsnapshot", "cleansnapshots", "restoredisk", "sshkey"],
    vpc: ["list", "subnets", "groups", "addresses", "addsubnet", "delsubnet", "addgroup", "delgroup", "addrule", "delrule", "reserve", "release"],
    iam: ["list", "card", "keys", "roles", "create", "update", "delete", "grant", "revoke", "newkey", "delkey"],
    cloudFunctions: ["list", "card", "versions", "runtimes", "create", "update", "deploy", "invoke", "tag", "untag", "delversion", "delete", "public", "private", "access"],
    cdn: ["overview", "certs", "cert", "certnew", "certimport", "certupdate", "certdel", "cdn", "cdnlist", "cdninfo", "cdncreate", "cdnupdate", "cdnpurge", "cdndel", "origins", "origincreate", "originupdate", "origindel"],
    billing: ["overview", "accounts", "account", "budgets", "price", "services", "leaks"],
  };

  const FAMILIES = {
    compute: { title: "Виртуальные машины", ru: "машина" },
    vpc: { title: "Сети VPC", ru: "сеть" },
    iam: { title: "Сервисные аккаунты", ru: "аккаунт" },
    cloudFunctions: { title: "Функции", ru: "функция" },
    cdn: { title: "Сертификаты и CDN", ru: "ресурс" },
    certificateManager: { title: "Сертификаты", ru: "сертификат" },
    billing: { title: "Деньги в облаке", ru: "аккаунт" },
  };

  // ── Поля форм ─────────────────────────────────────────────────────────────
  function fld(key, label, extra) {
    return Object.assign({ key: key, label: label, type: "text" }, extra || {});
  }
  function target(label, key) {
    return fld(key || "name", label, { required: true });
  }
  // Подсказки-варианты берутся у облака (наборы, подсети, зоны, языки). Не
  // пришли — поле остаётся обычным текстом: действие всё равно выполнимо.
  const from = (channel, op, pick) => ({ channel: channel, op: op, pick: pick });

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
    const args = { op: action.op };
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
    if (!action) return { ok: false, lines: ["Неизвестное действие."], warn: [], secret: "", secretLabel: "" };
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
    return { ok: true, needsConfirm: false, lines: lines, warn: warn, secret: secret, secretLabel: secretLabel };
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
        callApi(CHANNELS[f.options.channel] || CHANNELS[state.service], { op: f.options.op }).then((r) => {
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
    const run = el("button", "btn btn-primary btn-small", action.danger ? "Выполнить (спросит подтверждение)" : "Выполнить");
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
      if (action.danger) {
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

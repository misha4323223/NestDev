"use strict";

/* ── Lockbox (секреты) — проверки и слова, БЕЗ сети ───────────────────────────
   Почему модуль. Секреты Lockbox в приложении были, но однобоко: сервис на полке
   показывал СПИСОК секретов, карточка ресурса умела добавить версию, а у агента
   был инструмент ycSecret (list/versions/putversion). У ПЛИТКИ действий не было
   ничего: ни посмотреть секрет и его версии, ни выдать доступ сервисному
   аккаунту, ни удалить секрет — всё это жило только в консоли облака. При этом
   секрет без версии бесполезен (ревизия ссылается на несуществующий ключ), а
   без роли lockbox.payloadViewer её вообще не прочитает.

   Что здесь. Только проверки и человеческие слова: имя секрета, статусы, строка
   секрета для списка, строка версии, поиск секрета по имени/id и разбор пар
   «ключ → значение». Сеть и сами запросы Lockbox живут в src/yandex-cloud.js
   (listSecrets/getSecret/listSecretVersions/putSecretVersion/grantSecretAccess) —
   дублировать их нельзя: у окна и агента должен быть один код, а не два похожих.

   Модуль чистый: ни Electron, ни окон. Его можно проверить в обычном Node. */

// Имя секрета — как у остальных ресурсов каталога: строчная латиница, цифры и
// дефис, начинается с буквы, 2–63 символа.
const NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя секрета: строчные латинские буквы, цифры и дефис (например app-env), 2–63 символа.");
  if (NAME_RE.test(nm)) return nm;
  throw new Error(
    "Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры и дефис, имя начинается с буквы и не заканчивается дефисом (2–63 символа). Подойдёт, например, «app-env»."
  );
}

// Статусы секрета словами: человеку английское слово ничего не говорит.
const STATUS_RU = {
  CREATING: "создаётся",
  ACTIVE: "готов",
  UPDATING: "обновляется",
  DELETING: "удаляется",
  ERROR: "ошибка",
};

function statusHuman(status) {
  const s = String(status || "").toUpperCase();
  return STATUS_RU[s] || (s ? s.toLowerCase() : "неизвестно");
}

function secretInfo(s) {
  const x = s || {};
  const cur = x.currentVersion || {};
  return {
    id: x.id || "",
    folderId: x.folderId || "",
    name: x.name || "",
    description: x.description || "",
    status: x.status || "",
    statusHuman: statusHuman(x.status),
    createdAt: x.createdAt || "",
    currentVersionId: cur.id || "",
    deletionProtection: !!x.deletionProtection,
    labels: x.labels && typeof x.labels === "object" ? x.labels : {},
  };
}

function secretLine(s) {
  const x = secretInfo(s);
  return "• " + (x.name || x.id) + (x.status ? " — " + x.statusHuman : "") + " (" + x.id + ")";
}

// Поиск секрета по имени или id. Пустой запрос у одного секрета — он и есть;
// у нескольких — «выбери сам» (null), как у API-шлюза и лог-групп.
function matchSecret(list, ref) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(ref == null ? "" : ref).trim();
  if (!q) return arr.length === 1 ? arr[0] : null;
  return arr.find((s) => s && s.id === q) || arr.find((s) => s && s.name === q) || null;
}

function versionLine(v) {
  const x = v || {};
  const keys = Array.isArray(x.payloadEntryKeys) ? x.payloadEntryKeys : [];
  const when = String(x.createdAt || "").replace("T", " ").slice(0, 19);
  return "• " + (x.id || "—") + (when ? " — " + when : "") + (x.status ? " · " + String(x.status).toLowerCase() : "") + (keys.length ? " · ключи: " + keys.join(", ") : "");
}

// Пары «ключ → значение» приходят и списком объектов (форма в панели), и обычным
// объектом (так пишет модель). Ключ проверяем ДО сети: Lockbox принимает только
// латиницу, цифры и знаки - _ . / \ @, а отказ пришёл бы уже после операции.
const ENTRY_KEY_RE = /^[-_./\\@0-9a-zA-Z]+$/;

function normalizeEntries(v) {
  const out = [];
  if (Array.isArray(v)) {
    for (const e of v) {
      if (!e || typeof e !== "object") continue;
      const key = String(e.key == null ? "" : e.key).trim();
      if (!key) continue;
      out.push({ key: key, value: e.value == null ? "" : String(e.value) });
    }
    return out;
  }
  if (v && typeof v === "object") {
    for (const key of Object.keys(v)) {
      const k = String(key).trim();
      if (!k) continue;
      out.push({ key: k, value: v[key] == null ? "" : String(v[key]) });
    }
  }
  return out;
}

function checkEntries(v) {
  const list = normalizeEntries(v);
  if (!list.length) throw new Error("Нет ни одной пары «ключ → значение» для версии секрета.");
  const bad = list.find((e) => !ENTRY_KEY_RE.test(e.key));
  if (bad) throw new Error("Ключ «" + bad.key + "» не годится для Lockbox: допустимы латиница, цифры и знаки - _ . / \\ @.");
  return list.map((e) => ({ key: e.key, textValue: e.value }));
}

// Роль по умолчанию: ровно то, что нужно ревизии, чтобы прочитать ЗНАЧЕНИЕ
// секрета. Широкий доступ к секрету не выдаём «на всякий случай».
const DEFAULT_ROLE = "lockbox.payloadViewer";

module.exports = {
  NAME_RE,
  STATUS_RU,
  ENTRY_KEY_RE,
  DEFAULT_ROLE,
  checkName,
  statusHuman,
  secretInfo,
  secretLine,
  matchSecret,
  versionLine,
  normalizeEntries,
  checkEntries,
};

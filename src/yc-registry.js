"use strict";

/* ── Container Registry (реестр образов) — проверки и слова, БЕЗ сети ─────────
   Почему модуль. Реестр образов на полке был, но у ПЛИТКИ действий не было
   ничего: создать реестр можно было только общим созданием ресурса, а образы
   жили в карточке реестра (список да удаление по одному). Между тем образы
   копятся с каждой выкаткой, занимают ПЛАТНОЕ хранилище и переживают выкатки —
   а убрать их пачкой («образы старше N дней») было нечем. Реестр в облаке не
   удаляется, пока в нём есть образы, так что без уборки его и не убрать.

   Что здесь. Проверки и человеческие слова: имя реестра, строка реестра, строка
   образа, размер в байтах словами, поиск реестра и образа по имени/id/тегу/digest.
   Сами запросы Container Registry живут в src/yandex-cloud.js
   (findRegistry/ensureRegistry/listRegistryImages/deleteRegistryImage) — этот
   модуль их не повторяет, чтобы у окна и агента был один код.

   Модуль чистый: ни Electron, ни окон. Его можно проверить в обычном Node. */

// Имя реестра — как у остальных ресурсов каталога: строчная латиница, цифры и
// дефис, начинается с буквы, 2–63 символа.
const NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя реестра: строчные латинские буквы, цифры и дефис (например app), 2–63 символа.");
  if (NAME_RE.test(nm)) return nm;
  throw new Error(
    "Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры и дефис, имя начинается с буквы и не заканчивается дефисом (2–63 символа). Подойдёт, например, «app»."
  );
}

const STATUS_RU = {
  CREATING: "создаётся",
  ACTIVE: "готов",
  DELETING: "удаляется",
  ERROR: "ошибка",
};

function statusHuman(status) {
  const s = String(status || "").toUpperCase();
  return STATUS_RU[s] || (s ? s.toLowerCase() : "");
}

function registryInfo(r) {
  const x = r || {};
  return {
    id: x.id || "",
    folderId: x.folderId || "",
    name: x.name || "",
    status: x.status || "",
    statusHuman: statusHuman(x.status),
    createdAt: x.createdAt || "",
    labels: x.labels && typeof x.labels === "object" ? x.labels : {},
  };
}

function registryLine(r) {
  const x = registryInfo(r);
  return "• " + (x.name || x.id) + (x.status ? " — " + x.statusHuman : "") + " (" + x.id + ")" +
    (x.createdAt ? " · создан " + String(x.createdAt).slice(0, 10) : "");
}

function matchRegistry(list, ref) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(ref == null ? "" : ref).trim();
  if (!q) return arr.length === 1 ? arr[0] : null;
  return arr.find((r) => r && r.id === q) || arr.find((r) => r && r.name === q) || null;
}

// Размер словами: у образа он приходит в байтах, а человеку нужны МБ.
function humanSize(bytes) {
  const v = Number(bytes) || 0;
  if (v >= 1048576) return (Math.round((v / 1048576) * 10) / 10) + " МБ";
  if (v >= 1024) return Math.round(v / 1024) + " КБ";
  return v + " Б";
}

function imageInfo(img) {
  const x = img || {};
  const tags = Array.isArray(x.tags) ? x.tags : [];
  const bytes = Number(x.size || x.compressedSize || 0);
  return {
    id: x.id || "",
    name: x.name || "",
    digest: x.digest || "",
    tags: tags,
    size: bytes,
    sizeHuman: humanSize(bytes),
    createdAt: x.createdAt || "",
    tagText: tags.length ? tags.join(", ") : "без тега",
  };
}

function imageLine(img) {
  const x = imageInfo(img);
  return "• " + (x.name || x.id) + " — теги: " + x.tagText + (x.size ? " · " + x.sizeHuman : "") + " · id " + x.id;
}

// Образ человек называет по-разному: тегом («app:v1.2» или «v1.2»), id или
// digest. Delete принимает ровно id, поэтому ищем по всем трём.
function matchImage(list, ref) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(ref == null ? "" : ref).trim();
  if (!q) return null;
  return (
    arr.find((i) => i && i.id === q) ||
    arr.find((i) => i && Array.isArray(i.tags) && i.tags.indexOf(q) >= 0) ||
    arr.find((i) => i && Array.isArray(i.tags) && i.tags.some((t) => String(t).split(":").pop() === q)) ||
    arr.find((i) => i && i.digest === q) ||
    null
  );
}

module.exports = {
  NAME_RE,
  STATUS_RU,
  checkName,
  statusHuman,
  registryInfo,
  registryLine,
  matchRegistry,
  humanSize,
  imageInfo,
  imageLine,
  matchImage,
};

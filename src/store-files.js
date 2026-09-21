"use strict";

/* ─── Мелочи хранилища: день и время по часам пользователя, маскировка секретов,
   атомарная запись текста. ───────────────────────────────────────────────────
   Вынесено из agent-store.js (часть 38). Состояния у модуля нет: всё, что пишет
   на диск, принимает путь аргументом.

   pad2 здесь ОДИН — и это ВАЖНО. В agent-store.js он был объявлен ДВАЖДЫ: в разделе
   памяти диалогов (первым) и в разделе дел (вторым). Второе объявление затеняло
   первое во всей области видимости модуля, то есть исполнялось именно оно. Разрез
   развёл бы эти два pad2 по разным модулям — и память диалогов молча начала бы
   считать день днями другой функцией. Оставлен тот, который исполнялся. */

const path = require("path");
const fs = require("fs");

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// Локальная дата (по часам пользователя) в виде ГГГГ-ММ-ДД.
function localDayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function localTimeKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds());
}

function localTimeHuman(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function dayKeyValid(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Маскируем только бесспорные секреты (длинные ключи и приватные ключи),
// чтобы случайный токен из переписки не осел в дневнике. Обычный код не трогаем.
const CTX_SECRET_RES = [
  /-----BEGIN[^-\n]*PRIVATE KEY-----[\s\S]*?-----END[^-\n]*PRIVATE KEY-----/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g,
];

function redactSecrets(text) {
  let s = String(text ?? "");
  for (const re of CTX_SECRET_RES) s = s.replace(re, "[секрет скрыт]");
  return s;
}

// Атомарная запись текста: временный файл → подмена (внезапное закрытие не оставит обрезанный файл).
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = {
  pad2,
  localDayKey,
  localTimeKey,
  localTimeHuman,
  dayKeyValid,
  redactSecrets,
  atomicWriteText,
};

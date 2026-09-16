"use strict";
/* Заглушка для <script src="bootstrap.js"> в index.html.
   Настоящее содержимое по этому пути отдаёт только мост телефона (src/mobile-bridge.js):
   он подмешивает window.__mobileBridge = true, и mobile-api.js подключается к ядру на ПК.
   В Electron и в веб-превью файла раньше не было вовсе, поэтому браузер на каждом запуске
   писал в консоль «Failed to load resource (ERR_FILE_NOT_FOUND)» (найдено живым тестом
   под Xvfb, 1.5.64). Пустой скрипт это убирает и ничего не меняет: без маркера моста
   mobile-api.js остаётся no-op, а preload/mock работают как раньше. */

/* Охрана полей ввода (field-guard.js): подключение продублировано здесь нарочно.
   Тег скрипта в index.html — основное место, но index.html огромный (история правок
   инструментами на нём спотыкалась), поэтому загрузчик стоит и в этом крошечном
   файле, который грузится перед app.js. Повторная загрузка безопасна: модуль ставит
   защиту ровно один раз (флаг root.__fieldGuardInstalled), а лишний <script> не
   добавляется, если тег уже есть в разметке. */
(function () {
  try {
    if (typeof document === "undefined" || !document || !document.createElement) return;
    if (document.querySelector && document.querySelector('script[src="field-guard.js"]')) return;
    var s = document.createElement("script");
    s.src = "field-guard.js";
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
  } catch {}
})();

"use strict";
/* Заглушка для <script src="bootstrap.js"> в index.html.
   Настоящее содержимое по этому пути отдаёт только мост телефона (src/mobile-bridge.js):
   он подмешивает window.__mobileBridge = true, и mobile-api.js подключается к ядру на ПК.
   В Electron и в веб-превью файла раньше не было вовсе, поэтому браузер на каждом запуске
   писал в консоль «Failed to load resource (ERR_FILE_NOT_FOUND)» (найдено живым тестом
   под Xvfb, 1.5.64). Пустой скрипт это убирает и ничего не меняет: без маркера моста
   mobile-api.js остаётся no-op, а preload/mock работают как раньше. */

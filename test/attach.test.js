"use strict";

/* ── Вложения в чат: скрепка, перетаскивание и вставка ──────────────────────
   Запуск: node test/attach.test.js   (входит в общий `npm test`)

   Что тут ломалось и почему набор появился только сейчас. Обработчик у скрепки
   написан (app.js открывает скрытое #file-input), и в обычном браузере всё
   работает — проверено живьём: клик → диалог → файл во вложениях. Но путь
   ВЕСИТ СЕБЯ ЦЕЛИКОМ на системном диалог выбора файла. В веб-превью, во
   встроенном веб-вью и на некоторых телефонах этот диалог недоступен, и
   человек видит «кнопка не нажимается», хотя обработчик есть и клик доходит.

   Поэтому у вложения должно быть три независимых пути, и набор проверяет
   именно наличие всех трёх и их честность:

     • скрепка — открывает #file-input (accept покрывает картинки и текст);
     • перетаскивание в композер — НЕ спрашивает диалог вообще, файл приходит
       прямо в страницу; без preventDefault на dragover браузер отменяет drop,
       поэтому проверяется именно он, а не сам факт addEventListener;
     • вставка из буфера — и картинка (clipboardData.items), и файл
       (clipboardData.files: вторая половина раньше не читалась вовсе, и
       вставленный файл молча пропадал).

   Про Chrome/Chromium сказано прямо: dialog он открывает, и вкладку песочницы
   без allow-same-origin тоже (localStorage в песочнице падает, но выбор файла
   работает). Значит, дело не в «диалоге вообще недоступен в браузере», а в
   поверхности, где превью показывают, — и лечится это вторым путём, а не
   отказом от кнопки.

   Проверки здесь — по исходникам: живого окна у набора нет, а логика вложения
   живёт в замыкании app.js, наружу она не выставлена. Поведение подтверждено
   отдельно живым прогоном в Chromium (клик/drop/paste), здесь — контракт. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const HTML = read("src", "renderer", "index.html");
const CSS = read("src", "renderer", "replit-theme.css");
const PKG = JSON.parse(read("package.json"));
// Единственное прямое чтение app.js: вложение живёт в замыкании оболочки, наружу
// не выставлено, поэтому контракт проверяется по её исходнику. Всё остальное
// берётся из разметки и стилей.
const APP = read("src", "renderer", "app.js");

// Кусок оболочки от навешивания обработчиков вложения до следующего за ним
// обработчика — иначе проверки видели бы соседний код того же файла.
function around(anchor, tail) {
  const i = APP.indexOf(anchor);
  assert.ok(i > 0, "в app.js нет якоря: " + anchor);
  const j = APP.indexOf(tail, i);
  assert.ok(j > i, "в app.js после якоря нет хвоста: " + tail);
  return APP.slice(i, j);
}

(async () => {
  console.log("[1] Разметка: скрепка и скрытое поле рядом, подсказка честная");

  await test("attach: у кнопки и поля есть id, и лежат в одном composer-btns", () => {
    const btn = HTML.indexOf('id="btn-attach-file"');
    const input = HTML.indexOf('id="file-input"');
    assert.ok(btn > 0, "в разметке нет кнопки скрепки");
    assert.ok(input > 0, "в разметке нет поля выбора файла");
    const open = HTML.lastIndexOf('<div class="composer-btns">', btn);
    const close = HTML.indexOf("</div>", btn);
    assert.ok(open > 0 && open < btn && btn < close, "скрепка уехала из блока кнопок композера");
    assert.ok(input > open && input < btn, "поле выбора файла стоит не рядом со скрепкой");
    // Тег целиком: type="file" стоит левее id, а не правее.
    const tag = HTML.slice(HTML.lastIndexOf("<input", input), HTML.indexOf(">", input));
    assert.ok(/type="file"/.test(tag), "поле выбора не того типа");
    assert.ok(/multiple/.test(tag), "поле выбора не Multiple — можно приложить только один файл");
  });

  await test("attach: accept покрывает и картинки, и обычные файлы", () => {
    const i = HTML.indexOf('id="file-input"');
    const accept = /accept="([^"]*)"/.exec(HTML.slice(i - 200, i + 200));
    assert.ok(accept, "у поля выбора нет accept");
    assert.ok(accept[1].indexOf("image/*") >= 0, "картинки в accept не попали");
    for (const ext of [".txt", ".js", ".py", ".json", ".md", ".csv"]) {
      assert.ok(accept[1].indexOf(ext) >= 0, "в accept нет " + ext);
    }
  });

  await test("attach: подсказка кнопки называет оба пути, а не только диалог", () => {
    const i = HTML.indexOf('id="btn-attach-file"');
    const title = /title="([^"]*)"/.exec(HTML.slice(i, i + 300));
    assert.ok(title, "у кнопки нет title — непонятно, что она делает");
    assert.ok(/перетащ/i.test(title[1]), "подсказка не упоминает перетаскивание: " + title[1]);
    assert.ok(/встав/i.test(title[1]), "подсказка не упоминает вставку из буфера: " + title[1]);
  });

  await test("attach: подсказка в поле остаётся короткой, путь перетаскивания — в кнопке", () => {
    // Подсказка под полем — короткая (её длина проверяется в smoke), про перетаскивание
    // честно сказано в title скрепки и в подсветке рамки при перетаскивании.
    const i = HTML.indexOf('class="input-hint"') - "<span ".length;
    const hint = /<span class="input-hint">([^<]*)<\/span>/.exec(HTML.slice(i, i + 300));
    assert.ok(hint, "в композере нет короткой подсказки");
    assert.ok(hint[1].length <= 60, "подсказка в композере разрослась: " + hint[1]);
  });

  console.log("\n[2] Скрепка: обработчик и чтение выбранного");

  await test("attach: скрепка открывает скрытое поле выбора", () => {
    const code = around('$("btn-attach-file").onclick', '$("chat-title")');
    assert.ok(/\$\("btn-attach-file"\)\.onclick = \(\) => \$\("file-input"\)\.click\(\)/.test(code),
      "кнопка не открывает #file-input — ровно тот баг, что видели");
  });

  await test("attach: выбранные файлы уходят в attachFile, значение поля сбрасывается", () => {
    const code = around('$("file-input").addEventListener("change"', '$("chat-title")');
    assert.ok(/e\.target\.files/.test(code), "обработчик не читает выбранные файлы");
    assert.ok(/Array\.from\(e\.target\.files \|\| \[\]\)/.test(code), "файлы не разворачиваются в массив");
    assert.ok(/attachFile\(f\)/.test(code), "выбранный файл не прикрепляется");
    assert.ok(/e\.target\.value = ""/.test(code), "значение поля не сбрасывается — тот же файл второй раз не приложить");
  });

  console.log("\n[3] Перетаскивание: путь, который не спрашивает диалог");

  await test("attach: композер слушает все четыре события перетаскивания", () => {
    const code = around('const composerEl = document.querySelector(".composer")', '$("chat-title")');
    for (const ev of ["dragenter", "dragover", "dragleave", "drop"]) {
      assert.ok(code.indexOf('addEventListener("' + ev + '"') > 0, "нет слушателя " + ev);
    }
  });

  await test("attach: dragover отменяет действие браузера по умолчанию", () => {
    // Без preventDefault браузер не отдаёт drop, и файл не приходит никогда.
    const code = around('const composerEl = document.querySelector(".composer")', '$("chat-title")');
    const i = code.indexOf('addEventListener("dragover"');
    const body = code.slice(i, code.indexOf("});", i));
    assert.ok(body.indexOf("e.preventDefault()") > 0, "dragover не вызывает preventDefault — drop будет отменён");
    assert.ok(/dropEffect = "copy"/.test(body), "dragover не просит курсор копирования");
  });

  await test("attach: при перетаскивании видна рамка, а после — снимается", () => {
    const code = around('const composerEl = document.querySelector(".composer")', '$("chat-title")');
    assert.ok(/classList\.add\("drag-over"\)/.test(code), "класс drag-over не ставится — перетаскивание не видно");
    assert.ok(/classList\.remove\("drag-over"\)/.test(code), "класс drag-over не снимается — рамка залипнет");
  });

  await test("attach: drop прикрепляет файлы и говорит, что прикрепил", () => {
    const code = around('addEventListener("drop"', "const ChatContinue");
    assert.ok(/e\.preventDefault\(\)/.test(code), "drop не вызывает preventDefault");
    assert.ok(/e\.dataTransfer\s*&&\s*e\.dataTransfer\.files/.test(code), "drop не читает файлы из dataTransfer");
    assert.ok(/attachFile\(f\)/.test(code), "перетащенный файл не прикрепляется");
    assert.ok(/toast\(/.test(code), "перетаскивание проходит без единого слова — человек не поймёт, что файл прикрепился");
  });

  await test("attach: не файлы перетаскивать незачем — подсветка только на файлах", () => {
    const code = around('const composerEl = document.querySelector(".composer")', '$("chat-title")');
    assert.ok(/t === "Files"/.test(code), "нет проверки, что в перетаскивании именно файлы (текст тоже подсветит поле)");
  });

  await test("attach: правило рамки есть, а не только цвет подсказки", () => {
    const i = CSS.indexOf(".composer.drag-over");
    assert.ok(i > 0, "в replit-theme.css нет правила для .composer.drag-over");
    const rule = CSS.slice(i, CSS.indexOf("}", i));
    assert.ok(/border-color/.test(rule), "при перетаскивании не подсвечивается рамка");
    assert.ok(/box-shadow/.test(rule), "при перетаскивании нет кольца вокруг поля");
  });

  console.log("\n[4] Вставка из буфера: и картинка, и файл");

  await test("attach: вставка читает clipboardData.files, а не только картинки", () => {
    const code = around("function onInputPaste", "function hideAttachBar");
    assert.ok(/dt\.files/.test(code), "буфер читается только как картинка — вставленный файл пропадает");
    assert.ok(/Array\.from\(dt\.files \|\| \[\]\)/.test(code), "файлы из буфера не разворачиваются в массив");
    assert.ok(/attachFile\(f\)/.test(code), "файл из буфера не прикрепляется");
  });

  await test("attach: картинка из буфера по-прежнему на первом месте", () => {
    const code = around("function onInputPaste", "function hideAttachBar");
    assert.ok(/it\.type\.startsWith\("image\/"\)/.test(code), "картинка из буфера больше не распознаётся");
    assert.ok(/getAsFile/.test(code), "картинка из буфера не достаётся в файл");
  });

  await test("attach: вставленный файл не вставляется текстом в поле", () => {
    const code = around("function onInputPaste", "function hideAttachBar");
    const tail = code.slice(code.indexOf("if (taken)"));
    assert.ok(/e\.preventDefault\(\)/.test(tail), "файл из буфера вставится в поле текстом (бинарный мусор в сообщении)");
  });

  console.log("\n[5] Набор в цепочке");

  await test("attach: набор стоит в цепочке npm test — иначе это не набор", () => {
    const chain = String((PKG.scripts && PKG.scripts.test) || "");
    assert.ok(chain.indexOf("test/attach.test.js") >= 0,
      "набор не попал в цепочку npm test (правило проекта: набор вне цепочки — это не набор)");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

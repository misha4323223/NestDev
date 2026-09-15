"use strict";
/* ─── Разбор связности: не забыли ли передать модулю состояние main.js ────────
   При разрезании большого файла самая дорогая ошибка — имя, оставшееся в main.js
   и не переданное через deps. Проверка синтаксиса её не видит, а тесты не видят,
   если не ходят именно в эту ветку: падает уже у пользователя, причём в конкретном
   инструменте («stripAnsi is not defined»). Так и нашлись stripAnsi, spawnCollect,
   auxConfig и ещё пять десятков имён в реестре инструментов.

   Разбор намеренно строгий к шуму: комментарии, строки и регулярные выражения
   вырезаются, поэтому «application/json» не считается использованием имени json.
   Своими считаются и объявления функций, и ключи get/set моста живых значений, и
   параметры (включая catch, стрелки и for-of) — иначе страж ругался бы на locals.

   Второй разбор ловит обратную ошибку: присваивание чужому имени. Значение,
   переданное копией, «застынет» на null, и особенность работы приложения
   (последние правки, сводка плана) молча перестанет обновляться. */

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/* Комментарии внутри блока деструктуризации убираем отдельно: полное вырезание
   комментариев по всему файлу рискованно (открывающий комментарий внутри строкового
   литерала съедает код до следующего закрывающего), а внутри require-блока это ровно
   то, что нужно. */
function namesFromBlock(block) {
  const out = [];
  for (const part of stripComments(block).split(",")) {
    let name = part.split(":").pop().trim().replace(/=.*$/, "").trim();
    name = name.replace(/^\.\.\./, "").trim();
    if (/^[A-Za-z0-9_$]+$/.test(name)) out.push(name);
  }
  return out;
}

/* Имена, доступные в main.js: объявления, деструктурированные require (в том
   числе перенесённые на много строк — так подключается agent-core.js). */
function mainTopNames(src) {
  const top = new Set();
  for (const line of src.split("\n")) {
    const m =
      line.match(/^(?:async )?function ([A-Za-z0-9_$]+)/) ||
      line.match(/^(?:const|let|var) ([A-Za-z0-9_$]+)\s*=/) ||
      line.match(/^class ([A-Za-z0-9_$]+)/);
    if (m) top.add(m[1]);
    const one = line.match(/^(?:const|let|var)\s*\{([^}]+)\}\s*=/);
    if (one) namesFromBlock(one[1]).forEach((n) => top.add(n));
  }
  for (const m of src.matchAll(/^\s*(?:const|let|var)\s*\{([\s\S]{0,4000}?)\}\s*=/gm)) {
    namesFromBlock(m[1]).forEach((n) => top.add(n));
  }
  return top;
}

const GLOBALS = [
  "deps", "live", "require", "module", "exports", "process", "console", "Buffer", "JSON", "Object", "Array",
  "String", "Number", "Boolean", "Math", "Date", "Error", "Promise", "RegExp", "Map", "Set", "WeakMap",
  "Symbol", "global", "globalThis", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
  "URL", "URLSearchParams", "fetch", "AbortController", "TextEncoder", "TextDecoder", "structuredClone",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "arguments",
  "undefined", "this", "Electron",
];

/* Свои имена модуля: объявления, параметры, переменные циклов, распаковки. */
function ownNames(code) {
  const own = new Set(GLOBALS);
  const addParams = (chunk, destructure) => {
    for (const part of String(chunk).split(",")) {
      let name = destructure ? part.split(":").pop() : part;
      name = name.replace(/=.*$/, "").replace(/^\.\.\./, "").trim();
      name = name.split(/\s+/).pop() || "";
      if (/^[A-Za-z0-9_$]+$/.test(name)) own.add(name);
    }
  };
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z0-9_$]+)/g)) own.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z0-9_$]+)/g)) own.add(m[1]);
  for (const m of code.matchAll(/\b(?:get|set)\s+([A-Za-z0-9_$]+)\s*\(/g)) own.add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)/g)) addParams(m[1]);
  for (const m of code.matchAll(/\(([^()]{0,300})\)\s*=>/g)) addParams(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z0-9_$]+)\s*=>/g)) own.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z0-9_$]+)/g)) own.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)) own.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) addParams(m[1], true);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) own.add(m[1]);
  return own;
}

/* Код без строк и регулярных выражений: только в них «json» не имя, а текст. */
function bareCode(src) {
  return stripComments(src)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/(^|[=(,:[!&|?{};])\s*\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/gm, "$1 REGEX");
}

/* Имена, которые модуль берёт из deps. */
function depsOf(modSrc) {
  const deps = new Set();
  const block = modSrc.match(/const \{([\s\S]*?)\} = deps;/);
  if (block) block[1].split(/[,\n]/).forEach((part) => {
    const name = part.trim().replace(/=.*$/, "").trim();
    if (/^[A-Za-z0-9_$]+$/.test(name)) deps.add(name);
  });
  return deps;
}

function usedIn(code, name) {
  return new RegExp("([^.\\w$])" + name + "(?!\\s*:)(?![\\w$])").test(code);
}

/* Мост живых значений вырезаем по балансу скобок: он может быть и в одну
   строку (в проверке самого стража), и развёрнут на много строк, как в модулях. */
function maskLiveBlock(code) {
  const at = code.indexOf("const live = {");
  if (at < 0) return code;
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        if (code[end] === ";") end++;
        return code.slice(0, at) + " ".repeat(end - at) + code.slice(end);
      }
    }
  }
  return code;
}

/* Имена, которые модуль объявил живыми (get/set в мосте), но всё ещё использует
   голыми вне моста. Такое обращение проходит разбор «имя есть в deps», но падает
   у пользователя: «activeRunUndo is not defined» — откат правок не работал. */
function bareLiveNames(code) {
  const body = maskLiveBlock(code);
  const keys = new Set();
  for (const m of code.matchAll(/\b(?:get|set)\s+([A-Za-z0-9_$]+)\s*\(/g)) keys.add(m[1]);
  const bad = [];
  for (const key of keys) {
    if (new RegExp("(^|[^.\\w$])" + key + "(?![\\w$])").test(body)) bad.push(key);
  }
  return bad;
}

/* Проверяет все вынесенные модули проекта. */
function scanWiring(root, modules, fs, path) {
  const mainSrc = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const top = mainTopNames(mainSrc);
  const missing = [];
  const assigns = [];
  const bareLive = [];
  for (const file of modules) {
    const modSrc = fs.readFileSync(path.join(root, "src", file), "utf8");
    const code = bareCode(modSrc);
    const own = ownNames(code);
    const deps = depsOf(modSrc);
    for (const name of top) {
      if (own.has(name) || deps.has(name)) continue;
      if (usedIn(code, name)) missing.push(file + " → " + name);
    }
    // Присваивание чужому имени: значение обязано приходить функцией из live.
    for (const m of code.matchAll(/(^|[^.\w$\[])([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?![=>])/gm)) {
      const name = m[2];
      if (own.has(name) || !top.has(name)) continue;
      if (!new RegExp("set\\s+" + name + "\\s*\\(").test(code)) assigns.push(file + " → " + name);
    }
    for (const name of bareLiveNames(code)) bareLive.push(file + " → " + name);
  }
  return { missing: [...new Set(missing)], assigns: [...new Set(assigns)], bareLive: [...new Set(bareLive)] };
}

module.exports = { scanWiring, mainTopNames, bareLiveNames, bareCode, ownNames, depsOf };

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

/* Код без строк и регулярных выражений: только в них «json» не имя, а текст.
   Контекстов, после которых начинается литерал, больше одного: присваивание и
   знаки после него, а ещё `return`, `typeof`, `case` и стрелка — иначе литерал в
   `return /^(unix:path=|unix:abstract=)/` остался бы в тексте, и страж ругался бы
   на имя `path`, которого в модуле нет (ложное срабатывание на tasks-reminders.js). */
function bareCode(src) {
  return stripComments(src)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/(^|[=(,:[!&|?{};]|\b(?:return|typeof|case)\b|=>)\s*\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/gm, "$1 REGEX");
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

/* ─── Порядок на верхнем уровне main.js ───────────────────────────────────────
   Третья ошибка разреза, которой не видит ни синтаксическая проверка, ни разбор
   deps выше: значение читают РАНЬШЕ, чем оно объявлено через const. Это не
   undefined, а падение всего приложения при загрузке:

     ReferenceError: Cannot access 'ycCompute' before initialization

   (жизнь: модуль денег начал получать машины и сеть, а createYcCompute стоял
   ниже по файлу — окно падало у пользователя, а тесты молчали, потому что
   main.js целиком не собирается ни в одной проверке.)

   Считаем только верхний уровень: внутри функций и стрелок порядок другой —
   там имя читается в момент вызова, уже после объявления. */
function topLevelStatements(code) {
  const lines = code.split("\n");
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Верхний уровень проекта начинается с нулевой колонки — тела функций и
    // стрелок отсекаются этим же правилом, отдельного разбора скобок не нужно.
    if (cur === null && /^(?:const|let|var|function|class|async\s+function|[A-Za-z_$][\w$]*\s*\()/.test(line)) {
      cur = { line: i + 1, text: "" };
    }
    if (cur === null) continue;
    cur.text += line + "\n";
    const t = line.trimEnd();
    if (/;\s*$/.test(t) || t === "}") {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* Тела стрелок вырезаем: стрелка исполняется в момент вызова, а не в строке, где
   она записана, поэтому `window: () => mainWindow` при `let mainWindow` ниже —
   не ошибка (мост live в main.js устроен именно так). Без этого страж ругался бы
   на верную проводку и был бы выключен на второй день. */
function maskArrowBodies(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf("=>", i);
    if (at < 0) return out + text.slice(i);
    out += text.slice(i, at) + "=> _ ";
    let j = at + 2;
    while (j < text.length && /\s/.test(text[j])) j++;
    const open = text[j];
    if (open === "{" || open === "(") {
      const close = open === "{" ? "}" : ")";
      let depth = 0;
      while (j < text.length) {
        if (text[j] === open) depth++;
        else if (text[j] === close && --depth === 0) { j++; break; }
        j++;
      }
    } else {
      // Выражение-тело: до запятой, закрывающей скобки или конца строки.
      while (j < text.length && text[j] !== "," && text[j] !== "}" && text[j] !== "\n") j++;
    }
    i = j;
  }
}

/* Тела методов и блоков после `)` — тоже «позже»: блок исполняется в момент
   вызова. Жизнь: мост live держит геттеры (`get mainWindow() { return mainWindow; }`),
   и без этого страж считал бы верную проводку ошибкой. */
function maskParenBodies(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf("{", i);
    if (at < 0) return out + text.slice(i);
    if (!/\)\s*$/.test(text.slice(i, at))) {
      out += text.slice(i, at + 1);
      i = at + 1;
      continue;
    }
    let depth = 0;
    let j = at;
    while (j < text.length) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) { j++; break; }
      j++;
    }
    out += text.slice(i, at) + "_ ";
    i = j;
  }
}

function scanMainOrder(src) {
  const code = bareCode(src);
  const declared = new Map(); // имя → строка объявления на верхнем уровне
  const note = (name, index) => {
    if (declared.has(name)) return;
    declared.set(name, code.slice(0, index).split("\n").length);
  };
  for (const m of code.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/gm)) note(m[1], m.index);
  for (const m of code.matchAll(/^(?:const|let|var)\s*\{([\s\S]{0,4000}?)\}\s*=/gm)) {
    for (const n of namesFromBlock(m[1])) note(n, m.index);
  }
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) note(m[1], m.index);
  for (const m of code.matchAll(/^class\s+([A-Za-z0-9_$]+)/gm)) note(m[1], m.index);

  const bad = [];
  for (const st of topLevelStatements(code)) {
    // Тело объявления функции/класса и тело стрелки исполняются позже: там
    // обращение к объявленному ниже — норма (мост live и отложенные стрелки).
    if (/^(?:async\s+)?function\b/.test(st.text) || /^class\b/.test(st.text)) continue;
    // Шапку объявления («const NAME =») срезаем: это не обращение к имени.
    // Ищем именно знак присваивания после имени, а не первый «=» в тексте —
    // иначе у строки с `=>` шапкой становилась чужая строка (живая находка).
    const head = st.text.match(/^(?:const|let|var)\s+(?:[A-Za-z0-9_$]+|\{[\s\S]*?\})\s*=\s*/);
    const checked = maskParenBodies(maskArrowBodies(head ? st.text.slice(head[0].length) : st.text));
    for (const m of checked.matchAll(/(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const name = m[2];
      const decl = declared.get(name);
      if (decl == null || decl <= st.line) continue;
      const after = checked[m.index + m[0].length];
      if (after === ":") continue; // ключ свойства — не обращение к имени
      if (after === "(") {
        // Имя метода в объекте: `{ foo() {} }`, `get foo() {}`, `set foo(v) {}`.
        const tail = checked.slice(0, m.index + m[1].length).replace(/\s+$/, "");
        if (/[{,]$/.test(tail) || /\b(?:get|set)\s*[A-Za-z0-9_$]*$/.test(tail)) continue;
      }
      bad.push(name + " (строка " + st.line + ", объявлено в " + decl + ")");
    }
  }
  return [...new Set(bad)];
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

module.exports = { scanWiring, scanMainOrder, topLevelStatements, maskArrowBodies, maskParenBodies, mainTopNames, bareLiveNames, bareCode, ownNames, depsOf };

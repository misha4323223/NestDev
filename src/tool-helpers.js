"use strict";

/* ─── Помощники инструментов: пакетный менеджер, тесты, дифф ───────────────────
   Вынесено из main.js (этап B, часть 10). Мелочи, на которых стоят инструменты
   агента и без которых они врут или ничего не делают:

     • detectPackageManager / hasLock — по lockfile понять, чем проект ставит
       зависимости (bun / pnpm / yarn / npm). Ошибка здесь — команда вида
       «npm install» в проекте на bun, то есть чужая пачка файлов;
     • summarizeTestOutput — выжать из вывода тестового раннера итог: сколько
       прошло, сколько упало, какие тесты упали. Агент читает именно этот итог,
       а не тысячи строк вывода;
     • unifiedDiff — настоящий unified-дифф через git diff --no-index.

   Живого состояния нет: пути приходят аргументами, настройки — функцией. */

function createToolHelpers(deps) {
  const { fs, path, execFile, envFor, stripAnsi, agentWorkDir, loadSettings } = deps;

// Определяет пакетный менеджер проекта по lockfile.
function detectPackageManager(cwd) {
  const has = (name) => fs.existsSync(path.join(cwd, name));
  if (has("bun.lockb") || has("bun.lock")) return { name: "bun", bin: "bun", add: "add", flagDev: "-d" };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", bin: "pnpm", add: "add", flagDev: "-D" };
  if (has("yarn.lock")) return { name: "yarn", bin: "yarn", add: "add", flagDev: "-D" };
  return { name: "npm", bin: "npm", add: "install", flagDev: "-D" };
}

function hasLock(kind) {
  const cwd = agentWorkDir(loadSettings());
  const has = (name) => fs.existsSync(path.join(cwd, name));
  if (kind === "bun") return has("bun.lockb") || has("bun.lock");
  return has("package-lock.json") || has("npm-shrinkwrap.json");
}

// Выжимает из вывода тестового раннера краткий итог: сколько прошло/упало и какие тесты упали.
function summarizeTestOutput(out) {
  const s = String(out || "");
  const summary = [];
  // «прошло» — не украшение: так печатает итог собственный `npm test` этого проекта,
  // и без него агент видел в сводке только упавшие тесты.
  const passMatch = s.match(/Tests:?\s+(\d+)\s+(passed|passing|пройден|прошло)/i) || s.match(/(\d+)\s*(passed|passing|пройден|прошло)/i) || s.match(/passed\s*(\d+)/i);
  const failMatch = s.match(/Tests:?\s+.*?(\d+)\s+(failed|failing|упал)/i) || s.match(/(\d+)\s*(failed|failing|упал)/i) || s.match(/failed\s*(\d+)/i);
  if (passMatch) summary.push("✅ прошло: " + passMatch[1]);
  if (failMatch) summary.push("❌ упало: " + failMatch[1]);
  const failLines = s.split("\n").map((l) => l.trim()).filter((l) => l && l.length < 200 && /^(✕|✗|×|FAIL\b|●|✖|❌)/.test(l)).slice(0, 15);
  if (failLines.length) summary.push("Упавшие тесты:\n" + failLines.join("\n"));
  if (!summary.length && /(fail|error)/i.test(s)) summary.push("В выводе есть ошибки/упавшие тесты — смотри полный вывод.");
  return summary.join("\n");
}

// Unified-дифф двух файлов/папок через git diff --no-index (git уже есть в системе).
function unifiedDiff(p1, p2) {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--no-index", "--", p1, p2], {
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...envFor("git.read"), GIT_TERMINAL_PROMPT: "0" },
    }, (err, stdout, stderr) => {
      // git diff --no-index возвращает код 1 при различиях — это норма, патч в stdout.
      resolve({ patch: stripAnsi((stdout || "") + (stderr || "")).trim() });
    });
  });
}
  return { detectPackageManager, hasLock, summarizeTestOutput, unifiedDiff };
}

module.exports = { createToolHelpers };

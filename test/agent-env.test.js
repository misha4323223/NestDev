"use strict";

/* ── Окружение агента и назначения инструментов (src/agent-env.js) ─────────────
   Запуск: node test/agent-env.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 22). Здесь одна точка правды о том,
   какая переменная окружения доедет до какой команды. Ошибки на этом шаге тихие
   и дорогие — проверяем поведением, а не «строка на месте»:

     • утечка секрета в команду-дамп — «env»/«printenv» печатают всё окружение,
       и модель одной строкой выводит пароли пользователя в чат;
     • секрет уехал не тому инструменту — переменная с выдачей доходит ТОЛЬКО
       до названных инструментов и групп;
     • опечатка в выдаче открыла переменную всем — «записи нет» и «запись без
       допустимых имён» обязаны вести себя по-разному;
     • назначение не снято после вызова — следующий инструмент получил бы чужую
       выдачу (и при сбое внутри операции тоже);
     • автоматические YC_* осели в настройках — тогда OAuth-обмен подменяет то,
       что человек задал руками.
   Политика прав берётся НАСТОЯЩАЯ (src/tool-policy.js): именно она решает
   выдачу, и подменять её в проверке — значит проверять не то. Подменены только
   журнал, облако, yc CLI и мост к системному разделу. Сети в тесте нет. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createAgentEnv } = require(path.join(ROOT, "src", "agent-env.js"));
const toolPolicy = require(path.join(ROOT, "src", "tool-policy.js"));

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

// Сборка модуля с подменённой внешней обвязкой. Всё, что модуль делает снаружи,
// записывается — так проверка видит, что именно он отдал журналу и в PATH.
function makeEnv(o) {
  o = o || {};
  const seen = { secrets: [], merged: [], pathAsked: 0 };
  const env = createAgentEnv({
    toolPolicy,
    audit: {
      setSecrets: (v) => seen.secrets.push(v),
    },
    app: { getPath: () => o.userData || path.join(ROOT, ".tmp-agent-env-test") },
    path,
    yandexCloud: {
      getIamTokenInfo: async () => o.iam || { token: "IAM-TEST", expiresAtMs: Date.now() + 3600 * 1000 },
    },
    ycCli: {
      binDir: () => {
        seen.pathAsked++;
        return o.ycDir === undefined ? "" : o.ycDir;
      },
    },
    live: {
      getYcConfig: () => (s) => (s && s.yc) || {},
      envPathInfo: () => ({ value: o.pathValue || "" }),
      setMergedPath: (before, dir) => {
        seen.merged.push([before, dir]);
        return before + path.delimiter + dir;
      },
    },
  });
  return { env: env, seen: seen };
}

const cfg = { oauth: "OAUTH-SECRET", cloudId: "b1g", folderId: "f1" };

(async () => {
  console.log("Окружение агента: выдача, дампы, YC и назначения");

  await test("выдача по назначению: переменная доезжает только своим инструментам", () => {
    const { env } = makeEnv();
    env.applyAgentEnv({ agentEnv: { PATH: "/bin", API_KEY: "k" }, agentEnvScopes: { API_KEY: ["git"] } });
    assert.strictEqual(env.envFor("git.read").API_KEY, "k", "git.read не получил выданное ему");
    assert.strictEqual(env.envFor("git.push").API_KEY, "k", "группа git не выдаёт переменную всем своим инструментам");
    assert.strictEqual(env.envFor("terminal.execute").API_KEY, undefined, "терминал получил чужой секрет");
    assert.strictEqual(env.envFor().API_KEY, undefined, "без назначения ограниченная переменная выдана всем");
    assert.strictEqual(env.envFor("git.read").PATH, "/bin", "неограниченная переменная перестала доходить");
    assert.strictEqual(env.envFor("git.read").NOPE, undefined, "появилась переменная, которой не задавали");
  });

  await test("опечатка в выдаче закрывает переменную, а не открывает её всем", () => {
    const { env } = makeEnv();
    env.applyAgentEnv({ agentEnv: { API_KEY: "k" }, agentEnvScopes: { API_KEY: ["git.read.typo"] } });
    assert.strictEqual(env.envFor("terminal.execute").API_KEY, undefined, "терминал получил секрет при опечатке");
    assert.strictEqual(env.envFor("git.read").API_KEY, undefined, "опечатка в выдаче открыла переменную");
    // А «записи нет» — это по-прежнему «доходит всюду».
    const open = makeEnv();
    open.env.applyAgentEnv({ agentEnv: { OPEN_KEY: "v" } });
    assert.strictEqual(open.env.envFor("terminal.execute").OPEN_KEY, "v", "переменная без выдачи перестала доходить");
  });

  await test("команда-дамп окружения секретов не получает, обычная команда получает", () => {
    const { env } = makeEnv();
    env.applyAgentEnv({ agentEnv: { PATH: "/bin", API_KEY: "k" } });
    for (const dump of ["env", "printenv", "set", "Get-ChildItem Env:"]) {
      const e = env.commandEnv(dump);
      assert.ok(!("API_KEY" in e), dump + ": команда-дамп получила секрет");
      assert.strictEqual(e.PATH, "/bin", dump + ": у команды-дампа пропал PATH");
    }
    // Осознанный запрос конкретной переменной — это не дамп, он работает.
    assert.strictEqual(env.commandEnv("printenv MY_KEY").API_KEY, "k", "явный запрос переменной перестал работать");
    const build = env.commandEnv("npm run build");
    assert.strictEqual(build.API_KEY, "k", "обычная команда не получила окружение агента");
    assert.strictEqual(build.GIT_TERMINAL_PROMPT, "0", "git не перестал спрашивать пароль вслух");
    assert.strictEqual(build.FORCE_COLOR, "0", "в вывод команд вернулись цвета ANSI");
  });

  await test("пробы окружения секретов не требуют", () => {
    const { env } = makeEnv();
    env.applyAgentEnv({ agentEnv: { PATH: "/bin", PATHEXT: ".EXE", api_key: "k", TEMP: "/tmp" } });
    const probe = env.probeEnv();
    assert.ok(!("api_key" in probe), "проба версии программы получила секрет");
    assert.deepStrictEqual(Object.keys(env.pathOnlyEnv()).sort(), ["PATH", "PATHEXT", "TEMP"], "в «только пути» попало лишнее");
    assert.strictEqual(probe.PATH, "/bin", "проба осталась без PATH");
  });

  await test("команда внутри облачного инструмента получает выданное инструменту, а не терминалу", async () => {
    const { env } = makeEnv();
    env.applyAgentEnv({ agentEnv: { DB_PASSWORD: "pg-secret" }, agentEnvScopes: { DB_PASSWORD: ["db.query"] } });
    assert.strictEqual(env.commandEnv("npm i").DB_PASSWORD, undefined, "обычная команда получила чужой секрет");
    await env.withCapability("db.query", () => {
      assert.strictEqual(env.commandEnv("psql -c \"select 1\"").DB_PASSWORD, "pg-secret", "команда инструмента не получила выданное");
    });
    assert.strictEqual(env.commandEnv("npm i").DB_PASSWORD, undefined, "выдача осталась после операции");
  });

  await test("назначение возвращается после операции — и при сбое внутри неё", async () => {
    const { env } = makeEnv();
    assert.strictEqual(env.getCapability(), "", "назначение не пустое до работы");
    await env.withCapability("git.push", async () => {
      assert.strictEqual(env.getCapability(), "git.push", "внутри операции назначение не объявлено");
    });
    assert.strictEqual(env.getCapability(), "", "назначение не снято после операции");
    // Вложенность и сбой: следующая операция не должна видеть чужое назначение.
    env.setCapability("terminal.execute");
    await assert.rejects(
      env.withCapability("git.push", async () => {
        throw new Error("бум");
      }),
      /бум/,
      "сбой внутри операции проглочен"
    );
    assert.strictEqual(env.getCapability(), "terminal.execute", "после сбоя назначение потеряно");
    env.setCapability("");
  });

  await test("значения переменных уходят на вычистку из журнала действий", () => {
    const { env, seen } = makeEnv();
    env.applyAgentEnv({ agentEnv: { MY_KEY: "SECRET-VALUE" } });
    const last = seen.secrets[seen.secrets.length - 1] || [];
    assert.ok(last.indexOf("SECRET-VALUE") >= 0, "журнал не знает значение секрета: " + JSON.stringify(last));
    // Пересборка без сети (продление токена) тоже обязана обновить вычистку.
    const n = seen.secrets.length;
    env.rebuildAgentEnv();
    assert.strictEqual(seen.secrets.length, n + 1, "пересборка окружения не обновила журнал");
  });

  await test("автоматические YC-переменные не оседают в настройках", async () => {
    const { env } = makeEnv();
    await env.applyAgentEnv({ yc: cfg, agentEnv: { MY: "1" }, agentEnvScopes: {} });
    assert.deepStrictEqual(env.getUserAgentEnv(), { MY: "1" }, "в настройки попали автоматические переменные");
    const now = env.getAgentEnv();
    assert.strictEqual(now.YC_CLOUD_ID, "b1g", "каталог облака не доехал до команд");
    assert.strictEqual(now.YC_FOLDER_ID, "f1", "идентификатор каталога не доехал до команд");
    assert.strictEqual(now.MY, "1", "переменная человека потерялась");
    assert.ok(!("YC_TOKEN" in now) || now.YC_TOKEN === "IAM-TEST", "в YC_TOKEN попало не то значение");
    assert.deepStrictEqual(env.getScopes(), {}, "выдача не нормализована политикой");
  });

  await test("PATH встроенного yc CLI добавляется один раз", () => {
    const first = makeEnv({ ycDir: "/opt/yc", pathValue: "/usr/bin" });
    first.env.applyAgentEnv({});
    assert.deepStrictEqual(first.seen.merged, [["/usr/bin", "/opt/yc"]], "каталог yc CLI не добавлен в PATH");
    const again = makeEnv({ ycDir: "/opt/yc", pathValue: "/usr/bin" + path.delimiter + "/opt/yc" });
    again.env.applyAgentEnv({});
    assert.deepStrictEqual(again.seen.merged, [], "каталог уже в PATH, а добавляется второй раз");
    const none = makeEnv({ ycDir: "" });
    none.env.applyAgentEnv({});
    assert.deepStrictEqual(none.seen.merged, [], "PATH правится без каталога yc CLI");
  });

  await test("модуль берёт только внедрённое состояние и не тянет electron", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "agent-env.js"), "utf8");
    assert.ok(!/require\(/.test(src), "модуль сам что-то требует вместо внедрения");
    assert.ok(!/ipcMain|electron|safeStorage/.test(src), "модуль достаёт состояние у electron напрямую");
    for (const seam of ["live.getYcConfig()", "live.envPathInfo()", "live.setMergedPath(", "toolPolicy.envForCapability("]) {
      assert.ok(src.indexOf(seam) >= 0, "потеряна связка: " + seam);
    }
    // Конфигурация облака читается в момент вызова, а не копией при сборке:
    // служба облака создаётся ниже по файлу оболочки, и копия была бы пустой.
    assert.ok(
      src.indexOf("const ycConfig = (s) => live.getYcConfig()(s);") >= 0,
      "конфигурация облака перехвачена копией при сборке модуля"
    );
  });

  await test("выдача окружения уехала из оболочки, а состояние живёт в модуле", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    for (const gone of [
      "let agentEnv = {",
      "let userAgentEnv = {",
      "let agentEnvScopes = {",
      "let activeToolCapability",
      "function envFor(",
      "function commandEnv(",
      "function probeEnv(",
      "function pathOnlyEnv(",
      "function ycIamSync(",
      "function ycEnsurePath(",
      "function applyAgentEnv(",
      "function rebuildAgentEnv(",
    ]) {
      assert.strictEqual(mainSrc.indexOf(gone), -1, "в оболочке осталось: " + gone);
    }
    assert.ok(/const agentEnvState = createAgentEnv\(\{/.test(mainSrc), "оболочка не собирает модуль окружения");
    for (const wire of [
      "activeToolCapability: getCapability,",
      "scopeSummary: (name) => toolPolicy.scopeSummary(getScopes(), name),",
    ]) {
      assert.ok(mainSrc.indexOf(wire) >= 0, "мост живым значением потерян: " + wire);
    }
    // Мостов окружения ровно два (paths-git и agent-tools): считаем вхождения,
    // иначе подмена одного из них проходила бы — второе вхождение ещё на месте.
    const wires = mainSrc.split("agentEnv: getAgentEnv,").length - 1;
    assert.strictEqual(wires, 2, "мостов окружения не два: " + wires);
    assert.strictEqual(mainSrc.indexOf("agentEnv: () => agentEnv"), -1, "мост вернулся к копии состояния");
    // Мост пути отдаёт РЕЗУЛЬТАТ вызова системного раздела, а не саму функцию:
    // модуль зовёт её сам и читает у результата поле value. Ошибка здесь ломала PATH
    // команд агента (модуль видел undefined и заменял PATH одной папкой yc CLI —
    // команды падали с «rm: not found»). Поймал живой прогон раунда; теперь и здесь.
    assert.ok(/envPathInfo: \(\) => envPathInfo\(\),/.test(mainSrc), "мост пути отдаёт функцию вместо результата");
    assert.strictEqual(mainSrc.indexOf("envPathInfo: () => envPathInfo,"), -1, "мост вернулся к передаче самой функции");
    assert.ok(/setCapability\(toolPolicy\.capabilityOf\(name\)\)/.test(mainSrc), "инструмент в работе не объявляет назначение");
    assert.ok(/setCapability\(prevCapability\);/.test(mainSrc), "назначение не возвращается после инструмента");
    // Прямых обращений к перенесённому состоянию в оболочке быть не должно.
    assert.ok(!/\bagentEnv\b\s*=/.test(mainSrc), "оболочка пишет в перенесённое состояние");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

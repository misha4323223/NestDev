"use strict";

/* ─── Окружение агента и назначения инструментов ──────────────────────────────
   Вынесено из main.js (этап B, часть 22 — заход в раздел «Окружение агента»).

   Здесь живёт ОДНА точка правды о том, какая переменная окружения доедет до
   какой команды. Переменные пользователя (envSet/envList/envUnset) лежат в
   settings.json и подмешиваются во все команды агента — runCommand, фоновые
   процессы, shell, git, docker. Вместе с ними в окружение попадают
   автоматические переменные Yandex Cloud (YC_CLOUD_ID/YC_FOLDER_ID и свежий
   IAM-токен).

   Ошибки на этом шаге тихие и дорогие — именно поэтому кусок отделён:

     • **утечка секрета в команду-дамп** — «env», «printenv», «set» печатают всё
       окружение, и модель одной строкой выводит пароли пользователя в чат.
       Поэтому такие команды получают только ПУТИ (pathOnlyEnv), а не ключи;
     • **секрет уехал не тому инструменту** — назначения (agentEnvScopes)
       ограничивают выдачу: облачный токен не должен доставаться терминалу;
     • **значение секрета попало в журнал действий** — даже если команда честно
       его напечатала, audit.setSecrets вырезает значения по подстроке;
     • **назначение не сброшено после вызова** — следующий инструмент получил бы
       чужую выдачу, а «текущее назначение» живёт между вызовами;
     • **токен YC протух** — yc отвечает «The token is invalid»; IAM живёт ~час,
       поэтому держим снимок и продлеваем его в фоне за 5 минут до истечения.

   Живые значения приходят мостом `live`: ycConfig создаётся служебным слоем
   облака (src/yc-service.js) ниже по файлу оболочки, а envPathInfo/setMergedPath —
   системным разделом (src/system-stack.js). Оба читаются в момент вызова, а не
   при сборке модуля: копия «застыла» бы на пустом значении. */

function createAgentEnv(deps) {
  const { toolPolicy, audit, app, path, yandexCloud, ycCli, live } = deps;

  // ycConfig живёт в служебном слое облака (src/yc-service.js) и создаётся ниже по
  // файлу оболочки — читаем его в момент вызова, иначе получили бы undefined.
  const ycConfig = (s) => live.getYcConfig()(s);
  const envPathInfo = () => live.envPathInfo();
  const setMergedPath = (before, extra) => live.setMergedPath(before, extra);

  // Переменные окружения агента (envSet/envList/envUnset). Значения хранятся в settings.json
  // (settings.agentEnv) и подмешиваются во все команды: runCommand, фоновые процессы, shell, git, docker.
  let agentEnv = {}; // итоговый набор: пользовательский + автоматический (Yandex Cloud)
  let userAgentEnv = {}; // только то, что задал пользователь — это и сохраняется в настройках
  // Кому какая переменная выдана: { ИМЯ: ["terminal", "git"] } (settings.agentEnvScopes).
  // Пусто для переменной — как раньше: доходит до всех команд агента. Заполнено —
  // только до названных инструментов и групп (см. tool-policy.js).
  let agentEnvScopes = {};
  // Инструмент, который выполняется СЕЙЧАС (его capability). Команды внутри одного
  // вызова получают выданное этому инструменту; действие без инструмента (кнопка
  // «Запустить», авто-коммит, сборка бандла) назначения не имеет и объявляет его само.
  let activeToolCapability = "";
  function activeCapability() {
    return activeToolCapability;
  }

  // Живое чтение состояния наружу (мост в оболочку и модули): копия «застыла» бы
  // на пустом объекте, и команды остались бы без токенов и PATH.
  function getAgentEnv() {
    return agentEnv;
  }
  function getUserAgentEnv() {
    return userAgentEnv;
  }
  function getScopes() {
    return agentEnvScopes;
  }
  function getCapability() {
    return activeToolCapability;
  }
  // Назначение на время вызова инструмента ставит и снимает сама оболочка
  // (executeTool), поэтому пара «прочитать/поставить» нужна наружу.
  function setCapability(capability) {
    activeToolCapability = capability;
  }

  // Выполнить операцию под названным назначением. Нужно действиям НЕ от инструмента:
  // кнопка «Загрузить» в панели git, «Опубликовать на GitHub». Внутри вложенных вызовов
  // это назначение видят все помощники — runGit, commandEnv, spawnRaw.
  async function withCapability(capability, fn) {
    const prev = activeToolCapability;
    activeToolCapability = capability;
    try {
      return await fn();
    } finally {
      activeToolCapability = prev;
    }
  }

  // Автоматические переменные Yandex Cloud для команд агента. yc CLI читает их прямо
  // из окружения, поэтому подключённый аккаунт работает без интерактивного `yc init`.
  // ВАЖНО: YC_TOKEN и YC_IAM_TOKEN должны содержать IAM-токен — OAuth там не
  // принимается (yc отвечает «The token is invalid»). IAM живёт ~1 час, поэтому
  // держим свежий снимок (ycIamEnv) и продлеваем его в фоне до истечения.
  // В чат значения не выводятся: envList показывает только имя и длину.
  let ycIamEnv = null; // { token, expiresAtMs, forOauth }
  let ycIamTimer = null;
  let ycIamTimerAt = 0;
  let ycIamLastTryTs = 0;
  let lastAgentEnvSettings = null;
  const YC_IAM_REFRESH_MARGIN = 5 * 60 * 1000;

  function ycIamEnvToken(cfg) {
    if (!ycIamEnv || !cfg || !cfg.oauth || ycIamEnv.forOauth !== cfg.oauth) return "";
    if (Date.now() >= ycIamEnv.expiresAtMs - 60 * 1000) return "";
    return ycIamEnv.token;
  }

  function ycAutoEnv(s) {
    const out = {};
    try {
      const cfg = ycConfig(s);
      if (cfg.cloudId) out.YC_CLOUD_ID = cfg.cloudId;
      if (cfg.folderId) out.YC_FOLDER_ID = cfg.folderId;
      const iam = ycIamEnvToken(cfg);
      if (iam) {
        out.YC_IAM_TOKEN = iam;
        out.YC_TOKEN = iam;
      }
    } catch {}
    return out;
  }

  // Пересобрать окружение без сети (зовётся и по таймеру продления токена).
  function rebuildAgentEnv() {
    agentEnv = { ...userAgentEnv, ...ycAutoEnv(lastAgentEnvSettings) };
    // Значения переменных агента не должны попадать в журнал действий — даже если
    // команда честно их напечатала (printenv MY_KEY): журнал вырезает эти значения
    // по подстроке из любой своей строки.
    audit.setSecrets(Object.values(agentEnv));
  }

  // Ключи окружения, которые можно отдавать даже «слепым» процессам: это пути,
  // а не секреты. Всё остальное (ключи, пароли, токены) — только по назначению.
  function pathOnlyEnv() {
    const safe = {};
    for (const k of Object.keys(agentEnv)) {
      if (/^(path|pathext|comspec|systemroot|temp|tmp)$/i.test(k)) safe[k] = agentEnv[k];
    }
    return safe;
  }

  // Окружение для названного назначения: инструмент получает ТОЛЬКО те переменные
  // агента, которые ему выданы (или все неограниченные — как раньше). Назначения:
  // capability инструмента в работе, а для действий без инструмента — явное имя
  // (кнопка «Запустить» → terminal.execute, авто-коммит → git.commit).
  function envFor(capability) {
    const cap = capability || activeToolCapability;
    return { ...process.env, ...toolPolicy.envForCapability(agentEnv, agentEnvScopes, cap) };
  }

  // Окружение для команды, которую СОЧИНИЛ агент (runCommand, фоновые процессы, shell).
  // Обычные команды (npm, docker, yc, git) получают выданные переменные агента, но
  // команда, которая просто печатает всё окружение (env, printenv, set, Get-ChildItem Env:),
  // секретов не получает — иначе модель одной строкой выводит пароли пользователя в чат.
  function commandEnv(command, capability) {
    const base = { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0" };
    if (toolPolicy.commandDumpsEnv(command)) return { ...base, ...pathOnlyEnv() };
    // Инструмент в работе важнее: команда внутри cloud-инструмента получает выданное
    // облаку, а не терминалу. «terminal.execute» объявляется только тогда, когда
    // инструмента нет вовсе (терминал пользователя, кнопка запуска превью).
    return { ...base, ...envFor(capability || activeToolCapability || "terminal.execute") };
  }

  // Служебные пробы (поиск программы в PATH, проверка версии) секретов не требуют.
  function probeEnv() {
    return { ...process.env, ...pathOnlyEnv() };
  }

  // Фоновая синхронизация IAM-токена: обмен OAuth→IAM и продление за 5 минут до
  // истечения. Не бросает и не ждёт: команды агента никогда не стоят из-за токена.
  // Повторы ограничены (не чаще раза в минуту), иначе каждая команда дёргала бы IAM.
  function ycIamSync(s) {
    try {
      const cfg = ycConfig(s);
      if (!cfg.oauth) {
        if (ycIamTimer) {
          clearTimeout(ycIamTimer);
          ycIamTimer = null;
          ycIamTimerAt = 0;
        }
        if (ycIamEnv) {
          ycIamEnv = null;
          rebuildAgentEnv();
        }
        return;
      }
      if (ycIamEnv && ycIamEnv.forOauth === cfg.oauth && Date.now() < ycIamEnv.expiresAtMs - YC_IAM_REFRESH_MARGIN) {
        const at = ycIamEnv.expiresAtMs - YC_IAM_REFRESH_MARGIN;
        if (ycIamTimerAt !== at) {
          if (ycIamTimer) clearTimeout(ycIamTimer);
          ycIamTimerAt = at;
          ycIamTimer = setTimeout(() => {
            ycIamTimer = null;
            ycIamTimerAt = 0;
            ycIamSync(lastAgentEnvSettings);
          }, Math.max(30 * 1000, at - Date.now()));
          if (ycIamTimer.unref) ycIamTimer.unref();
        }
        return;
      }
      if (ycIamEnv && ycIamEnv.forOauth !== cfg.oauth) {
        ycIamEnv = null;
        rebuildAgentEnv();
      }
      if (Date.now() - ycIamLastTryTs < 60 * 1000) return;
      ycIamLastTryTs = Date.now();
      yandexCloud
        .getIamTokenInfo(cfg.oauth)
        .then((info) => {
          ycIamEnv = { token: info.token, expiresAtMs: info.expiresAtMs || Date.now() + 3600 * 1000, forOauth: cfg.oauth };
          rebuildAgentEnv();
          ycIamSync(lastAgentEnvSettings);
        })
        .catch(() => {
          /* нет сети или токен не принят — команды отработают без YC_*, без падения */
        });
    } catch {}
  }

  // Папка со встроенным yc CLI — в PATH всех команд агента (как node).
  function ycEnsurePath() {
    try {
      const dir = ycCli.binDir(app.getPath("userData"));
      if (!dir) return;
      const before = envPathInfo().value;
      if (!String(before || "").split(path.delimiter).map((x) => x.trim()).includes(dir)) setMergedPath(before, dir);
    } catch {}
  }

  // Пересобрать окружение агента: пользовательские переменные + автоматические YC.
  function applyAgentEnv(s) {
    userAgentEnv = (s && typeof s.agentEnv === "object" && s.agentEnv) || {};
    agentEnvScopes = toolPolicy.normalizeScopes(s && s.agentEnvScopes);
    lastAgentEnvSettings = s || lastAgentEnvSettings;
    rebuildAgentEnv();
    ycEnsurePath();
    // Фоновая подстановка свежего IAM в YC_IAM_TOKEN/YC_TOKEN (без await).
    ycIamSync(lastAgentEnvSettings);
  }

  return {
    activeCapability,
    withCapability,
    getAgentEnv,
    getUserAgentEnv,
    getScopes,
    getCapability,
    setCapability,
    pathOnlyEnv,
    envFor,
    commandEnv,
    probeEnv,
    ycIamEnvToken,
    ycAutoEnv,
    rebuildAgentEnv,
    ycIamSync,
    ycEnsurePath,
    applyAgentEnv,
  };
}

module.exports = { createAgentEnv };

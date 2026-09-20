"use strict";

/* ─── Секреты в настройках: кому значение, а кому заглушка ────────────────────
   Зачем отдельный модуль. Канал settings:get отдавал настройки целиком — вместе
   с ключами (openaiApiKey, anthropicApiKey, visionKey, serperApiKey), токенами
   (githubToken, yandexOauthToken), паролем почты, PIN мобильного доступа,
   переменными агента (agentEnv), паролями сайтов и ключами внутри
   openaiProfiles. Раньше это было незаметно: единственным клиентом считалось
   окно на ПК. Теперь клиентов два: окно (ему ключи действительно нужны — оно
   само ходит к провайдеру за окном контекста) и телефон, который подключается
   по LAN и открытому ws://. Телефону значения не нужны: прогон агента и
   запросы к провайдеру делает главный процесс, а интерфейсу хватает того, что
   поле заполнено.

   Что здесь есть:
     • maskSecrets(settings) — копия настроек, где значения секретов заменены
       заглушкой. Пустые значения остаются пустыми: иначе интерфейс врал бы,
       будто секрет задан;
     • restoreMasked(incoming, prev) — обратная операция для сохранения: если
       клиент прислал заглушку, значит он её не трогал, и правильное значение —
       прежнее. Без этого телефон, сохранив любой другой параметр, записал бы в
       настройки строку из точек и стёр бы настоящий ключ.

   Заглушка выглядит как точки и потому видна человеку как «поле не показано».
   Секрет по ней не восстановить: у неё нет ни длины, ни намёка на содержимое. */

const secrets = require("./secrets.js");

// Заглушка вместо значения. Одна и та же строка для всех секретов: по ней
// понимают и restoreMasked, и человек в интерфейсе.
const MASK = "••••••••";

// Строковые секреты и их место в объекте openaiProfiles/sitePasswords.
const STRING_KEYS = secrets.SECRET_KEYS.filter((k) => secrets.OBJECT_KEYS.indexOf(k) < 0);

function isMask(v) {
  return v === MASK;
}

// Значение в настройках есть? Пустая строка, пустой объект и пустой массив —
// это «не задано», их маскировать не нужно (интерфейс должен показывать пусто).
function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function maskValue(v) {
  return hasValue(v) ? MASK : v;
}

/* Копия настроек для недоверенного клиента (телефон): секретов в ней нет.
   Остальные поля — как есть: интерфейсу нужны адреса, модели, галочки, список дел
   и проектов, иначе он не нарисует ни одну панель. */
function maskSecrets(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  for (const k of STRING_KEYS) {
    if (k in out) out[k] = maskValue(out[k]);
  }
  // Переменные агента: ключи остаются (по ним интерфейс показывает таблицу и
  // правила выдачи), значения — заглушка.
  if (out.agentEnv && typeof out.agentEnv === "object" && !Array.isArray(out.agentEnv)) {
    const env = {};
    for (const k of Object.keys(out.agentEnv)) env[k] = maskValue(out.agentEnv[k]);
    out.agentEnv = env;
  }
  // Менеджер паролей: имя сайта, адрес и логин нужны для списка, сам пароль — нет
  // (интерфейс и так не подставляет его в форму: поле пароля всегда пустое).
  if (Array.isArray(out.sitePasswords)) {
    out.sitePasswords = out.sitePasswords.map((e) =>
      e && typeof e === "object" ? { ...e, password: maskValue(e.password) } : e
    );
  }
  // Сохранённые подключения OpenAI: ключ внутри каждого профиля.
  if (Array.isArray(out.openaiProfiles)) {
    out.openaiProfiles = out.openaiProfiles.map((p) =>
      p && typeof p === "object" ? { ...p, apiKey: maskValue(p.apiKey) } : p
    );
  }
  return out;
}

/* Обратная операция к maskSecrets, но по ПРЕЖНИМ настройкам (они в главном
   процессе настоящие). Возвращает объект для сохранения: заглушки заменены
   прежними значениями, всё остальное — как прислал клиент.

   Если заглушка пришла на поле, которого раньше не было, поле убирается совсем:
   так «сохранить» не превращает пустое значение в строку из точек. */
function restoreMasked(incoming, prev) {
  if (!incoming || typeof incoming !== "object") return incoming;
  const before = prev && typeof prev === "object" ? prev : {};
  const out = { ...incoming };

  for (const k of STRING_KEYS) {
    if (!isMask(out[k])) continue;
    if (hasValue(before[k])) out[k] = before[k];
    else delete out[k];
  }

  if (out.agentEnv && typeof out.agentEnv === "object" && !Array.isArray(out.agentEnv)) {
    const was = before.agentEnv && typeof before.agentEnv === "object" ? before.agentEnv : {};
    const env = {};
    for (const k of Object.keys(out.agentEnv)) {
      if (!isMask(out.agentEnv[k])) {
        env[k] = out.agentEnv[k];
        continue;
      }
      if (hasValue(was[k])) env[k] = was[k]; // заглушка: значение не трогали
      // а если прежнего значения нет — переменную просто не сохраняем
    }
    out.agentEnv = env;
  }

  if (Array.isArray(out.sitePasswords)) {
    const was = Array.isArray(before.sitePasswords) ? before.sitePasswords : [];
    out.sitePasswords = out.sitePasswords.map((e) => {
      if (!e || typeof e !== "object" || !isMask(e.password)) return e;
      // Ищем прежнюю запись ТОЛЬКО по непустому id: у записи без id (испорченный
      // файл настроек) поиск по undefined совпал бы с первой же чужой записью.
      const old = e.id ? was.find((x) => x && x.id === e.id) : null;
      return { ...e, password: old && old.password ? old.password : "" };
    });
  }

  if (Array.isArray(out.openaiProfiles)) {
    const was = Array.isArray(before.openaiProfiles) ? before.openaiProfiles : [];
    out.openaiProfiles = out.openaiProfiles.map((p) => {
      if (!p || typeof p !== "object" || !isMask(p.apiKey)) return p;
      const old = p.id ? was.find((x) => x && x.id === p.id) : null;
      return { ...p, apiKey: old && old.apiKey ? old.apiKey : "" };
    });
  }

  return out;
}

module.exports = {
  MASK,
  STRING_KEYS,
  isMask,
  hasValue,
  maskSecrets,
  restoreMasked,
};

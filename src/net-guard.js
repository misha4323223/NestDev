"use strict";

/* ─── Куда главному процессу можно ходить ─────────────────────────────────────
   Зачем отдельный модуль. Четыре канала (ai:test, ai:models, ai:probeLocal,
   g4f:probe, g4f:test) принимают адрес провайдера ОТ ИНТЕРФЕЙСА и делают запрос
   ИЗ ГЛАВНОГО ПРОЦЕССА. Так и задумано: в главном процессе нет CORS и видно
   сырые статусы. Но адрес приходит от клиента, а ответ возвращается ему же —
   значит, любой, кто может звать канал, получает «глаза» главного процесса
   внутри сети машины. Это SSRF: достаточно было попросить
   http://169.254.169.254/latest/meta-data/… (облачные метаданные) и прочитать
   ответ, который окну не предназначен.

   Здесь одна точка правды о том, какие адреса допустимы. Правила узкие —
   ровно те, которые закрывают дыру и не мешают живой работе:

     • схема только http/https. `file:`, `ftp:`, `data:` и прочее отсекаются;
     • никаких учётных данных в адресе (user:pass@host): они попали бы в логи и
       в сообщения об ошибках;
     • запрещены link-local и облачные метаданные: 169.254.0.0/16 (там живут
       метаданные AWS/Azure/Yandex), fe80::/10, ::ffff:169.254.x.x, а также
       имена metadata, metadata.google.internal, instance-data. Числовые формы
       адреса (2852039166, 0xA9FEA9FE, 0251.0376.0251.0376) разбираются вручную:
       иначе проверка обходится одним числом вместо точек;
     • localhost и LAN ОСТАЮТСЯ разрешёнными. Там живут Ollama, G4F, LM Studio —
       это законные адреса провайдеров, и запрещать их значило бы сломать
       локальные модели ради красоты правила.

   Проверка НЕ подменяет политику инструментов и не мешает агенту: она стоит
   только на каналах, где адрес называет интерфейс. */

// Имена, за которыми в облаках стоят метаданные экземпляра (SSRF-цель №1).
const BLOCKED_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "metadata.azure.com",
  "metadata.azure",
]);

// Поля настроек, из которых провайдер берёт адрес. Проверяются ВСЕ присутствующие:
// какой именно возьмёт fetchModels, зависит от провайдера, и знать это здесь не нужно.
const URL_FIELDS = ["openaiUrl", "ollamaUrl", "anthropicUrl", "visionUrl"];

function isBlockedIpv4(ip) {
  const p = String(ip).split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 169 && p[1] === 254) return true; // link-local: метаданные AWS/Azure/Yandex
  if (p[0] === 0) return true; // 0.0.0.0/8 — «этот хост», в Windows ведёт на localhost
  if (p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255) return true; // широковещательный
  return false;
}

/* Числовая форма IPv4. Браузеры и Node разбирают `http://2852039166/` как
   169.254.169.254, а наша проверка по строке — нет. Поэтому каждую часть адреса
   разбираем в своей системе счисления (0x — шестнадцатеричная, 0 — восьмеричная),
   как это делает сам разборщик: иначе защиту обходят одной цифрой. */
function ipv4FromNumeric(host) {
  const text = String(host || "").trim().replace(/\.$/, ""); // хвостовая точка — тот же адрес
  if (!text) return "";
  let parts;
  if (/^\d+$/.test(text)) parts = [text];
  else if (/^0x[0-9a-f]+$/i.test(text)) parts = [text];
  else if (/^[0-9a-fx.]+$/i.test(text)) parts = text.split(".");
  else return "";
  if (parts.length > 4) return "";
  const nums = [];
  for (const raw of parts) {
    const part = String(raw).trim();
    let n;
    if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) n = parseInt(part, 10);
    else return "";
    if (!Number.isFinite(n) || n < 0) return "";
    nums.push(n);
  }
  // Недостающие части добираются нулями: 169.254 → 169.254.0.0, 2852039166 → целиком.
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return "";
    const n = nums[0];
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  while (nums.length < 4) nums.push(0);
  if (nums.some((n) => n > 255)) return "";
  return nums.join(".");
}

/* ::ffff:169.254.169.254 — тот же link-local, только в IPv6-обёртке. Разборщик
   адресов приводит такую запись к ШЕСТНАДЦАТЕРИЧНОМУ виду (::ffff:a9fe:a9fe),
   поэтому разбираем обе формы: и точки, и две группы по два байта. Проверка,
   которая знает только про точки, пропускает обход в одну запись. */
function ipv4FromMappedIpv6(h) {
  const m = String(h || "").match(/^::ffff:(.+)$/);
  if (!m) return "";
  const rest = m[1];
  if (rest.includes(".")) return ipv4FromNumeric(rest);
  const words = rest.split(":");
  if (words.length !== 2) return "";
  const hi = parseInt(words[0], 16);
  const lo = parseInt(words[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) return "";
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
}

function isBlockedIpv6(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(":")) return false;
  if (h === "::") return true; // неопределённый адрес
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 — link-local
  const v4 = ipv4FromMappedIpv6(h);
  return !!v4 && isBlockedIpv4(v4);
}

function isBlockedHost(host) {
  const raw = String(host || "").trim();
  const h = raw.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!h) return true; // пустой хост — не адрес вовсе
  if (BLOCKED_HOSTS.has(h)) return true;
  if (isBlockedIpv6(raw)) return true;
  const v4 = ipv4FromNumeric(h);
  return !!v4 && isBlockedIpv4(v4);
}

/* Единственная проверка адреса: её зовут каналы перед запросом.
   Возвращает { ok: true, url } или { ok: false, error } — текст для человека. */
function checkUrl(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { ok: false, error: "Адрес не указан." };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "Не разобрать адрес: " + text.slice(0, 120) };
  }
  const proto = u.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    return { ok: false, error: "Разрешены только адреса http и https, а не " + proto };
  }
  if (u.username || u.password) {
    return { ok: false, error: "В адресе не должно быть логина и пароля — убери их из URL." };
  }
  if (!u.hostname) return { ok: false, error: "В адресе не указан хост: " + text.slice(0, 120) };
  if (isBlockedHost(u.hostname)) {
    return {
      ok: false,
      error:
        "Адрес ведёт на служебный узел (" + u.hostname + "): туда ходят за метаданными облака, " +
        "а не за моделями. Укажи адрес своего провайдера.",
    };
  }
  return { ok: true, url: u.toString() };
}

/* Проверка всех адресов, которые могут стать целью запроса. Каналы собирают
   настройки как `{ ...loadSettings(), ...(ui || {}) }` — то есть поле может
   прийти из интерфейса и подменить адрес. Проверяем каждое присутствующее поле,
   чтобы не зависеть от того, какое выберет провайдер. */
function checkSettingsUrls(s) {
  for (const field of URL_FIELDS) {
    const v = s ? s[field] : "";
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const r = checkUrl(v);
    if (!r.ok) return { ok: false, error: r.error + " (поле " + field + ")" };
  }
  return { ok: true };
}

module.exports = {
  checkUrl,
  checkSettingsUrls,
  isBlockedHost,
  isBlockedIpv4,
  isBlockedIpv6,
  ipv4FromNumeric,
  ipv4FromMappedIpv6,
  URL_FIELDS,
  BLOCKED_HOSTS,
};

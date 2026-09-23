"use strict";

/* ─── Почта: настройка подключения и каналы интерфейса ────────────────────────
   Сам протокол (SMTP для отправки, IMAP для чтения, разбор MIME, коды
   подтверждения) живёт в src/mail.js — чистый модуль на встроенных модулях Node,
   без внешних зависимостей. Здесь — то, что раньше было размазано по main.js:
   сборка рабочей конфигурации из настроек и три канала для интерфейса.

   Почему конфигурация собирается здесь, а не в интерфейсе: пресеты провайдеров
   (Gmail, Яндекс, Mail.ru, Outlook, Rambler) знают порты и режим шифрования —
   интерфейс не должен угадывать их сам. Пустые поля настроек заполняются из
   пресета, заполненные пользователем — не трогаются.

   Письма НЕ отправляются без явного разрешения (mailAllowAgentSend): каналы
   отвечают за проверку связи и чтение, отправка — по решению агента и человека. */

function registerMailIpc(deps) {
  const { ipcMain, mail, loadSettings } = deps;

// Почта: собирает рабочую конфигурацию из настроек. Пустые серверы берутся из
// пресета провайдера (Gmail/Яндекс/Mail.ru/Outlook/Rambler), иначе — imap.<домен>.
function mailConfig(s) {
  s = s || loadSettings();
  const address = String(s.mailAddress || "").trim();
  const guess = mail.guessServers(address);
  const num = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    address,
    user: String(s.mailUser || "").trim() || address,
    fromName: String(s.mailFromName || "").trim(),
    password: String(s.mailPassword || ""),
    imapHost: String(s.mailImapHost || "").trim() || guess.imapHost,
    imapPort: num(s.mailImapPort, guess.imapPort || 993),
    smtpHost: String(s.mailSmtpHost || "").trim() || guess.smtpHost,
    smtpPort: num(s.mailSmtpPort, guess.smtpPort || 465),
    starttls: s.mailStarttls === true || guess.starttls === true,
    allowSend: !!s.mailAllowAgentSend,
    note: guess.note || "",
  };
}

// ─────────────────────────── Почта (SMTP/IMAP) ───────────────────────────
// Проверка входа IMAP — кнопка «Проверить связь» в настройках. Письма не отправляются.
ipcMain.handle("mail:test", async () => {
  const cfg = mailConfig(loadSettings());
  const servers = {
    imapHost: cfg.imapHost, imapPort: cfg.imapPort,
    smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort,
    starttls: cfg.starttls, note: cfg.note,
  };
  if (!cfg.address) return { ok: false, error: "Укажи адрес почты.", servers };
  if (!cfg.password) return { ok: false, error: "Укажи пароль приложения для почты.", servers };
  const r = await mail.listRecent(
    { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
    { limit: 1 }
  );
  return { ok: r.ok, error: r.ok ? "" : r.error, total: r.ok ? r.total : 0, servers };
});

// Последние письма для интерфейса (кратко: без полного текста, но с найденным кодом).
ipcMain.handle("mail:recent", async (_e, limit) => {
  const cfg = mailConfig(loadSettings());
  if (!cfg.address || !cfg.password) return { ok: false, error: "Почта не настроена." };
  const r = await mail.listRecent(
    { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
    { limit: Math.min(parseInt(limit, 10) || 5, 10) }
  );
  if (!r.ok) return r;
  return {
    ok: true,
    total: r.total,
    messages: r.messages.map((m) => ({ from: m.from, subject: m.subject, date: m.date, code: mail.extractCode(m.text) })),
  };
});

// Тестовое письмо самому себе — проверяет SMTP-отправку целиком.
ipcMain.handle("mail:testSend", async () => {
  const cfg = mailConfig(loadSettings());
  if (!cfg.address) return { ok: false, error: "Укажи адрес почты." };
  if (!cfg.password) return { ok: false, error: "Укажи пароль приложения для почты." };
  const r = await mail.sendMail(
    { host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.user, password: cfg.password, secure: !cfg.starttls, starttls: cfg.starttls },
    {
      fromName: cfg.fromName,
      to: cfg.address,
      subject: "Проверка почты от AI-агента",
      text: "Это тестовое письмо. Если ты его видишь — отправка писем настроена верно.\n\n— NestDev",
    }
  );
  return r;
});

  // Возвращаем конфигурацию: она нужна агентским инструментам почты в main.js.
  return { mailConfig };
}

module.exports = { registerMailIpc };

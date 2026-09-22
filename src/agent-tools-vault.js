"use strict";

/* ─── Агентские инструменты: пароли сайтов и почта ────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 11). Пять обработчиков:

     • vaultList — что лежит в хранилище паролей (по ИМЕНАМ сайтов, без значений);
     • vaultFill — подставить логин и пароль в открытую страницу (браузеру
       передаётся сам браузерный набор: заполнение идёт через browserTools);
     • mailSend — отправить письмо от имени пользователя (только с его разрешения:
       Настройки → «✉️ Почта» → «Разрешить агенту отправлять письма»);
     • mailList — прочитать последние входящие с кодом подтверждения;
     • mailCode — вытащить код подтверждения из свежих писем.

   Настройки почты читаются В МОМЕНТ ВЫЗОВА (loadSettings) и через mailConfig:
   пользователь может поменять их между вызовами. Живого моста не нужно —
   всё, что обработчикам нужно, приходит в deps.
   Тела перенесены ПОБАЙТОВО, порядок инструментов в реестре сохранён ссылками. */

function createVaultTools(deps) {
  const {
    vault,
    mail,
    mailConfig,
    browserTools,
    loadSettings,
  } = deps;

  return {
    "vaultList": async (args, settings) => {
        return vault.listText(loadSettings().sitePasswords);
    },
    "vaultFill": async (args, settings) => {
        const site = args.site || args.name || args.url || "";
        const entry = vault.findEntry(loadSettings().sitePasswords, site);
        if (!entry) return vault.notFoundText(loadSettings().sitePasswords, site);
        return await vault.fillLogin(entry, args, browserTools);
    },
    "mailSend": async (args, settings) => {
        const cfg = mailConfig(loadSettings());
        if (!cfg.allowSend) {
          return "⛔ Отправка писем агентом ЗАПРЕЩЕНА. Скажи пользователю включить Настройки → «✉️ Почта» → чекбокс «Разрешить агенту отправлять письма».";
        }
        if (!cfg.address || !cfg.password || !cfg.smtpHost) {
          return "Почта не настроена. Скажи пользователю: Настройки → «✉️ Почта» → адрес, пароль приложения, затем кнопка «Определить по адресу».";
        }
        const r = await mail.sendMail(
          { host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.user, password: cfg.password, secure: !cfg.starttls, starttls: cfg.starttls },
          { fromName: cfg.fromName, to: args.to || args.recipient, subject: args.subject, text: args.text, html: args.html }
        );
        if (!r.ok) return "Ошибка отправки: " + r.error;
        return "OK — письмо отправлено: " + (Array.isArray(r.to) ? r.to.join(", ") : r.to) + ". Тема: " + String(args.subject || "").slice(0, 120);
    },
    "mailList": async (args, settings) => {
        const cfg = mailConfig(loadSettings());
        if (!cfg.address || !cfg.password || !cfg.imapHost) return "Почта не настроена — Настройки → «✉️ Почта».";
        const r = await mail.listRecent(
          { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
          { limit: args.limit, unseenOnly: args.unseenOnly === true }
        );
        if (!r.ok) return "Ошибка чтения почты: " + r.error;
        if (!r.messages.length) return "Входящих писем нет (ящик пуст).";
        const rows = r.messages.map((m) => {
          const code = mail.extractCode(m.text);
          const preview = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
          return "• " + m.from + "\n  Тема: " + m.subject + "\n  Дата: " + m.date + (code ? "\n  Код: " + code : "") + "\n  " + preview;
        });
        return "Последние письма (" + r.messages.length + " из " + r.total + "):\n\n" + rows.join("\n\n") + "\n\nОтправить письмо: mailSend(to, subject, text).";
    },
    "mailCode": async (args, settings) => {
        const cfg = mailConfig(loadSettings());
        if (!cfg.address || !cfg.password || !cfg.imapHost) return "Почта не настроена — Настройки → «✉️ Почта».";
        const r = await mail.listRecent(
          { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
          { limit: Math.min(parseInt(args.limit, 10) || 5, 10) }
        );
        if (!r.ok) return "Ошибка чтения почты: " + r.error;
        const want = String(args.from || args.query || "").trim().toLowerCase();
        const list = want ? r.messages.filter((m) => (m.from + " " + m.subject).toLowerCase().includes(want)) : r.messages;
        for (const m of list) {
          const code = mail.extractCode(m.text);
          if (code) return "Код подтверждения: " + code + "\nИз письма: " + m.subject + " (" + m.from + ", " + m.date + ")";
        }
        return "Код подтверждения не найден в последних " + r.messages.length + " письмах" + (want ? " от «" + want + "»" : "") + ". Вызови mailList — возможно, письмо ещё не пришло.";
    },
  };
}

module.exports = { createVaultTools };

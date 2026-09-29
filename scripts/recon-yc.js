"use strict";
/* ── Разведка Yandex Cloud: что API ОТВЕЧАЕТ на самом деле ─────────────────────
   Запуск: npm run recon:yc            (нужен YC_OAUTH_TOKEN)
           YC_FOLDER_ID=b1g… npm run recon:yc

   Зачем отдельный скрипт. Половина плана работ (виртуальные машины, метрики,
   биллинг, функции, сертификаты) стоит на методах, которых в живом облаке мы
   ещё НЕ видели. Этот проект уже дважды ловил себя на «похоже, так»: у Cloud
   Logging чтение записей живёт только в gRPC (REST-метода нет вовсе), а
   Postbox — это SES-совместимый API с другим хостом и другим заголовком
   авторизации. Поэтому сначала — замер, потом код, а не наоборот.

   Что делает: спрашивает каталог эндпоинтов облака, стучится в интересующие
   сервисы СПИСКОВЫМИ (только чтение) методами и печатает ответ: код, заголовок
   и первые строки тела. Ничего не создаёт, не меняет и не удаляет — в скрипте
   нет ни одного POST, кроме обмена OAuth → IAM, и ни одного DELETE.

   Что читать в выводе:
     • 200 — метод есть, форма ответа видна в теле;
     • 404 — метода по этому пути нет (путь угадан неверно, надо искать другой);
     • 403 — метод есть, но у токена нет прав (например, биллинг требует
       роли billing.viewer, а Compute — compute.viewer);
     • 401 — токен не подошёл.

   Ничего не печатает из секретов: в отчёте нет ни токена, ни его частей. */

const path = require("path");

const yc = require(path.join(__dirname, "..", "src", "yandex-cloud.js"));

const OAUTH = String(process.env.YC_OAUTH_TOKEN || "").trim();
const FOLDER = String(process.env.YC_FOLDER_ID || "").trim();

// Сервисы, чьи адреса нас интересуют: id из каталога эндпоинтов облака.
const SERVICES = [
  "vpc",
  "compute",
  "iam",
  "resource-manager",
  "serverless-functions",
  "serverless-triggers",
  "certificate-manager",
  "cdn",
  "monitoring",
  "billing",
  "storage",
];

// Списковые методы (только чтение). Путь проверяем, а не считаем истинным:
// именно для этого скрипт и написан.
const PROBES = [
  { svc: "vpc", path: "/vpc/v1/subnets" },
  { svc: "vpc", path: "/vpc/v1/securityGroups" },
  { svc: "vpc", path: "/vpc/v1/addresses" },
  { svc: "compute", path: "/compute/v1/instances" },
  { svc: "compute", path: "/compute/v1/disks" },
  { svc: "compute", path: "/compute/v1/snapshots" },
  { svc: "compute", path: "/compute/v1/images" },
  { svc: "serverless-functions", path: "/functions/v1/functions" },
  { svc: "serverless-triggers", path: "/serverless-triggers/v1/triggers" },
  { svc: "certificate-manager", path: "/certificate-manager/v1/certificates" },
  { svc: "cdn", path: "/cdn/v1/resources" },
  { svc: "iam", path: "/iam/v1/serviceAccounts" },
  // Билдинг-аккаунт ищется по своему каталогу — без folderId: он привязан к
  // платёжному аккаунту, а не к каталогу ресурсов.
  { svc: "billing", path: "/billing/v1/billingAccounts", noFolder: true },
];

function head(text, n) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > (n || 260) ? s.slice(0, n || 260) + "…" : s;
}

async function tryJson(url, opts) {
  try {
    const text = await new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}))
        .then((res) =>
          res.text().then((t) => {
            clearTimeout(timer);
            resolve({ status: res.status, text: t });
          })
        )
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
    return text;
  } catch (e) {
    return { status: 0, text: "запрос не прошёл: " + ((e && e.message) || String(e)) };
  }
}

(async () => {
  console.log("Разведка Yandex Cloud (только чтение)\n");
  if (!OAUTH) {
    console.log("Нужен OAuth-токен Yandex. Возьми его в Настройках приложения (Настройки → «☁️ Yandex Cloud»,");
    console.log("кнопка «Получить токен») или у yc CLI. Затем:");
    console.log("  YC_OAUTH_TOKEN=y0_Ag… npm run recon:yc");
    console.log("Каталог можно задать через YC_FOLDER_ID, иначе возьмём первый доступный.");
    process.exit(1);
  }

  let iam = "";
  try {
    iam = await yc.getIamToken(OAUTH);
    console.log("1) OAuth → IAM: обмен прошёл (токен в отчёте не печатается).");
  } catch (e) {
    console.log("1) OAuth → IAM: ОТКАЗ — " + ((e && e.message) || String(e)));
    console.log("   Проверь токен: он должен быть свежим и от того же аккаунта, что в приложении.");
    process.exit(1);
  }

  let folder = FOLDER;
  if (!folder) {
    try {
      const clouds = await yc.listClouds(OAUTH);
      const folders = await yc.listFolders(OAUTH, (clouds[0] && clouds[0].id) || "");
      folder = (folders[0] && folders[0].id) || "";
      console.log("2) Каталог не задан — беру первый доступный: " + (folder || "(нет)"));
    } catch (e) {
      console.log("2) Каталог получить не удалось: " + ((e && e.message) || String(e)));
    }
  } else {
    console.log("2) Каталог из YC_FOLDER_ID: " + folder);
  }

  console.log("\n3) Адреса сервисов из каталога эндпоинтов облака:");
  let catalog = {};
  try {
    catalog = (await yc.loadEndpoints()) || {};
  } catch (e) {
    catalog = {};
  }
  for (const id of SERVICES) {
    const known = catalog[id] || "";
    console.log("   " + id.padEnd(22) + (known || "(в каталоге нет — проверим по известному адресу, если он есть)"));
  }

  console.log("\n4) Списковые методы (только чтение):");
  const headers = { Authorization: "Bearer " + iam };
  for (const p of PROBES) {
    const base = catalog[p.svc] || (await yc.endpoint(p.svc)) || "";
    if (!base) {
      console.log("   " + (p.svc + p.path).padEnd(46) + "— адрес сервиса неизвестен");
      continue;
    }
    const url = base + p.path + (p.noFolder ? "" : "?folderId=" + encodeURIComponent(folder || "") + "&pageSize=5");
    const r = await tryJson(url, { headers });
    const mark = r.status === 200 ? "OK  " : r.status === 403 ? "НЕТ ПРАВ" : r.status === 404 ? "НЕТ МЕТОДА" : "?" + r.status;
    console.log("   " + mark.padEnd(11) + (p.svc + p.path).padEnd(46) + head(r.text, 150));
  }

  console.log("\n5) Что ещё стоит проверить руками (в скрипте этого нет намеренно):");
  console.log("   • serialPortOutput и метрики — только по конкретному id ресурса;");
  console.log("   • Monitoring (метрики) — если REST не отвечает, читать придётся по gRPC:");
  console.log("     в приложении уже есть свой мини-gRPC (src/yc-logs.js), его и переиспользуем;");
  console.log("   • Billing требует роли billing.viewer и привязан к платёжному аккаунту, а не к каталогу;");
  console.log("   • Cloud Functions: вызов функции и создание версии — это уже запись, их проверяем отдельно");
  console.log("     (test:live:yc:real с AI_AGENT_YC_REAL=1), а не разведкой.");
  console.log("\nРазведка закончена: ничего не создано и не изменено.");
})();

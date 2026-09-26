"use strict";

/* ── Таблицы агента: настоящий .xlsx и Google Sheets (гибрид) ─────────────────
   Запуск: node test/sheets.test.js   (входит в общий `npm test`)

   Здесь три модуля и их связка:

     • src/xlsx.js — свой писатель/читатель .xlsx без зависимостей (ZIP, CRC32,
       XML). Проверяем КРУГ: записали → прочитали, и что числа остаются числами
       (иначе в Excel данные лежат текстом и не считаются формулами);
     • src/google-sheets.js — JWT сервис-аккаунта и Sheets API. Подпись проверяем
       НАСТОЯЩИМ ключом RSA, а сеть — подставным fetch, поэтому тест без интернета;
     • src/agent-tools-sheets.js — семь инструментов. Главное здесь — ГИБРИД: без
       ключа gSheet*-инструменты не падают, а отдают модели рецепт браузерного пути.

   Плюс проводка: схемы, группа роутера, права, секреты и настройки. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const { xlsxWrite, xlsxRead, findSheet, colLetters, safeSheetName, crc32 } = require(path.join(ROOT, "src", "xlsx.js"));
const gsheets = require(path.join(ROOT, "src", "google-sheets.js"));
const { createSheetsTools } = require(path.join(ROOT, "src", "agent-tools-sheets.js"));

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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sheets-"));

// Ключ RSA один на весь тест — им же проверяем подпись JWT.
const rsa = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const serviceAccount = {
  type: "service_account",
  project_id: "demo-project",
  client_email: "agent@demo-project.iam.gserviceaccount.com",
  private_key: rsa.privateKey,
  client_id: "1234567890",
};

// Инструменты собираются с теми же внедрениями, что и в приложении.
const settings = { workingDir: tmpRoot };
const tools = createSheetsTools({
  fs,
  path,
  resolvePath: (p, s) => (path.isAbsolute(p) ? p : path.resolve(s.workingDir, p)),
  agentWorkDir: (s) => s.workingDir,
  truncateText: (t, cap) => (String(t).length > cap ? String(t).slice(0, cap) : String(t)),
});

// Подставной fetch: токен Google и любое обращение к Sheets API.
function fakeFetch(handler) {
  return async (url, opts) => {
    const body = handler(url, opts || {});
    return {
      ok: body.status ? body.status < 400 : true,
      status: body.status || 200,
      text: async () => JSON.stringify(body.json || {}),
    };
  };
}

(async () => {
  console.log("Таблицы агента (src/xlsx.js, src/google-sheets.js, src/agent-tools-sheets.js)");

  await test("xlsx: круг «записали → прочитали», числа остаются числами", () => {
    const buf = xlsxWrite([
      { name: "Продажи", rows: [["Клиент", "Сумма", "Оплачено"], ["ООО Ромашка", 120000, true], ["ИП & Ко", 45000.5, false]] },
      { name: "Итоги", rows: [["Месяц", "Всего"], ["Март", 165000.5]] },
    ]);
    assert.ok(Buffer.isBuffer(buf) && buf.length > 0, "писатель вернул не буфер");
    // ZIP начинается с сигнатуры PK\x03\x04.
    assert.strictEqual(buf.slice(0, 2).toString("latin1"), "PK", "это не ZIP-архив");

    const book = xlsxRead(buf);
    assert.strictEqual(book.sheets.length, 2, "листов не два");
    assert.deepStrictEqual(book.sheets.map((s) => s.name), ["Продажи", "Итоги"], "имена листов разошлись");
    const sales = findSheet(book, "Продажи");
    assert.ok(sales, "лист «Продажи» не найден по имени");
    const r = sales.rows;
    assert.strictEqual(r[0][0], "Клиент", "шапка потерялась");
    assert.strictEqual(r[1][1], 120000, "число превратилось в строку");
    assert.strictEqual(typeof r[1][1], "number", "тип числа не сохранился");
    assert.strictEqual(r[1][2], true, "булево потерялось");
    assert.strictEqual(r[2][1], 45000.5, "дробное число потерялось");
    assert.strictEqual(r[2][0], "ИП & Ко", "спецсимвол & не пережил запись");
    assert.strictEqual(findSheet(book, "Итоги").rows[1][1], 165000.5, "второй лист прочитан неверно");
    assert.strictEqual(findSheet(book, "нет-такого"), null, "несуществующий лист не null");
  });

  await test("xlsx: имена листов чистятся, колонки считаются, CRC32 верен", () => {
    assert.strictEqual(colLetters(0), "A");
    assert.strictEqual(colLetters(25), "Z");
    assert.strictEqual(colLetters(26), "AA");
    assert.strictEqual(colLetters(27), "AB");
    // Недопустимые символы и пустое имя заменяются, длинное подрезается, дубли — с индексом.
    assert.strictEqual(safeSheetName("", 0), "Лист1", "пустое имя не заменено");
    assert.ok(!/[\\/:*?\[\]]/.test(safeSheetName("a/b:c*d", 0)), "недопустимые символы не убраны");
    assert.ok(safeSheetName("x".repeat(40), 0).length <= 31, "имя листа длиннее 31 символа");
    assert.strictEqual(safeSheetName("", 1), "Лист2", "безымянные листы не разведены по индексу");
    // CRC32 эталонное значение ("123456789" → 0xCBF43926).
    assert.strictEqual(crc32(Buffer.from("123456789")) >>> 0, 0xcbf43926, "CRC32 считается неверно");
  });

  await test("xlsx: запись в файл и чтение обратно с диска", () => {
    const p = path.join(tmpRoot, "disk.xlsx");
    fs.writeFileSync(p, xlsxWrite([{ name: "Лист1", rows: [["a", 1], ["b", 2]] }]));
    const book = xlsxRead(fs.readFileSync(p));
    assert.strictEqual(book.sheets[0].rows[1][1], 2, "файл с диска прочитан неверно");
  });

  await test("google-sheets: ключ разбирается строго, мусор отвергается", () => {
    assert.strictEqual(gsheets.parseServiceAccount(""), null, "пустая строка принята");
    assert.strictEqual(gsheets.parseServiceAccount("не json"), null, "не-JSON принят");
    assert.strictEqual(gsheets.parseServiceAccount('{"client_email":"x@y.com","private_key":"нет"}'), null, "ключ без подписи принят");
    assert.strictEqual(gsheets.parseServiceAccount('{"client_email":"не-сервис","private_key":"-----BEGIN PRIVATE KEY-----"}'), null, "чужой e-mail принят");
    const ok = gsheets.parseServiceAccount(JSON.stringify(serviceAccount));
    assert.ok(ok && ok.client_email === serviceAccount.client_email, "годный ключ не разобран");
    const obj = gsheets.parseServiceAccount(serviceAccount);
    assert.ok(obj && obj.private_key, "объект-ключ не принят");
  });

  await test("google-sheets: JWT подписан настоящим RSA и проверяется публичным ключом", () => {
    const key = gsheets.parseServiceAccount(serviceAccount);
    const jwt = gsheets.buildJwt(key, Date.now());
    const parts = jwt.split(".");
    assert.strictEqual(parts.length, 3, "JWT не из трёх частей");
    const header = JSON.parse(Buffer.from(parts[0], "base64").toString("utf8"));
    assert.strictEqual(header.alg, "RS256", "алгоритм подписи не RS256");
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(parts[0] + "." + parts[1]);
    verify.end();
    assert.ok(verify.verify(rsa.publicKey, Buffer.from(parts[2], "base64")), "подпись JWT не сходится");
    const claims = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    assert.strictEqual(claims.aud, gsheets.TOKEN_URL, "aud не равен адресу токена");
    assert.ok(/spreadsheets/.test(claims.scope), "в токене нет доступа к таблицам");
    assert.ok(claims.exp - claims.iat === 3600, "время жизни токена не час");
  });

  await test("google-sheets: токен берётся один раз и кэшируется, ошибка объясняется", async () => {
    gsheets.clearTokenCache();
    const key = gsheets.parseServiceAccount(serviceAccount);
    let calls = 0;
    const fetchImpl = fakeFetch((url) => {
      calls++;
      assert.strictEqual(url, gsheets.TOKEN_URL, "токен запрашивается не по адресу");
      return { json: { access_token: "tok-1", expires_in: 3600 } };
    });
    const t1 = await gsheets.getAccessToken(key, { fetchImpl });
    const t2 = await gsheets.getAccessToken(key, { fetchImpl });
    assert.strictEqual(t1, "tok-1", "токен не получен");
    assert.strictEqual(t2, "tok-1", "кэш отдал другой токен");
    assert.strictEqual(calls, 1, "токен запрашивался дважды — кэш не работает");
    // Ошибку Google показываем человеку текстом, а не молчим.
    gsheets.clearTokenCache();
    const bad = fakeFetch(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Invalid JWT" } }));
    await assert.rejects(() => gsheets.getAccessToken(key, { fetchImpl: bad }), /Invalid JWT/, "ошибка токена не объяснена");
  });

  await test("google-sheets: id таблицы берётся из ссылки или голого id", () => {
    assert.strictEqual(gsheets.sheetIdFromArg("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit#gid=0"), "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890");
    assert.strictEqual(gsheets.sheetIdFromArg("1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"), "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890");
    assert.strictEqual(gsheets.sheetIdFromArg("просто текст"), "", "мусор принят за id");
    assert.strictEqual(gsheets.sheetIdFromArg(""), "", "пустое дало id");
  });

  await test("google-sheets: чтение/запись/добавление/создание шлют верный запрос", async () => {
    gsheets.clearTokenCache();
    const key = gsheets.parseServiceAccount(serviceAccount);
    const seen = [];
    const fetchImpl = fakeFetch((url, opts) => {
      seen.push({ url, method: opts.method, body: opts.body });
      if (url === gsheets.TOKEN_URL) return { json: { access_token: "tok", expires_in: 3600 } };
      if (/:append/.test(url)) return { json: { updates: { updatedRange: "Лист1!A3", updatedRows: 2 } } };
      if (opts.method === "PUT") return { json: { updatedRange: "Лист1!A1:B1", updatedCells: 2, updatedRows: 1 } };
      if (opts.method === "POST") return { json: { spreadsheetId: "NEW1", properties: { title: "Отчёт" }, spreadsheetUrl: "https://docs.google.com/spreadsheets/d/NEW1/edit" } };
      if (/\/NEW1$/.test(url)) return { json: { spreadsheetId: "NEW1", properties: { title: "Отчёт" }, sheets: [] } };
      return { json: { range: "Лист1!A1:B2", values: [["a", 1], ["b", 2]] } };
    });

    const rv = await gsheets.readValues({ key, id: "S1", range: "Лист1!A1:B2", fetchImpl });
    assert.deepStrictEqual(rv.values, [["a", 1], ["b", 2]], "значения прочитаны неверно");
    const uv = await gsheets.updateValues({ key, id: "S1", range: "Лист1!A1", values: [["x", "y"]], fetchImpl });
    assert.strictEqual(uv.updatedCells, 2, "запись не отдала число ячеек");
    const ap = await gsheets.appendValues({ key, id: "S1", range: "Лист1!A1", values: [["z"]], fetchImpl });
    assert.strictEqual(ap.updatedRows, 2, "добавление не отдало число строк");
    const cr = await gsheets.createSpreadsheet({ key, title: "Отчёт", fetchImpl });
    assert.strictEqual(cr.spreadsheetId, "NEW1", "создание не вернуло id");
    assert.ok(/\bsheets\.googleapis\.com\b/.test(seen[1].url), "запрос ушёл не в Sheets API");

    // Запись уходит методом PUT с телом values, добавление — POST :append.
    const put = seen.find((s) => s.method === "PUT");
    assert.ok(put && /values/.test(put.body), "тело записи не содержит values");
    const append = seen.find((s) => /:append/.test(s.url));
    assert.ok(append && append.method === "POST", "append — не POST :append");
  });

  await test("инструменты: sheetWrite собирает .xlsx, sheetRead его читает", async () => {
    const w = await tools.sheetWrite({ path: "report.xlsx", rows: [["Клиент", "Сумма"], ["Ромашка", 1000]] }, settings);
    assert.ok(/OK — таблица сохранена/.test(w), "запись не подтвердилась: " + w);
    assert.ok(fs.existsSync(path.join(tmpRoot, "report.xlsx")), "файл не создан");
    const r = await tools.sheetRead({ path: "report.xlsx" }, settings);
    assert.ok(/Клиент/.test(r) && /Ромашка/.test(r), "прочитанное не содержит данных: " + r);
    assert.ok(/1000/.test(r), "число не показано");
  });

  await test("инструменты: objects → шапка из ключей, CSV собирается", async () => {
    const w = await tools.sheetWrite({ path: "objs.xlsx", objects: [{ Имя: "Аня", Балл: 5 }, { Имя: "Борис", Балл: 4 }] }, settings);
    assert.ok(/OK/.test(w), "запись объектов не удалась: " + w);
    const r = await tools.sheetRead({ path: "objs.xlsx" }, settings);
    assert.ok(/Имя/.test(r) && /Балл/.test(r), "шапка из ключей не собрана: " + r);
    const csv = await tools.sheetWrite({ path: "list.csv", format: "csv", rows: [["a", "b,c"], ["d", "e"]] }, settings);
    assert.ok(/csv/.test(csv), "csv-формат не подтверждён: " + csv);
    const text = fs.readFileSync(path.join(tmpRoot, "list.csv"), "utf8");
    assert.ok(/"b,c"/.test(text), "запятая внутри значения не экранирована: " + text);
  });

  await test("гибрид: без ключа gSheet*-инструменты отдают рецепт браузерного пути", async () => {
    const noKey = { workingDir: tmpRoot };
    const r = await tools.gSheetRead({ spreadsheet: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit" }, noKey);
    assert.ok(/browserOpen/.test(r), "нет рецепта открыть браузером: " + r);
    assert.ok(/vaultFill/.test(r), "нет подсказки про менеджер паролей: " + r);
    assert.ok(/Настройки → Таблицы/.test(r), "не сказано, где взять ключ: " + r);
    const w = await tools.gSheetAppend({ spreadsheet: "X".repeat(30), values: [["a"]] }, noKey);
    assert.ok(/browserOpen/.test(w), "append без ключа не дал браузерный путь: " + w);
  });

  await test("гибрид: с ключом gSheet*-инструменты работают по API", async () => {
    const realFetch = global.fetch;
    try {
      const keySettings = { workingDir: tmpRoot, googleServiceAccount: JSON.stringify(serviceAccount) };
      gsheets.clearTokenCache();
      global.fetch = fakeFetch((url, opts) => {
        if (url === gsheets.TOKEN_URL) return { json: { access_token: "tok", expires_in: 3600 } };
        if (opts.method === "PUT") return { json: { updatedRange: "Лист1!A1:B1", updatedCells: 2 } };
        if (/:append/.test(url)) return { json: { updates: { updatedRows: 1, updatedRange: "Лист1!A3" } } };
        if (opts.method === "POST") return { json: { spreadsheetId: "NEW9", properties: { title: "Отчёт" }, spreadsheetUrl: "https://x" } };
        if (/\/values\//.test(url)) return { json: { range: "Лист1!A1:B2", values: [["a", 1], ["b", 2]] } };
        // GET по id самой таблицы — это её описание.
        return { json: { spreadsheetId: "S", properties: { title: "Отчёт" }, sheets: [{ properties: { title: "Лист1", gridProperties: { rowCount: 100, columnCount: 20 } } }] } };
      });
      const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
      const r = await tools.gSheetRead({ spreadsheet: id, range: "Лист1!A1:B2" }, keySettings);
      assert.ok(/строк: 2/.test(r), "по API прочитано неверно: " + r);
      const w = await tools.gSheetWrite({ spreadsheet: id, range: "Лист1!A1", values: [["x", "y"]] }, keySettings);
      assert.ok(/OK — записано/.test(w), "запись по API не подтвердилась: " + w);
      const a = await tools.gSheetAppend({ spreadsheet: id, values: [["z"]] }, keySettings);
      assert.ok(/добавлено строк/.test(a), "добавление по API не подтвердилось: " + a);
      const info = await tools.gSheetInfo({ spreadsheet: id }, keySettings);
      assert.ok(/«Отчёт»/.test(info) && /100×20/.test(info), "информация о таблице неверна: " + info);
      const c = await tools.gSheetCreate({ title: "Отчёт" }, keySettings);
      assert.ok(/NEW9/.test(c), "создание не вернуло id: " + c);
      // Ошибка доступа объясняется по-русски с подсказкой про расшаривание: токен
      // выдаётся, а вот сама таблица не расшарена на сервис-аккаунт.
      global.fetch = fakeFetch((url) =>
        url === gsheets.TOKEN_URL
          ? { json: { access_token: "tok", expires_in: 3600 } }
          : { status: 403, json: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } }
      );
      gsheets.clearTokenCache();
      const denied = await tools.gSheetRead({ spreadsheet: id }, keySettings);
      assert.ok(/расшарен/i.test(denied), "отказ доступа не объяснён: " + denied);
      assert.ok(!/\[object Object\]/.test(denied), "в ошибке остался [object Object]: " + denied);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("проводка: схема, группа роутера, права и роли согласованы", () => {
    const schemas = read("src", "renderer", "tool-schemas.js");
    const names = ["sheetWrite", "sheetRead", "gSheetRead", "gSheetWrite", "gSheetAppend", "gSheetInfo", "gSheetCreate"];
    for (const n of names) assert.ok(schemas.includes('name: "' + n + '"'), "нет схемы инструмента: " + n);

    const core = read("src", "renderer", "agent-core.js");
    assert.ok(/id: "sheets"/.test(core), "нет группы роутера sheets");
    const groupMatch = core.match(/id: "sheets"[\s\S]*?names: \[([^\]]+)\]/);
    assert.ok(groupMatch, "группа sheets без списка инструментов");
    for (const n of names) assert.ok(groupMatch[1].includes('"' + n + '"'), "группа sheets не содержит: " + n);
    // Таблицы доступны менеджеру и ассистенту — это их работа.
    assert.ok(/groups: \["tasks", "notes", "mail", "system", "browser", "vault", "sheets"\]/.test(core), "у менеджера нет группы таблиц");
    assert.ok(/groups: \["notes", "mail", "system", "browser", "files", "terminal", "vault", "sheets"\]/.test(core), "у ассистента нет группы таблиц");

    const policy = require(path.join(ROOT, "src", "tool-policy.js"));
    for (const n of names) assert.notStrictEqual(policy.capabilityOf(n), "unknown", n + " остался без прав");
    assert.ok(policy.toolsForCapability("sheets.write").includes("gSheetWrite"), "запись в Google-таблицу без прав");

    const toolsSrc = read("src", "agent-tools.js");
    assert.ok(/require\("\.\/agent-tools-sheets\.js"\)/.test(toolsSrc), "дома инструментов нет в реестре");
    assert.ok(/createSheetsTools\(deps\)/.test(toolsSrc), "инструменты таблиц не подключены к реестру");
  });

  await test("проводка: ключ service account — секрет, есть в настройках и в интерфейсе", () => {
    const secrets = read("src", "secrets.js");
    assert.ok(/"googleServiceAccount"/.test(secrets), "ключ не признан секретом");
    const store = read("src", "settings-store.js");
    assert.ok(/googleServiceAccount: ""/.test(store), "нет значения по умолчанию в настройках");
    const html = read("src", "renderer", "index.html");
    assert.ok(html.includes('id="s-gsheet-key"'), "нет поля для ключа в настройках");
    assert.ok(/Таблицы \(Excel и Google Sheets\)/.test(html), "нет раздела «Таблицы»");
    const panel = read("src", "renderer", "settings-panel.js");
    assert.ok(/googleServiceAccount/.test(panel), "панель настроек не читает/не пишет ключ");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

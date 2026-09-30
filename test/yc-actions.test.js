"use strict";

/* ── Действия облака в интерфейсе (src/renderer/yc-actions.js) ───────────────
   Запуск: node test/yc-actions.test.js   (входит в общий `npm test`)

   Зачем этот набор. Части 69–73 научили АГЕНТА работать с машинами, сетью, IAM,
   функциями, деньгами и HTTPS-сайтом, но в окне этих действий не было вовсе:
   каналы IPC и мост существовали, а виджета, который их зовёт, — нет. Часть 75
   закрыла этот разрыв таблицей действий и формами.

   Что здесь стережётся (и почему именно это):
     • СПИСОК ДЕЙСТВИЙ НЕ РАСХОДИТСЯ С КАНАЛАМИ. Кнопка, которая обещает
       действие, а канал его не знает, — худший вид поломки: человек нажимает и
       получает «Неизвестное действие». Поэтому `OPS` из модуля сверяется с
       отказами В САМОМ src/yc-ipc.js (разбором строк «Доступно: …»), а не с
       памятью автора.
     • ПЛАТНОЕ И НЕОБРАТИМОЕ ПОМЕЧЕНО. У платных (машина, снимок, CDN-ресурс,
       статический адрес) стоит `paid`, у удаляющих — `danger`, а аргумент
       согласия — ровно тот, которым канал закрывает операцию (`confirmed` у
       машин и функций, `confirm` у CDN). Иначе «платное» создавалось бы одним
       нажатием, а «необратимое» — без вопроса.
     • СЕКРЕТ НЕ УТЕКАЕТ В ЖУРНАЛ. Секрет ключа и личный ключ SSH показываются
       один раз отдельной рамкой, а в строки ответа (и в журнал) попадает только
       подпись «ключ создан» — это проверяется негативным контролем.
     • ПОЛКЕ ВИДНО МАШИНЫ. Машины пришли на полку вместе с действиями: сервис
       `compute` есть в SERVICES, у него есть адрес в KNOWN_ENDPOINTS (иначе
       облако отвечает «эндпоинт не найден»), связи консоли не выдуманы, а у
       панели есть русская форма слова.
     • МОДУЛЬ НЕ ТРОГАЕТ DOM ПРИ ЗАГРУЗКЕ: он самодостаточный (как yc-console.js)
       и не требует проводки в app.js — иначе порядок тегов стал бы важным, а
       падение — молчаливым.
     • негативные контроли: отказ облака показывается текстом, ответ с «нужно
       согласие» не считается успехом, а пустой список не оставляет пустую рамку. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
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
const SRC = read("src", "renderer", "yc-actions.js");
const CSS = read("src", "renderer", "yc-actions.css");
const PANEL = read("src", "renderer", "yc-panel.js");
const PANEL_CSS = read("src", "renderer", "yc-panel.css");
const CONSOLE_SRC = read("src", "renderer", "yc-console.js");
const HTML = read("src", "renderer", "index.html");
const PRELOAD = read("src", "preload.js");
const BRIDGE = read("src", "mobile-bridge.js");
const IPC = read("src", "yc-ipc.js");
const YANDEX = read("src", "yandex-cloud.js");
const DOC = read("docs", "ARCHITECTURE.md"); // документы переехали из корня в docs/ (часть 76)
const PKG = JSON.parse(read("package.json"));

// Набор действий читаем ИЗ МОДУЛЯ, а не из своей копии таблицы: копия проверяла
// бы саму себя. Модуль при загрузке не должен трогать DOM — это и есть проверка
// «самодостаточности».
function loadActions() {
  const ctx = { window: {}, document: undefined, navigator: {}, console: console };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "yc-actions.js" });
  assert.ok(ctx.window.YcActions, "модуль не выставил window.YcActions");
  return ctx.window.YcActions;
}

const A = loadActions();

// ── Каналы yc-ipc.js: что каждый принимает и какой аргумент закрывает платное ─
const FAMILY_CHANNEL = {
  compute: "yc:compute",
  vpc: "yc:vpc",
  iam: "yc:iam",
  cloudFunctions: "yc:functions",
  cdn: "yc:cdn",
  certificateManager: "yc:cdn",
  billing: "yc:billing",
  monitoring: "yc:monitoring",
  ai: "yc:ai",
  // Managed-базы: три семейства (своя плитка у каждой базы), но ОДИН канал —
  // у PostgreSQL, MySQL и ClickHouse один API, и различает их поле engine.
  postgresql: "yc:mdb",
  mysql: "yc:mdb",
  clickhouse: "yc:mdb",
  // DNS-зоны и записи: записи умели агент и карточка зоны, а у плитки действий
  // не было — у сервиса появился свой канал, как у остальных.
  dns: "yc:dns",
};

function section(channel) {
  const at = IPC.indexOf('ipcMain.handle("' + channel + '"');
  assert.ok(at > 0, "в yc-ipc.js нет канала " + channel);
  let end = IPC.indexOf('ipcMain.handle("', at + 10);
  if (end < 0) end = IPC.length;
  return IPC.slice(at, end);
}

function allowedOps(channel) {
  const sec = section(channel);
  const m = sec.match(/Доступно:\s*([^"]+?)\./);
  if (m) return m[1].split(",").map((x) => x.trim()).filter(Boolean);
  // Канал, у которого список действий печатается СБОРКОЙ из массива
  // (`ALL.join(", ")`), строки для разбора не даёт — и это лучше, чем копия
  // списка в тексте: читаем сам массив, он и есть список допустимых действий.
  const arr = sec.match(/const ALL = \[([^\]]+)\];/);
  assert.ok(arr, "в канале " + channel + " нет списка доступных действий («Доступно: …»)");
  assert.ok(/Доступно:\s*" \+ ALL\.join\(", "\)/.test(sec), "отказ канала " + channel + " не называет действия из ALL");
  return arr[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function confirmArgs(channel) {
  const s = section(channel);
  const out = [];
  if (/a\.confirmed\s*!==\s*true/.test(s)) out.push("confirmed");
  if (/a\.confirm\s*===\s*true/.test(s)) out.push("confirm");
  // У части каналов проверка написана от обратного («без согласия — отказ»):
  // для семейств, где согласие нужно почти всегда, так читается понятнее.
  if (/a\.confirm\s*!==\s*true/.test(s) && out.indexOf("confirm") < 0) out.push("confirm");
  return out;
}

function main() {
  console.log("[1] Таблица действий не расходится с каналами");
  return Promise.resolve()
    .then(() =>
      test("каждое действие существует в своём канале yc-ipc.js", () => {
        const known = {};
        for (const ch of Object.keys(FAMILY_CHANNEL)) known[ch] = allowedOps(FAMILY_CHANNEL[ch]);
        const bad = [];
        let checked = 0;
        for (const service of Object.keys(A.ACTIONS)) {
          for (const a of A.ACTIONS[service]) {
            const ops = known[service];
            assert.ok(ops, "у семейства " + service + " нет канала");
            checked++;
            if (ops.indexOf(a.op) < 0) bad.push(service + ":" + a.id + " → " + a.op);
          }
        }
        assert.ok(checked >= 50, "действий найдено подозрительно мало: " + checked);
        assert.deepStrictEqual(bad, [], "кнопки обещают действия, которых канал не знает: " + bad.join(", "));
      })
    )
    .then(() =>
      test("таблица OPS в модуле совпадает с отказами канала", () => {
        // Сертификаты и CDN делят ОДИН канал (src/yc-cdn.js), поэтому список
        // действий объявлен один раз — у CDN. Действия сертификатов проверены
        // выше: каждое из них обязано быть в списке своего канала.
        let compared = 0;
        for (const service of Object.keys(A.CHANNELS)) {
          if (!A.OPS[service]) continue;
          const ipcChannel = FAMILY_CHANNEL[service];
          if (!ipcChannel) continue;
          compared++;
          // Array.from — не косметика: массивы из vm-контекста живут со СВОИМ
          // Array.prototype, и deepStrictEqual считает их неравными даже при
          // одинаковом содержимом.
          assert.deepStrictEqual(
            Array.from(A.OPS[service]).sort(),
            allowedOps(ipcChannel).slice().sort(),
            service + ": список действий модуля разошёлся с каналом " + ipcChannel
          );
        }
        assert.ok(compared >= 6, "сверено подозрительно мало каналов: " + compared);
      })
    )
    .then(() =>
      test("каналы действий есть в мосте окна (preload)", () => {
        for (const service of Object.keys(A.CHANNELS)) {
          const name = A.CHANNELS[service];
          assert.ok(PRELOAD.indexOf(name + ": (args) =>") >= 0, "в preload нет " + name);
        }
      })
    )
    .then(() =>
      test("платное и необратимое помечено, согласие названо аргументом канала", () => {
        // Настоящее правило: если канал требует согласия (`confirmed`/`confirm`),
        // то действие обязано быть ПОМЕЧЕНО платным и назвать именно этот
        // аргумент. Список ниже — не копия таблицы, а следствие: он проверяет,
        // что пометки не потерялись у тех действий, где за них платят или где
        // отменить уже нельзя.
        const mustPay = ["compute:create", "compute:snapshot", "compute:restoredisk", "vpc:reserve", "cdn:cdncreate", "certificateManager:cdncreate", "postgresql:create", "mysql:create", "clickhouse:create"];
        const mustDanger = ["compute:delete", "compute:delsnapshot", "vpc:delsubnet", "vpc:delgroup", "vpc:delrule", "vpc:release", "iam:delete", "iam:revoke", "iam:delkey", "cloudFunctions:delete", "cloudFunctions:delversion", "cloudFunctions:public", "cdn:cdndel", "certificateManager:certdel", "postgresql:delete", "mysql:delete", "clickhouse:delete", "dns:delete"];
        const problems = [];
        const seen = new Set();
        for (const service of Object.keys(A.ACTIONS)) {
          for (const a of A.ACTIONS[service]) {
            seen.add(service + ":" + a.id);
            const args = confirmArgs(FAMILY_CHANNEL[service]);
            if (a.confirmArg) {
              if (args.indexOf(a.confirmArg) < 0) problems.push(service + ":" + a.id + " — аргумент согласия «" + a.confirmArg + "» канал не читает");
              // Согласие бывает двух родов: за деньги (машина) и за необратимость
              // (удаление). Но если канал согласие требует, пометка обязана быть.
              if (!a.paid && !a.danger) problems.push(service + ":" + a.id + " — канал требует согласия, а действие не помечено (ни платное, ни опасное)");
            }
            if (mustPay.indexOf(service + ":" + a.id) >= 0 && !a.paid) problems.push(service + ":" + a.id + " — платное без пометки");
            if (mustDanger.indexOf(service + ":" + a.id) >= 0 && !a.danger) problems.push(service + ":" + a.id + " — необратимое без пометки");
          }
        }
        for (const id of mustPay.concat(mustDanger)) {
          if (!seen.has(id)) problems.push(id + " — действия больше нет, а проверка осталась");
        }
        assert.deepStrictEqual(problems, [], problems.join(" | "));
      })
    )
    .then(() =>
      test("у каждого действия есть подпись, вид результата и цель, где она нужна", () => {
        const needTarget = ["card", "start", "stop", "restart", "serial", "metrics", "delsnapshot", "cert", "certdel", "cdninfo", "cdnupdate", "cdnpurge", "cdndel", "delversion", "tag", "untag", "invoke", "grant", "revoke", "delkey", "keys", "delsubnet", "delgroup", "release"];
        const ids = [];
        for (const service of Object.keys(A.ACTIONS)) {
          for (const a of A.ACTIONS[service]) {
            assert.ok(a.ru && a.ru.trim(), service + ":" + a.id + " — без русской подписи");
            assert.ok(!/^[a-zA-Z0-9 ]+$/.test(a.ru), service + ":" + a.id + " — подпись без русского: " + a.ru);
            assert.ok(A.VIEWS[a.view], service + ":" + a.id + " — неизвестный вид результата: " + a.view);
            ids.push(service + ":" + a.id);
            if (needTarget.indexOf(a.op) >= 0 && !a.target && !(a.fields || []).some((f) => f.required)) {
              assert.fail(service + ":" + a.id + " — действию нужен ресурс, а спросить его нечем");
            }
          }
        }
        assert.strictEqual(new Set(ids).size, ids.length, "дубли id действий: " + ids.join(", "));
      })
    );
}

function main2() {
  console.log("\n[2] Сборка запроса и разбор ответа");
  return Promise.resolve()
    .then(() =>
      test("запрос: пустые поля не уходят, галочка не уходит «false»", () => {
        const r = A.request("cloudFunctions", "invoke", { name: "hello", tag: "", payload: "" });
        assert.strictEqual(r.channel, "ycFunctions");
        assert.strictEqual(r.args.op, "invoke");
        assert.strictEqual(r.args.name, "hello");
        assert.strictEqual(r.args.tag, undefined, "пустой тег уехал в облако");
        const stop = A.request("compute", "create", { name: "web", publicIp: false, diskSizeGb: "20" });
        assert.strictEqual(stop.args.publicIp, false, "галочка потерялась");
        assert.strictEqual(stop.args.diskSizeGb, 20, "число уехало строкой");
        assert.strictEqual(stop.args.confirmed, undefined, "согласие уехало без подтверждения");
        assert.strictEqual(A.request("compute", "create", { name: "web" }, true).args.confirmed, true, "согласие не уехало");
        assert.strictEqual(A.request("compute", "no-such", {}), null, "неизвестное действие собралось");
      })
    )
    .then(() =>
      test("ответ «нужно согласие» — не успех, а вопрос с ценой", () => {
        const sum = A.summarize("compute", "create", { ok: false, needsConfirm: true, lines: ["Машина: ≈ 1 200 ₽/мес"], error: "Машина создаётся платно" });
        assert.strictEqual(sum.ok, false);
        assert.strictEqual(sum.needsConfirm, true, "вопрос о цене потерялся");
        assert.ok(sum.lines.join(" ").indexOf("1 200") >= 0, "цена не показана: " + sum.lines.join(" | "));
      })
    )
    .then(() =>
      test("отказ облака показан текстом (негативный контроль)", () => {
        const sum = A.summarize("iam", "grant", { ok: false, error: "Нет доступа (403) к iam.api.cloud.yandex.net" });
        assert.strictEqual(sum.ok, false);
        assert.strictEqual(sum.lines.length, 1);
        assert.ok(/403/.test(sum.lines[0]), "отказ потерян: " + sum.lines.join(" | "));
        assert.ok(!sum.needsConfirm, "отказ принят за подтверждение");
      })
    )
    .then(() =>
      test("секрет уходит в отдельное поле и НЕ попадает в строки ответа", () => {
        const sum = A.summarize("iam", "newkey", { ok: true, message: "Ключ создан", secret: "SECRET-42", warnings: ["Значение больше не покажут"] });
        assert.strictEqual(sum.secret, "SECRET-42", "секрет потерян");
        assert.ok(sum.lines.join(" ").indexOf("SECRET-42") < 0, "секрет попал в строки ответа");
        assert.ok(sum.warn.join(" ").indexOf("не покажут") >= 0, "предупреждение модуля потеряно");
        const ssh = A.summarize("compute", "sshkey", { ok: true, publicKey: "ssh-ed25519 AAAA", privateKey: "PRIVATE", fingerprint: "aa:bb" });
        assert.ok(ssh.lines.join(" ").indexOf("ssh-ed25519") >= 0, "публичный ключ не показан");
        assert.strictEqual(ssh.secret, "PRIVATE", "личный ключ не в рамке секрета");
      })
    )
    .then(() =>
      test("списки читаются словами: машины с хвостами, сеть с простаивающими адресами", () => {
        const cmp = A.summarize("compute", "list", {
          ok: true,
          instances: [{ name: "web-1", statusHuman: "работает", running: true, zoneId: "ru-central1-a", cores: 2, coreFraction: 20, guaranteedVcpu: 0.4, memoryHuman: "2 ГБ", hasExternalIp: true, externalIp: "1.2.3.4", uptime: "3 часа" }],
          disks: [{}, {}],
          snapshots: [{}],
          leftovers: { total: 1, lines: ["диски без машины: data-old 93 ГБ"] },
        });
        const text = cmp.lines.join("\n");
        assert.ok(text.indexOf("web-1") >= 0 && text.indexOf("1.2.3.4") >= 0, "машина не показана: " + text);
        assert.ok(text.indexOf("диски без машины") >= 0, "платный хвост потерян");
        assert.ok(cmp.warn.length >= 1, "о хвостах не предупреждают");
        const net = A.summarize("vpc", "list", {
          ok: true,
          networks: [{ id: "n1", name: "default" }],
          subnets: [{ name: "app", zoneId: "ru-central1-a", v4CidrBlocks: ["10.0.1.0/24"] }],
          securityGroups: [{ name: "web-sg", ingress: 2, egress: 0 }],
          addresses: [{ address: "1.2.3.4", used: false }],
          idleAddresses: [{ address: "1.2.3.4" }],
          suggestedCidr: "10.0.2.0/24",
        });
        const ntext = net.lines.join("\n");
        assert.ok(ntext.indexOf("10.0.2.0/24") >= 0, "подсказка диапазона потеряна");
        assert.ok(/ПРОСТАИВАЕТ/.test(ntext), "простаивающий адрес не назван");
        assert.ok(net.warn.length >= 1, "о платном простое не предупреждают");
      })
    )
    .then(() =>
      test("пустой список объясняется словами, а не пустой рамкой", () => {
        const sum = A.summarize("cloudFunctions", "versions", { ok: true, versions: [] });
        assert.ok(sum.lines.length >= 1 && sum.lines[0].length > 3, "пусто без объяснения");
        const rus = A.summarize("cloudFunctions", "runtimes", { ok: true, runtimes: [] });
        assert.ok(rus.lines.join(" ").indexOf("язык") >= 0, "нет подсказки, что делать без списка языков");
      })
    );
}

function main3() {
  console.log("\n[3] Разметка, стили и проводка");
  return Promise.resolve()
    .then(() =>
      test("разметка грузит скрипт после панели, а стиль — после её слоя", () => {
        const jsPanel = HTML.indexOf('src="yc-panel.js"');
        const jsActions = HTML.indexOf('src="yc-actions.js"');
        assert.ok(jsPanel > 0 && jsActions > jsPanel, "yc-actions.js не подключён после yc-panel.js");
        const cssPanel = HTML.indexOf('href="yc-panel.css"');
        const cssActions = HTML.indexOf('href="yc-actions.css"');
        assert.ok(cssPanel > 0 && cssActions > cssPanel, "yc-actions.css не подключён после yc-panel.css");
        assert.ok(BRIDGE.indexOf('"yc-actions.js"') >= 0, "телефон не получит скрипт действий");
        assert.ok(BRIDGE.indexOf('"yc-actions.css"') >= 0, "телефон не получит стиль действий");
      })
    )
    .then(() =>
      test("кнопки «Действия» есть и в полке, и в карточке ресурса", () => {
        assert.ok(PANEL.indexOf("window.YcActions.forService(") >= 0, "полка не знает про действия");
        assert.ok(CONSOLE_SRC.indexOf("window.YcActions.open(") >= 0, "карточка ресурса не открывает действия");
        assert.ok(PANEL_CSS.indexOf(".yc-tile-btns") >= 0, "две кнопки в плитке не разложены");
      })
    )
    .then(() =>
      test("стили живут только в панели и не полагаются на погашенные эффекты", () => {
        // Комментарии выкидываем: в них СЛОВАМИ сказано, что тени и размытие в
        // этом приложении погашены, и поиск по тексту комментария ловил бы себя.
        const code = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
        const rules = code.split("\n").filter((l) => l.trim().endsWith("{"));
        const loose = rules.filter((l) => l.indexOf("#sp-cloud") < 0 && !/^@media|^@keyframes/.test(l.trim())).map((l) => l.trim());
        assert.deepStrictEqual(loose, [], "селекторы вне #sp-cloud: " + loose.join(" "));
        assert.ok(!/box-shadow\s*:/.test(code), "тень в действиях (monochrome.css её гасит)");
        assert.ok(!/backdrop-filter\s*:/.test(code), "размытие в действиях (monochrome.css его гасит)");
      })
    )
    .then(() =>
      test("у машины есть путь на полку: сервис, адрес и русская форма слова", () => {
        assert.ok(/key: "compute"/.test(YANDEX), "нет сервиса compute в SERVICES");
        assert.ok(/"compute": "https:\/\/compute\.api\.cloud\.yandex\.net"/.test(YANDEX), "нет адреса compute в KNOWN_ENDPOINTS");
        assert.ok(/compute: \["машина"/.test(PANEL), "у панели нет русской формы слова для машин");
        assert.ok(/compute: \{ title: "Виртуальные машины"/.test(SRC), "нет семейства действий для машин");
      })
    )
    .then(() =>
      test("набор стоит в цепочке npm test и в карте интерфейса", () => {
        assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-actions.test.js") >= 0, "набора нет в цепочке npm test");
        assert.ok(DOC.indexOf("src/renderer/yc-actions.js") >= 0, "модуля нет в карте интерфейса ARCHITECTURE.md");
        assert.ok(DOC.indexOf("src/renderer/yc-actions.css") >= 0, "стиля нет в карте интерфейса ARCHITECTURE.md");
      })
    );
}

main()
  .then(main2)
  .then(main3)
  .then(() => {
    console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
    process.exit(failed ? 1 : 0);
  });

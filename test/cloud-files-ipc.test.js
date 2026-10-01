"use strict";

/* ── Файлы для облака: системные диалоги выбора файла и места сохранения ─────
   Запуск: node test/cloud-files-ipc.test.js   (входит в общий `npm test`)

   Зачем набор. У окна есть ровно два системных диалога, и оба открываются поверх
   рабочего стола человека: выбор папки (dialog:pickDir — в настройках) и выбор
   ФАЙЛА для бакета (здесь). Тут проверяется то, что у диалога легко сломать молча:
     • отмена — это `null`, а не пустой путь (иначе в облако ушёл бы запрос с
       пустым ключом, а в чат — «файла нет»);
     • родитель — ЖИВОЕ окно, а без живого окна диалог всё равно открывается
       (на закрытом окне Electron бросает ошибку, и выбор файла перестал бы
       работать вовсе);
     • чужой рендерер диалог не открывает;
     • размер файла берётся с диска — по нему канал откажет ДО запроса, если
       файл больше предела одного запроса (сам предел живёт в yandex-cloud.js,
       и здесь его копии быть не должно).

   Чего набор НЕ проверяет (честно): настоящий Electron и настоящий рабочий стол —
   для этого нужен живой прогон (scripts/live-yc-console.js). */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

const { registerCloudFilesIpc } = require(path.join(ROOT, "src", "cloud-files-ipc.js"));
const MODULE_SRC = read("src", "cloud-files-ipc.js");
const MAIN_SRC = read("src", "main.js");
const PRELOAD = read("src", "preload.js");
const BRIDGE_SRC = read("src", "mobile-bridge.js");
const PKG = JSON.parse(read("package.json"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-files-"));
const FILE = path.join(work, "index.html");
fs.writeFileSync(FILE, "<h1>привет</h1>", "utf8");

// Живое окно: у настоящего есть webContents — по нему и отличают вызов из окна
// от чужого рендерера (src/ipc-guard.js).
const win = { isDestroyed: () => false, webContents: { id: 1 } };
const fromWindow = (h) => ({ sender: h.win.webContents, senderFrame: { parent: null } });
const fromAlien = () => ({ sender: { send() {}, id: 99 }, senderFrame: { parent: null } });

function mk(o) {
  const opts = o || {};
  const handlers = new Map();
  const opened = [];
  registerCloudFilesIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    path,
    fs,
    dialog: {
      showOpenDialog: (parent, o2) => {
        opened.push({ kind: "open", parent, opts: o2 || {} });
        return opts.canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [opts.pick || FILE] };
      },
      showSaveDialog: (parent, o2) => {
        opened.push({ kind: "save", parent, opts: o2 || {} });
        return opts.canceled ? { canceled: true } : { canceled: false, filePath: opts.save || path.join(work, "saved.html") };
      },
    },
    getWindow: () => (opts.win === null ? null : win),
    ipcGuard: require(path.join(ROOT, "src", "ipc-guard.js")),
  });
  return { handlers, opened, win };
}

(function main() {
  console.log("Файлы для облака: системные диалоги");

  return Promise.resolve()
    .then(() =>
      test("каналы объявлены ровно так, как их зовут окно и мост", () => {
        const h = mk();
        assert.deepStrictEqual([...h.handlers.keys()].sort(), ["cloud:pickFile", "cloud:pickSave"], "набор каналов разошёлся");
        for (const ch of ["cloud:pickFile", "cloud:pickSave"]) assert.ok(PRELOAD.includes(`"${ch}"`), "preload.js не знает канал " + ch);
      })
    )
    .then(() =>
      test("выбор файла: отмена — null, выбор — путь, имя и РАЗМЕР с диска", async () => {
        const h = mk();
        const r = await h.handlers.get("cloud:pickFile")(fromWindow(h), {});
        assert.strictEqual(r.path, FILE, "выбранный файл не отдан окну");
        assert.strictEqual(r.name, "index.html", "имя файла не отдано: оно подставляется в ключ бакета");
        assert.strictEqual(r.size, Buffer.byteLength("<h1>привет</h1>", "utf8"), "размер файла не прочитан с диска");
        assert.strictEqual(h.opened.length, 1, "системный диалог не открывали");
        assert.ok(h.opened[0].opts.properties.includes("openFile"), "диалог спрашивает не файл: " + JSON.stringify(h.opened[0].opts));
        assert.ok(h.opened[0].parent && typeof h.opened[0].parent.isDestroyed === "function", "родителем диалога не передано окно");

        const cancelled = mk({ canceled: true });
        assert.strictEqual(await cancelled.handlers.get("cloud:pickFile")(fromWindow(cancelled), {}), null, "отмена выдана за выбор файла");
      })
    )
    .then(() =>
      test("выбор файла: без живого окна диалог всё равно открывается", async () => {
        const noWin = mk({ win: null });
        const r = await noWin.handlers.get("cloud:pickFile")(null, {});
        assert.strictEqual(r.path, FILE, "без живого окна выбор файла перестал работать");
        assert.strictEqual(noWin.opened[0].parent, undefined, "закрытое окно ушло родителем диалога");
      })
    )
    .then(() =>
      test("место сохранения: имя объекта предложено по умолчанию, отмена — null", async () => {
        const h = mk();
        const r = await h.handlers.get("cloud:pickSave")(fromWindow(h), { name: "app.js", startDir: work });
        assert.strictEqual(r.path, path.join(work, "saved.html"), "путь сохранения не отдан окну");
        assert.strictEqual(r.name, "saved.html", "имя сохранённого файла не отдано");
        assert.strictEqual(h.opened[0].kind, "save", "открыли не диалог сохранения");
        assert.strictEqual(h.opened[0].opts.defaultPath, path.join(work, "app.js"), "имя объекта не предложено по умолчанию: " + h.opened[0].opts.defaultPath);

        // Папка, которой больше нет, не должна ломать диалог: открываемся без неё.
        const gone = mk();
        await gone.handlers.get("cloud:pickSave")(fromWindow(gone), { name: "app.js", startDir: path.join(work, "нет-такой") });
        assert.strictEqual(gone.opened[0].opts.defaultPath, "app.js", "мёртвая папка всё-таки ушла в диалог: " + gone.opened[0].opts.defaultPath);

        const cancelled = mk({ canceled: true });
        assert.strictEqual(await cancelled.handlers.get("cloud:pickSave")(fromWindow(cancelled), {}), null, "отмена сохранения выдана за выбор пути");
      })
    )
    .then(() =>
      test("чужой рендерер не открывает ни один из диалогов", async () => {
        const h = mk();
        const a = await h.handlers.get("cloud:pickFile")(fromAlien(), {});
        const b = await h.handlers.get("cloud:pickSave")(fromAlien(), {});
        assert.ok(typeof a === "string" && /не из окна/.test(a), "чужому рендереру отдан выбор файла: " + JSON.stringify(a));
        assert.ok(typeof b === "string" && /не из окна/.test(b), "чужому рендереру отдано сохранение: " + JSON.stringify(b));
        assert.strictEqual(h.opened.length, 0, "диалог всё-таки открылся");
      })
    )
    .then(() =>
      test("модуль спрашивает путь и только: в облако не ходит и файлы не читает", () => {
        assert.ok(MODULE_SRC.indexOf("require(") === -1, "модуль что-то подтягивает сам");
        assert.ok(!/fetch\(/.test(MODULE_SRC), "модуль сам ходит в сеть");
        assert.ok(!/readFileSync\/writeFileSync|readFileSync|writeFileSync/.test(MODULE_SRC), "модуль читает или пишет содержимое файла");
        // Предел одного запроса живёт в yandex-cloud.js — второй копии быть не должно.
        assert.ok(!/S3_MAX_BYTES|\b64 \* 1024 \* 1024\b/.test(MODULE_SRC), "в модуле завелась вторая копия предела размера");
      })
    )
    .then(() =>
      test("телефону каналы закрыты с причиной, а не молчанием", () => {
        for (const ch of ["cloud:pickFile", "cloud:pickSave"]) {
          const at = BRIDGE_SRC.indexOf('"' + ch + '"');
          assert.ok(at > 0, "в мосте телефона нет причины для " + ch);
          assert.ok(/ПК/.test(BRIDGE_SRC.slice(at, at + 120)), "причина для " + ch + " не объясняет, почему нельзя с телефона");
        }
      })
    )
    .then(() =>
      test("проводка в main.js и цепочка npm test", () => {
        assert.ok(MAIN_SRC.includes('require("./cloud-files-ipc.js")'), "main.js не собирает модуль диалогов файла");
        const at = MAIN_SRC.indexOf('require("./cloud-files-ipc.js")');
        const wiring = MAIN_SRC.slice(at, MAIN_SRC.indexOf("\n});", at));
        for (const dep of ["ipcMain,", "dialog,", "path,", "fs,", "getWindow: () => mainWindow,", "ipcGuard,"]) {
          assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
        }
        assert.ok(!/ipcMain\.(handle|on)\("cloud:/.test(MAIN_SRC), "в main.js остались каналы файлов облака");
        assert.ok(String(PKG.scripts.test || "").indexOf("test/cloud-files-ipc.test.js") >= 0, "набора нет в цепочке npm test");
      })
    )
    .then(() => {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch (e) {
        /* временная папка — если уже удалена, это не ошибка */
      }
      console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
      process.exit(failed ? 1 : 0);
    });
})();

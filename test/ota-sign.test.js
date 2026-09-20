"use strict";

/* ── Подпись OTA-набора: sha256 мало, подпись обязана решать (src/ota-sign.js) ─
   Запуск: node test/ota-sign.test.js   (входит в общий `npm test`)

   Набор кода исполняется в приложении, поэтому здесь проверяется ровно то, на чём
   ошибка тихая и дорогая:

     • sha256 в манифесте ловит порчу файла, но НЕ подмену: манифест лежит рядом с
       набором, и свой manifest.json с хешем своего bundle.json сходится как ни в чём
       не бывало. Значит проверяется подпись — и проверяется ДО распаковки;
     • отказ обязан быть отказом с объяснением (какой ключ, что делать), иначе
       «обновление не ставится» выглядит поломкой и человек ищет причину не там;
     • пока доверенных ключей нет, наборы принимаются (иначе приложение осталось бы
       без обновлений вовсе) и о незакрытой дыре говорит панель;
     • закрытый ключ в репозиторий не попадает: в список доверенных едет только
       открытая часть.

   Проверки стендовые: ключи создаются на месте, в temp, и ничего не пишут в репозиторий. */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const otaSign = require(path.join(ROOT, "src", "ota-sign.js"));

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
const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    id: otaSign.keyId(publicKey.export({ type: "spki", format: "pem" }).toString()),
  };
}

// Набор как его собирает make-ota.js: bundle.json (строка) + манифест с хешем и подписью
function makeSignedBundle(dir, files, version, signer) {
  const f = {};
  for (const rel of Object.keys(files)) f[rel] = Buffer.from(files[rel], "utf8").toString("base64");
  const bundleJson = JSON.stringify({ version, files: f });
  const manifest = {
    app: "ai-agent",
    version,
    codeVersion: version,
    builtAt: Date.now(),
    files: Object.keys(f).length,
    sha256: crypto.createHash("sha256").update(bundleJson).digest("hex"),
    sig: signer ? otaSign.signBundle(bundleJson, signer.priv) : "",
    keyId: signer ? signer.id : "",
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bundle.json"), bundleJson, "utf8");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { manifest, bundleJson };
}

const FILES = { "src/main.js": "console.log(1);\n", "src/renderer/index.html": "<html></html>\n" };

// Окружение проверок: ключи задаются переменными, репозиторный файл не трогается
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

(async () => {
  console.log("Подпись OTA-набора: доверенные ключи, проверка и отказы");

  const A = keypair();
  const B = keypair();

  await test("отпечаток ключа: стабильный, короткий и разный у разных ключей", () => {
    const again = crypto.createPublicKey(A.pub).export({ type: "spki", format: "pem" }).toString();
    assert.strictEqual(otaSign.keyId(again), A.id, "отпечаток зависит от форматирования PEM");
    assert.notStrictEqual(A.id, B.id, "разные ключи дали одинаковый отпечаток");
    assert.strictEqual(otaSign.shortId(A.id).length, 16, "короткий отпечаток не 16 знаков");
    assert.ok(/^[0-9a-f]{16}$/.test(otaSign.shortId(A.id)), "отпечаток не hex: " + otaSign.shortId(A.id));
  });

  await test("разбор списка ключей: несколько ключей в одной строке, мусор не мешает", () => {
    const text = "перед ключом\n" + A.pub.trim() + "\nмежду\n" + B.pub.trim() + "\nпосле";
    const list = otaSign.parseKeys(text);
    assert.strictEqual(list.length, 2, "нашлось не два ключа: " + list.length);
    assert.deepStrictEqual(list.map((p) => otaSign.keyId(p)).sort(), [A.id, B.id].sort(), "разобрались не те ключи");
    assert.deepStrictEqual(otaSign.parseKeys("никаких ключей"), [], "мусор принят за ключ");
  });

  await test("доверенные ключи: переменная окружения важнее файла, пусто — значит никому", async () => {
    await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, () => {
      const keys = otaSign.trustedKeys();
      assert.strictEqual(keys.length, 1, "ключ из окружения не подхвачен: " + keys.length);
      assert.strictEqual(keys[0].id, A.id, "подхвачен не тот ключ");
      assert.strictEqual(keys[0].source, "env", "источник ключа не отмечен как окружение");
    });
    // Путь к файлу со списком — так ключ удобно держать вне проекта.
    const dir = tmpdir("ota-trust-");
    const file = path.join(dir, "keys.pem");
    fs.writeFileSync(file, A.pub + B.pub, "utf8");
    await withEnv({ AI_AGENT_OTA_TRUST: file }, () => {
      assert.strictEqual(otaSign.trustedKeys().length, 2, "файл со списком ключей не прочитан");
    });
    await withEnv({ AI_AGENT_OTA_TRUST: undefined }, () => {
      // В репозитории ключей пока нет: пустой список — это «проверять нечего», а не ошибка.
      const keys = otaSign.trustedKeys();
      assert.strictEqual(keys.filter((k) => k.source === "env").length, 0, "остался ключ из окружения");
      assert.ok(otaSign.unsignedAllowed(), "без доверенных ключей наборы перестали приниматься вовсе");
    });
  });

  await test("подпись: своя проходит, чужая и испорченная — нет", () => {
    const data = JSON.stringify({ version: "9.9.9", files: { "src/main.js": "AA==" } });
    const sig = otaSign.signBundle(data, A.priv);
    assert.ok(otaSign.verifySignature(data, sig, A.pub), "своя подпись не проверяется");
    assert.ok(!otaSign.verifySignature(data, sig, B.pub), "подпись принята чужим ключом");
    assert.ok(!otaSign.verifySignature(data + " ", sig, A.pub), "изменённые данные прошли по старой подписи");
    assert.ok(!otaSign.verifySignature(data, Buffer.from("мусор").toString("base64"), A.pub), "мусор принят за подпись");
    assert.ok(!otaSign.verifySignature(data, sig, "не ключ"), "неразобранный ключ не отклонён");
  });

  await test("checkBundle: подпись чужим ключом — отказ с указанием ключа и что делать", async () => {
    const { manifest, bundleJson } = makeSignedBundle(tmpdir("ota-sig-"), FILES, "9.9.9", B);
    await withEnv({ AI_AGENT_OTA_TRUST: A.pub, AI_AGENT_OTA_ALLOW_UNSIGNED: undefined }, () => {
      assert.throws(() => otaSign.checkBundle(bundleJson, manifest), /неизвестным ключом/);
      try {
        otaSign.checkBundle(bundleJson, manifest);
      } catch (e) {
        assert.ok(e.message.indexOf(otaSign.shortId(B.id)) >= 0, "в отказе нет отпечатка ключа набора");
        assert.ok(e.message.indexOf(otaSign.shortId(A.id)) >= 0, "в отказе нет списка доверенных ключей");
        assert.ok(/ota-trust/.test(e.message), "в отказе нет подсказки, куда добавить ключ");
      }
    });
    // Ключей нет вовсе, а набор подписан: доверять нечему — тоже отказ.
    await withEnv({ AI_AGENT_OTA_TRUST: undefined }, () => {
      assert.throws(() => otaSign.checkBundle(bundleJson, manifest), /доверенных ключей в приложении нет/);
    });
  });

  await test("checkBundle: без подписи при доверенных ключах — отказ, с явным разрешением — нет", async () => {
    const { manifest, bundleJson } = makeSignedBundle(tmpdir("ota-sig-"), FILES, "9.9.9", null);
    await withEnv({ AI_AGENT_OTA_TRUST: A.pub, AI_AGENT_OTA_ALLOW_UNSIGNED: undefined }, () => {
      assert.throws(() => otaSign.checkBundle(bundleJson, manifest), /не подписан/);
      try {
        otaSign.checkBundle(bundleJson, manifest);
      } catch (e) {
        assert.ok(/make-ota\.js/.test(e.message), "в отказе нет команды, как подписать набор");
      }
    });
    await withEnv({ AI_AGENT_OTA_TRUST: A.pub, AI_AGENT_OTA_ALLOW_UNSIGNED: "1" }, () => {
      const r = otaSign.checkBundle(bundleJson, manifest);
      assert.deepStrictEqual(r, { signed: false, keyId: "", trusted: false }, "послабление не сработало: " + JSON.stringify(r));
    });
  });

  await test("checkBundle: верная подпись проходит и называет ключ", async () => {
    const { manifest, bundleJson } = makeSignedBundle(tmpdir("ota-sig-"), FILES, "9.9.9", A);
    await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, () => {
      const r = otaSign.checkBundle(bundleJson, manifest);
      assert.strictEqual(r.signed, true, "подписанный набор не прошёл");
      assert.strictEqual(r.keyId, A.id, "проверка назвала не тот ключ");
      assert.strictEqual(r.trusted, true, "набор не признан доверенным");
    });
  });

  await test("checkBundle: подмена набора (свой манифест с верным хешем) отклоняется", async () => {
    const dir = tmpdir("ota-sig-");
    const { manifest, bundleJson } = makeSignedBundle(dir, FILES, "9.9.9", A);
    // Так выглядит атака в папке-источнике: набор подменён, манифест пересчитан.
    const evil = JSON.stringify({ version: "9.9.9", files: { "src/main.js": Buffer.from("зло();").toString("base64") } });
    manifest.sha256 = crypto.createHash("sha256").update(evil).digest("hex");
    await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, () => {
      // Хеш сходится — но подпись считалась от других байтов.
      assert.throws(() => otaSign.checkBundle(evil, manifest), /не сходится/);
      // И объяснение не должно врать: это не «неизвестный ключ», а испорченный набор.
      assert.strictEqual(otaSign.checkBundle(bundleJson.slice(0, 20) + bundleJson.slice(20), manifest).signed, true,
        "неизменённый набор перестал проверяться");
    });
  });

  await test("applyBundle: набор без доверенных ключей применяется, с ключами — только подписанный", async () => {
    const ota = require(path.join(ROOT, "src", "ota.js"));
    const root = tmpdir("ota-apply-");
    process.env.AI_AGENT_OTA_ROOT = root;
    try {
      // 1. Ключей нет — набор без подписи применяется, и это видно в version.json.
      const d1 = tmpdir("ota-src-");
      const s1 = makeSignedBundle(d1, FILES, "9.9.1", null);
      await withEnv({ AI_AGENT_OTA_TRUST: undefined }, async () => {
        const r = await ota.applyBundle(d1, s1.manifest);
        assert.ok(r.ok && r.version === "9.9.1", "набор без доверенных ключей не применился");
      });
      const v1 = JSON.parse(fs.readFileSync(path.join(ota.resolveCurrent(), "version.json"), "utf8"));
      assert.strictEqual(v1.signed, false, "набор без подписи записан как подписанный");
      assert.strictEqual(v1.keyId, "", "у набора без подписи отпечаток не пустой: " + v1.keyId);

      // 2. Ключ доверен, набор без подписи — отказ, и папки не тронуты.
      const d2 = tmpdir("ota-src-");
      const s2 = makeSignedBundle(d2, FILES, "9.9.2", null);
      await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, async () => {
        await assert.rejects(() => ota.applyBundle(d2, s2.manifest), /не подписан/);
      });
      const still1 = JSON.parse(fs.readFileSync(path.join(ota.resolveCurrent(), "version.json"), "utf8"));
      assert.strictEqual(still1.version, "9.9.1", "отклонённый набор всё-таки заменил применённый");

      // 3. Ключ доверен, набор подписан им — применяется, ключ записан.
      const d3 = tmpdir("ota-src-");
      const s3 = makeSignedBundle(d3, FILES, "9.9.3", A);
      await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, async () => {
        const r = await ota.applyBundle(d3, s3.manifest);
        assert.ok(r.ok && r.version === "9.9.3", "подписанный набор не применился");
      });
      const v3 = JSON.parse(fs.readFileSync(path.join(ota.resolveCurrent(), "version.json"), "utf8"));
      assert.strictEqual(v3.keyId, A.id, "применённый набор не помнит, каким ключом подписан");
      assert.strictEqual(v3.signed, true, "применённый подписанный набор записан как неподписанный");

      // 4. Ключ доверен, набор подписан ДРУГИМ ключом — отказ.
      const d4 = tmpdir("ota-src-");
      const s4 = makeSignedBundle(d4, FILES, "9.9.4", B);
      await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, async () => {
        await assert.rejects(() => ota.applyBundle(d4, s4.manifest), /неизвестным ключом/);
      });

      // 5. Хеш по-прежнему проверяется первым: порча файла так и называется.
      const d5 = tmpdir("ota-src-");
      const s5 = makeSignedBundle(d5, FILES, "9.9.5", A);
      s5.manifest.sha256 = "0".repeat(64);
      await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, async () => {
        await assert.rejects(() => ota.applyBundle(d5, s5.manifest), /Хеш/);
      });

      // 6. Статус: куда смотреть человеку.
      await withEnv({ AI_AGENT_OTA_TRUST: undefined }, () => {
        const st = ota.status({});
        assert.ok(st.trust && /не настроена/.test(st.trust.warning), "статус молчит про отсутствие подписи: " + JSON.stringify(st.trust));
      });
      await withEnv({ AI_AGENT_OTA_TRUST: A.pub }, () => {
        const st = ota.status({});
        assert.strictEqual(st.trust.keys, 1, "статус не видит доверенный ключ: " + JSON.stringify(st.trust));
        assert.strictEqual(st.trust.warning, "", "статус предупреждает, хотя ключ есть");
        assert.strictEqual(st.bundleKeyId, A.id, "статус не отдаёт ключ применённого набора");
      });
    } finally {
      delete process.env.AI_AGENT_OTA_ROOT;
    }
  });

  await test("сборка набора: подписывает, отказывается без ключа и умеет --unsigned", () => {
    const src = read("scripts", "make-ota.js");
    assert.ok(/otaSign\.signBundle\(bundleJson, key\.pem\)/.test(src), "сборщик не подписывает набор");
    assert.ok(/sig: sig,\s*\n\s*keyId: keyId,/.test(src), "подпись и отпечаток не попадают в манифест");
    assert.ok(/Нет ключа подписи/.test(src) && /process\.exit\(1\)/.test(src), "сборка без ключа не останавливается");
    assert.ok(/"--unsigned"/.test(src), "нет осознанного способа собрать набор без подписи");
    assert.ok(/app: "ai-agent"/.test(src), "набор собирается без имени приложения в манифесте");
    assert.ok(/ota:bundle/.test(src), "в подсказке нет npm-скрипта сборки");
  });

  await test("инструмент ключа: создаёт ключ у владельца, в список едет только открытая часть", () => {
    const key = read("scripts", "make-ota-key.js");
    assert.ok(/generateKeyPairSync\(\"ed25519\"\)/.test(key), "ключ не Ed25519");
    assert.ok(/mode: 0o600/.test(key), "закрытый ключ пишется доступным всем");
    assert.ok(/\.ai-agent-ota-key\.pem/.test(key), "нет ключа по умолчанию в домашней папке");
    assert.ok(/--trust/.test(key) && /OTA_TRUSTED_KEYS/.test(key), "нет способа доверить ключ приложению");
    assert.ok(!/copyFileSync|readFileSync\(KEY_PATH\)[\s\S]{0,80}TRUST_FILE/.test(key), "в список доверенных может попасть закрытый ключ");
    // Живая проверка: ключ создаётся, а в файл доверенных уходит только открытая часть.
    const dir = tmpdir("ota-key-");
    const trustFile = path.join(dir, "ota-trust.js");
    fs.copyFileSync(path.join(ROOT, "src", "ota-trust.js"), trustFile);
    const r = require("child_process").spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "make-ota-key.js"), "--key", path.join(dir, "key.pem"), "--trust"],
      { encoding: "utf8", env: Object.assign({}, process.env, { AI_AGENT_OTA_TRUST_FILE: trustFile }) }
    );
    assert.strictEqual(r.status, 0, "инструмент ключа упал: " + (r.stderr || r.stdout));
    const keyPem = fs.readFileSync(path.join(dir, "key.pem"), "utf8");
    const mode = fs.statSync(path.join(dir, "key.pem")).mode & 0o777;
    assert.strictEqual(mode, 0o600, "права закрытого ключа: " + mode.toString(8));
    assert.ok(/PRIVATE KEY/.test(keyPem), "в файле ключа не закрытый ключ");
    const trust = fs.readFileSync(trustFile, "utf8");
    assert.ok(/OTA_TRUSTED_KEYS: \[/.test(trust), "файл доверенных поломан: " + trust.slice(-160));
    assert.ok(trust.indexOf("PRIVATE KEY") < 0, "ЗАКРЫТЫЙ КЛЮЧ ПОПАЛ В РЕПОЗИТОРИЙ");
    assert.ok(otaSign.trustedKeys().length >= 0, "модуль доверия не читается");
    const pubs = otaSign.parseKeys(trust);
    assert.strictEqual(pubs.length, 1, "в список доверенных попал не один ключ: " + pubs.length);
    const openFromPrivate = crypto
      .createPublicKey(crypto.createPrivateKey(keyPem))
      .export({ type: "spki", format: "pem" })
      .toString();
    assert.strictEqual(otaSign.keyId(pubs[0]), otaSign.keyId(openFromPrivate), "в список попал не тот ключ");
    // Повторный запуск не плодит дубликаты.
    const again = require("child_process").spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "make-ota-key.js"), "--key", path.join(dir, "key.pem"), "--trust"],
      { encoding: "utf8", env: Object.assign({}, process.env, { AI_AGENT_OTA_TRUST_FILE: trustFile }) }
    );
    assert.strictEqual(again.status, 0, "повторный запуск упал: " + (again.stderr || again.stdout));
    assert.strictEqual(otaSign.parseKeys(fs.readFileSync(trustFile, "utf8")).length, 1, "повторный запуск добавил дубликат ключа");
  });

  await test("место в коде: подпись проверяется ДО распаковки, а панель говорит о ней человеку", () => {
    const ota = read("src", "ota.js");
    const check = ota.indexOf("otaSign.checkBundle(");
    const unpack = ota.indexOf("Распаковка во временную папку");
    assert.ok(check > 0, "src/ota.js не проверяет подпись набора");
    assert.ok(unpack > 0, "в src/ota.js не нашлось распаковки (проверка обесценилась бы)");
    assert.ok(check < unpack, "подпись проверяется ПОСЛЕ распаковки — файлы уже на диске");
    assert.ok(/trust: otaSign\.trustStatus\(\)/.test(ota), "статус не отдаёт состояние подписи");
    const panel = read("src", "renderer", "settings-panel.js");
    assert.ok(/st\.trust/.test(panel), "панель обновления молчит про подпись набора");
    const trust = read("src", "ota-trust.js");
    assert.ok(/OTA_TRUSTED_KEYS:\s*\[/.test(trust), "список доверенных ключей не объявлен");
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.scripts["ota:key"] && pkg.scripts["ota:bundle"], "нет npm-скриптов для ключа и сборки");
    assert.ok(/ota-sign\.test\.js/.test(pkg.scripts.test), "набор не в цепочке npm test");
  });

  console.log("\nПодпись OTA-набора: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

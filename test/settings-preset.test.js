"use strict";

/* ─── Настройки: определение пресета не затирает сохранённое ───────────────────
   Проверяется ровно одна тихая неправда, из-за которой «сохранённая модель сама
   сбрасывалась на другую»:

     • setPreset пишет адрес и модель пресета — это правильно для КЛИКА по чипу;
     • но openSettings звал setPreset только чтобы подсветить чип под сохранённый
       адрес, и заодно подставлял модель пресета (у groq, cerebras, ollamacloud,
       mistral она есть в PRESETS). Модель человека молча менялась, а следующее
       «Сохранить настройки» записывало чужую на диск.

   Теперь у setPreset есть opts.keepFields, а открытие настроек зовёт его с этим
   флагом. Тест держит оба конца: клик по чипу по-прежнему подставляет дефолты,
   открытие настроек — никогда. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "renderer", "settings-panel.js"), "utf8");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✅ " + name);
  } catch (e) {
    failed++;
    console.log("  ❌ " + name + "\n     " + (e && e.message));
  }
}

// Фальшивый DOM: любой id живёт одним элементом, поэтому «что записали, то и читаем».
// Панель настроек трогает десятки полей — придумывать каждое вручную смысла нет.
function fakeDom() {
  const byId = new Map();
  const el = (id) => {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        value: "",
        checked: false,
        textContent: "",
        className: "",
        type: "text",
        innerHTML: "",
        children: [],
        classList: {
          _s: new Set(),
          add(c) { this._s.add(c); },
          remove(c) { this._s.delete(c); },
          contains(c) { return this._s.has(c); },
          toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); },
        },
        appendChild(c) { this.children.push(c); },
        removeAttribute() {},
        focus() {},
        scrollIntoView() {},
      });
    }
    return byId.get(id);
  };
  const document = {
    getElementById: (id) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => el("__new_" + Math.random().toString(36).slice(2)),
    addEventListener() {},
  };
  return { el, document };
}

// Собираем НАСТОЯЩИЙ модуль настройки ТОЙ ЖЕ фабрикой, что и приложение.
function build(opts) {
  const o = opts || {};
  const d = fakeDom();
  const settings = o.settings || {
    openaiUrl: "https://api.deepseek.com",
    openaiModel: "моя-модель",
    openaiApiKey: "sk-x",
    provider: "openai",
  };
  const calls = { preset: [] };
  const sandbox = {
    module: { exports: {} },
    window: {},
    self: {},
    document: d.document,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(SRC, sandbox, { filename: "settings-panel.js" });
  const panel = sandbox.module.exports({
    $: d.el,
    api: {},
    isElectron: false,
    getSettings: () => settings,
    getPreset: () => o.preset || "deepseek",
    setCurrentPreset: (p) => calls.preset.push(p),
    setSbVersion() {},
    cachedModels: {},
    persistSettings() {},
    updateStatusBar() {},
    updateModelNeeded() {},
    refreshProject() {},
    toast() {},
    esc: (s) => String(s),
    renderGithubSection() {},
    probeG4fPort() {},
    renderG4fProviderList() {},
    search: { active: () => false, reset() {} },
    getLastTab: () => "model",
    setLastTab() {},
    getMobilePanel: () => ({ applyMobileFields() {}, readMobileFields() {} }),
    AgentCore: { roleById: (id) => ({ id: id || "coder" }), imageProviderLabel: () => "OpenRouter" },
    SecretsPanel: { renderEnvVars() {}, renderVault() {} },
    getYcPanel: () => ({ refreshSettingsUI() {} }),
    OpenaiProfiles: { render() {} },
    PRESETS: { deepseek: { url: "https://api.deepseek.com", model: "deepseek-chat" }, custom: null },
    PRESET_LABEL: { deepseek: "DeepSeek", custom: "Свой" },
    MODEL_KEY: { ollama: "ollamaModel", openai: "openaiModel", anthropic: "anthropicModel" },
    MODEL_INPUT: { ollama: "s-ollama-model", openai: "s-openai-model", anthropic: "s-anth-model" },
    URL_INPUT: { ollama: "s-ollama-url", openai: "s-openai-url", anthropic: "s-anth-url" },
    URL_KEY: { ollama: "ollamaUrl", openai: "openaiUrl", anthropic: "anthropicUrl" },
  });
  return { panel, el: d.el, settings, calls };
}

async function main() {
  console.log("Настройки: пресет не затирает сохранённую модель\n");

  await test("открытие настроек сохраняет адрес и модель человека", () => {
    const env = build();
    env.panel.openSettings("model");
    assert.strictEqual(env.el("s-openai-model").value, "моя-модель", "модель заменена на пресетную: " + env.el("s-openai-model").value);
    assert.strictEqual(env.el("s-openai-url").value, "https://api.deepseek.com", "адрес подменён: " + env.el("s-openai-url").value);
    // Пресет по сохранённому адресу всё равно подсвечен — это и надо было.
    assert.strictEqual(env.calls.preset[env.calls.preset.length - 1], "deepseek", "пресет не подсвечен");
  });

  await test("клик по чипу по-прежнему подставляет адрес и модель пресета", () => {
    const env = build({ settings: { openaiUrl: "https://api.openai.com/v1", openaiModel: "gpt-4o", provider: "openai" } });
    env.panel.setPreset("deepseek");
    assert.strictEqual(env.el("s-openai-url").value, "https://api.deepseek.com", "адрес пресета не подставился");
    assert.strictEqual(env.el("s-openai-model").value, "deepseek-chat", "модель пресета не подставилась");
  });

  await test("keepFields: подсветка без записи полей", () => {
    const env = build({ settings: { openaiUrl: "https://api.openai.com/v1", openaiModel: "gpt-4o", provider: "openai" } });
    env.panel.setPreset("deepseek", { keepFields: true });
    assert.strictEqual(env.el("s-openai-url").value, "", "адрес поля тронут при keepFields");
    assert.strictEqual(env.el("s-openai-model").value, "", "модель поля тронута при keepFields");
    assert.strictEqual(env.calls.preset[env.calls.preset.length - 1], "deepseek", "пресет не записан");
  });

  console.log("\nпрошло " + passed + ", упало " + failed);
  if (failed) process.exit(1);
}

main();

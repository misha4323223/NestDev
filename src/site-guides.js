"use strict";

/* ─── Справочники по сайтам (agent-guides) ───────────────────────────────────
   Вынесено из main.js (этап B, часть 11). Здесь живёт всё, что знает агент о
   сайтах и темах и что он умеет пополнять сам:

     • встроенные справочники лежат рядом с кодом (src/agent-guides/*.md),
       выученные агентом — в userData/agent-guides (их видно в окне приложения
       и они не теряются при обновлении кода);
     • в шапке файла может быть строка
       <!-- sites: console.cloud.google.com, cloud.google.com --> — по ней
       справочник подхватывается автоматически, когда агент открывает адрес;
     • agentGuideCall — действия инструмента agentGuide: list, match, read, save.
       Ошибка здесь тихая и обидная: агент либо не находит свой же маршрут, либо
       сохраняет его не туда, и следующий заход начинается с нуля.

   Живого состояния нет: путь к папке приложения приходит функцией (она известна
   только после старта Electron), папка встроенных справочников — аргументом. */

function createSiteGuides(deps) {
  const { fs, path, userDataDir, builtinDir } = deps;

function guideDirs() {
  return [path.join(userDataDir(), "agent-guides"), builtinDir];
}
function guideSafeName(raw) {
  return String(raw || "").trim().replace(/^agent-guide:/i, "").replace(/[^a-z0-9-_]/gi, "").toLowerCase();
}
function guideFilePath(name, forWrite) {
  const safe = guideSafeName(name);
  if (!safe) return "";
  if (forWrite) return path.join(guideDirs()[0], safe + ".md");
  for (const dir of guideDirs()) {
    const p = path.join(dir, safe + ".md");
    if (fs.existsSync(p)) return p;
  }
  return "";
}
function guideSitesOf(text) {
  const m = String(text || "").match(/<!--\s*sites:\s*([^>]+?)-->/i);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function guideTitleOf(text) {
  const m = String(text || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 80) : "";
}
function guideIndex() {
  const out = [];
  for (const dir of guideDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (out.some((g) => g.name === name)) continue; // выученный важнее встроенного
      let text = "";
      try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) { continue; }
      out.push({ name: name, title: guideTitleOf(text), sites: guideSitesOf(text), learned: dir === guideDirs()[0] });
    }
  }
  return out;
}
function guideReadText(name) {
  const p = guideFilePath(name, false);
  if (!p) return "";
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return ""; }
}
// Гайд по адресу: точный домен, затем по вхождению (console.cloud.google.com ← cloud.google.com).
function guideForUrl(url) {
  let host = "";
  try { host = String(new URL(url).hostname || "").toLowerCase().replace(/^www\./, ""); } catch (e) { host = ""; }
  if (!host) return null;
  const list = guideIndex();
  for (const g of list) {
    for (const s of g.sites) {
      if (host === s) return g;
    }
  }
  for (const g of list) {
    for (const s of g.sites) {
      if (host.endsWith("." + s) || s.endsWith("." + host)) return g;
    }
  }
  return null;
}
function agentGuideCall(args) {
  args = args || {};
  const action = String(args.action || (args.save ? "save" : args.name ? "read" : args.url ? "match" : "list")).toLowerCase();
  if (action === "list") {
    const list = guideIndex();
    if (!list.length) return "Справочников пока нет.";
    return (
      "Справочники агента (сайты и темы):\n" +
      list
        .map((g) => "• " + g.name + (g.title ? " — " + g.title : "") + (g.sites.length ? " [" + g.sites.join(", ") + "]" : "") + (g.learned ? " (мой, сохранён)" : ""))
        .join("\n") +
      "\nЧитать: agentGuide { name: \"google-cloud\" } — или readFile(path: \"agent-guide:google-cloud\").\n" +
      "Свой маршрут: after удачного прохода — agentGuide { save: \"сайт\", title: \"…\", steps: \"1) … 2) …\" }."
    );
  }
  if (action === "match") {
    const g = guideForUrl(args.url || args.site || "");
    if (!g) return "Для этого адреса справочника нет — ищи по DOM (browserSnapshot) и, пройдя путь, сохрани его: agentGuide { save: … }.";
    return "К этому сайту есть справочник «" + g.name + "»" + (g.title ? " (" + g.title + ")" : "") + ". Читай: agentGuide { name: \"" + g.name + "\" }.";
  }
  if (action === "read") {
    const name = guideSafeName(args.name || args.site || args.id);
    const text = guideReadText(name);
    if (!text) {
      const list = guideIndex().map((g) => g.name).join(", ") || "пусто";
      return "Ошибка: справочник «" + (name || "?") + "» не найден. Есть: " + list + ".";
    }
    return "СПРАВОЧНИК АГЕНТА: «" + name + "» (читай и следуй ему):\n\n" + text;
  }
  if (action === "save") {
    const name = guideSafeName(args.save === true || args.save === "true" ? args.name : args.name || args.save || args.site);
    const steps = String(args.steps || args.text || args.notes || "").trim();
    if (!name || !steps) {
      return "Ошибка agentGuide: для сохранения нужны name (сайт, латиницей) и steps — что и в каком порядке сработало (селекторы, подписи кнопок, подводные камни).";
    }
    const old = guideReadText(name);
    const body =
      "# " + (String(args.title || "").trim() || "Маршрут: " + name) + "\n" +
      (args.sites ? "<!-- sites: " + String(args.sites) + " -->\n" : "") +
      (old ? old.replace(/^[\s\S]*?\n---\n/, "") + "\n" : "") +
      "---\n## " + new Date().toISOString().slice(0, 10) + " — пройдено успешно\n" + steps + "\n";
    try {
      fs.mkdirSync(guideDirs()[0], { recursive: true });
      fs.writeFileSync(guideFilePath(name, true), body, "utf8");
    } catch (e) {
      return "Ошибка: не удалось сохранить справочник: " + String((e && e.message) || e).slice(0, 140);
    }
    return "OK — маршрут сохранён: agent-guides/" + name + ".md. В следующий раз я прочитаю его сразу (agentGuide { name: \"" + name + "\" }).";
  }
  return "agentGuide: неизвестное действие «" + action + "». Доступно: list, read (name), match (url), save (name + steps).";
}
  return { guideDirs, guideSafeName, guideFilePath, guideSitesOf, guideTitleOf, guideIndex, guideReadText, guideForUrl, agentGuideCall };
}

module.exports = { createSiteGuides };

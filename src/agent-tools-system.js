"use strict";

/* ─── Инструменты системы и установки ПО ───────────────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 5). Здесь живут девять обработчиков,
   которые смотрят на МАШИНУ, а не на проект:

     • getSystemInfo — визитка машины (ОС, процессор, память, диски, версии программ);
     • installSystemPackage / installExe / wingetSearch — установка ПО: пакетным
       менеджером или скачанным установщиком (с проверкой файла и предохранителями);
     • refreshEnv — перечитать PATH после установки;
     • listProcesses / killProcess — кто слушает порты и как это остановить;
     • registryRead / registryWrite — реестр Windows (только разрешённые ветки).

   Все помощники приходят в `deps` из system-stack.js: модуль сам ничего не достаёт
   и не держит состояния. Порядок инструментов в реестре сохранён ссылками — тела
   перенесены ПОБАЙТОВО (сверка `fn.toString()` до/после). */

function createSystemTools(deps) {
  const {
    path,
    fs,
    os,
    agentWorkDir,
    runTerminalCommand,
    spawnRaw,
    installSystemPkg,
    downloadFileTo,
    verifyInstaller,
    installerFacts,
    installerGate,
    findInstallersIn,
    downloadAndExtractTo,
    envPathInfo,
    findProgram,
    runProgVersion,
    psScript,
    cachedPs,
    invalidatePsCache,
    refreshEnvFromOS,
    truncateText,
    parseProcessesCsv,
    parseSysInfoJson,
    registryPathAllowed,
  } = deps;

  return {
    "getSystemInfo": async (args, settings) => {
        const rows = [];
        const osName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
        rows.push("ОС: " + osName + (process.arch ? " (" + process.arch + ")" : ""));
        rows.push("Версия Node.js (приложение): " + (process.version || ""));
        rows.push("Домашний каталог: " + os.homedir());
        rows.push("Рабочая директория агента: " + agentWorkDir(settings));
        rows.push("Записей в PATH: " + (envPathInfo().value || "").split(path.delimiter).filter(Boolean).length);
        rows.push("");
        // Расширенная информация: Windows — PowerShell/CIM, остальные — os.*
        if (process.platform === "win32") {
          const ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "$os=Get-CimInstance Win32_OperatingSystem; " +
            "$cpu=Get-CimInstance Win32_Processor; " +
            "$gpu=Get-CimInstance Win32_VideoController | Select-Object -First 1; " +
            "$ips=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | ForEach-Object { $_.IPAddress }); " +
            "$disks=@(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Root=$_.Root; UsedGB=[math]::Round($_.Used/1GB,1); FreeGB=[math]::Round($_.Free/1GB,1) } }); " +
            "[pscustomobject]@{ os=$os.Caption; build=$os.Version; cpu=$cpu.Name; gpu=$gpu.Name; ramGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1); ips=$ips; disks=$disks } | ConvertTo-Json -Compress -Depth 3";
          // CIM-запрос конфигурации ПК — самый дорогой в инструменте, а меняется
          // он раз в жизни машины: 30 с кэша снимают повторный обход системы.
          const siRaw = await cachedPs("sysinfo", 30000, async () => {
            const r = await psScript(ps, 30000);
            return r.ok ? r.out : "";
          });
          const si = parseSysInfoJson(siRaw);
          if (si.os) rows.push("Windows: " + si.os + (si.build ? " (build " + si.build + ")" : ""));
          if (si.cpu) rows.push("CPU: " + truncateText(si.cpu, 100));
          if (si.gpu) rows.push("GPU: " + truncateText(si.gpu, 100));
          if (si.ramGB) rows.push("RAM: " + si.ramGB + " ГБ");
          if (Array.isArray(si.ips) && si.ips.length) rows.push("IP-адреса (LAN): " + si.ips.join(", "));
          if (Array.isArray(si.disks) && si.disks.length) {
            rows.push("Диски:");
            for (const d of si.disks) {
              rows.push("• " + (d.Root || "?") + " — свободно " + (d.FreeGB != null ? d.FreeGB : "?") + " ГБ, занято " + (d.UsedGB != null ? d.UsedGB : "?") + " ГБ");
            }
          }
        } else {
          const cpus = os.cpus();
          if (cpus && cpus.length) rows.push("CPU: " + truncateText(cpus[0].model, 100) + " (" + cpus.length + " ядер)");
          rows.push("RAM: " + Math.round(os.totalmem() / 1024 / 1024 / 1024) + " ГБ всего, свободно " + Math.round(os.freemem() / 1024 / 1024 / 1024) + " ГБ");
          const ips = [];
          for (const k of Object.keys(os.networkInterfaces())) {
            for (const a of os.networkInterfaces()[k] || []) {
              if (a && a.family === "IPv4" && !a.internal && a.address && a.address.indexOf("127.") !== 0) ips.push(a.address);
            }
          }
          if (ips.length) rows.push("IP-адреса (LAN): " + ips.join(", "));
        }
        rows.push("");
        rows.push("Ключевые программы:");
        for (const n of ["git", "node", "npm", "python", "docker"]) {
          const f = findProgram(n);
          if (!f.found) rows.push("• " + n + ": не установлен");
          else {
            const v = await runProgVersion(f.path);
            rows.push("• " + n + ": " + (v || "установлен — " + f.path));
          }
        }
        // Установленные программы через winget (кратко: количество + первые 10)
        if (process.platform === "win32") {
          const w = await spawnRaw(["winget", "list", "--accept-source-agreements", "--disable-interactivity"], { cwd: os.homedir(), timeoutMs: 25000 });
          const wl = (w.out || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Name[ ]+Id[ ]+Version/i.test(l) && l.indexOf("---") !== 0 && !/^[0-9]+ package/i.test(l));
          if (wl.length) {
            rows.push("");
            rows.push("Установленные программы (winget, всего ~" + wl.length + "):");
            for (const l of wl.slice(0, 10)) rows.push("• " + l);
          }
        }
        rows.push("");
        rows.push("Советы: не установлено → installSystemPackage(имя) или wingetSearch(имя); не видно после установки → refreshEnv(); нужны права администратора → runCommandAsAdmin(команда); зависший процесс → listProcesses + killProcess; непонятная ошибка → explainError(код).");
        return rows.join("\n");
    },
    "installSystemPackage": async (args, settings) => {
        return await installSystemPkg(args.packageName);
    },
    "refreshEnv": async (args, settings) => {
        return await refreshEnvFromOS();
    },
    "listProcesses": async (args, settings) => {
        const filter = String(args.filter || "").trim().toLowerCase();
        let out = "";
        if (process.platform === "win32") {
          // Список процессов спрашивают подряд («сервер ещё жив?»): 2 с кэша
          // снимают повторный tasklist, а короткий TTL не показывает мёртвое.
          out = await cachedPs("proc:win", 2000, async () => {
            const r = await spawnRaw(["tasklist", "/FO", "CSV", "/NH"], { cwd: os.homedir(), timeoutMs: 20000 });
            return r.ok ? r.out : "";
          });
        } else {
          const r = await spawnRaw(["ps", "-eo", "pid=,comm=,%cpu=,rss=,args="], { cwd: os.homedir(), timeoutMs: 20000 });
          out = r.ok ? r.out : "";
        }
        let procs = parseProcessesCsv(out);
        if (filter) {
          procs = procs.filter((p) => (p.name || "").toLowerCase().indexOf(filter) !== -1 || (p.args || "").toLowerCase().indexOf(filter) !== -1);
        }
        procs = procs.slice(0, 60);
        if (!procs.length) return "Процессы не найдены" + (filter ? " по фильтру «" + filter + "»" : "") + ".";
        const head = "Процессы" + (filter ? " (фильтр «" + filter + "»)" : "") + " (" + procs.length + " из списка):\n";
        return head + procs.map((p) => {
          const mem = p.mem ? " " + p.mem : p.rss ? " " + Math.round(Number(p.rss) / 1024) + " КБ" : "";
          const argsPart = p.args ? "  «" + truncateText(p.args, 110) + "»" : "";
          return "• PID " + p.pid + " — " + (p.name || "") + mem + argsPart;
        }).join("\n") + "\n\nЗависший процесс завершай через killProcess(pid или name).";
    },
    "killProcess": async (args, settings) => {
        const pid = parseInt(args.pid, 10);
        const name = String(args.name || "").trim();
        const force = args.force === true || args.force === "true" || args.force === 1;
        if (!pid && !name) return "Ошибка: укажи pid (число из listProcesses) или name (например node).";
        let cmd, label;
        if (process.platform === "win32") {
          cmd = "taskkill " + (pid ? "/PID " + pid : "/IM " + name) + " /T" + (force ? " /F" : "");
          label = pid ? "PID " + pid : name;
        } else if (pid) {
          cmd = "kill " + (force ? "-9 " : "") + pid;
          label = "PID " + pid;
        } else {
          cmd = "pkill " + (force ? "-9 " : "-TERM ") + JSON.stringify(name);
          label = name;
        }
        const out = await runTerminalCommand(cmd, os.homedir(), 20000);
        invalidatePsCache("proc:"); // мы только что убили процесс — старый список не отдаём
        const failed = /не найден|ERROR|not found|No matching|No processes|кодом (1|128)/i.test(out);
        return (failed ? "Возможно, процесс уже завершён или не найден:\n" : "OK — процесс " + label + " завершён.\n") + "$ " + cmd + "\n\n" + out;
    },
    "registryRead": async (args, settings) => {
        if (process.platform !== "win32") return "Ошибка: реестр Windows доступен только на Windows.";
        const regPath = String(args.path || "").trim();
        const name = String(args.name || "").trim();
        const chk = registryPathAllowed(regPath, false);
        if (!chk.ok) return "Ошибка: " + chk.error;
        const esc = regPath.replace(/'/g, "''");
        let ps;
        if (name) {
          const escName = name.replace(/'/g, "''");
          ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "try { $v = Get-ItemPropertyValue -Path '" + esc + "' -Name '" + escName + "' -ErrorAction Stop; Write-Output (($v | Out-String).Trim()) } catch { Write-Output '__ERR__' }";
        } else {
          ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "$i = Get-Item -Path '" + esc + "' -ErrorAction SilentlyContinue; " +
            "if ($null -eq $i) { Write-Output '__ERR__' } else { $d = $i.GetValue(''); if ($null -eq $d) { Write-Output '(раздел без значения по умолчанию)' } else { Write-Output ('Значение по умолчанию: ' + $d) } }";
        }
        // Реестр читают часто, а пишут редко — 5 с кэша на путь+значение;
        // ошибку (нет раздела/нет прав) не кэшируем: её могут исправить сразу.
        const rr = await cachedPs(
          "reg:" + regPath + "|" + name,
          5000,
          async () => {
            const r = await psScript(ps, 20000);
            return { out: (r.out || "").trim(), err: r.err || "" };
          },
          (v) => /__ERR__|Cannot find|не найден|отказано/i.test(v.out)
        );
        const out = rr.out;
        if (out.indexOf("__ERR__") !== -1 || /Cannot find|не найден|отказано/i.test(out + rr.err)) {
          return "Раздел или значение не найдено: " + regPath + (name ? " → " + name : "") + ". Проверь путь — чтение разрешено только из SOFTWARE/ENVIRONMENT/SYSTEM/SECURITY.";
        }
        return "Реестр " + regPath + (name ? " → " + name : "") + ":\n" + out;
    },
    "registryWrite": async (args, settings) => {
        if (process.platform !== "win32") return "Ошибка: реестр Windows доступен только на Windows.";
        const regPath = String(args.path || "").trim();
        const name = String(args.name || "").trim();
        if (!name) return "Ошибка: укажи name (имя значения).";
        const value = String(args.value == null ? "" : args.value);
        const type = String(args.type || "REG_SZ").toUpperCase();
        if (["REG_SZ", "REG_DWORD", "REG_EXPAND_SZ"].indexOf(type) === -1) {
          return "Ошибка: type должен быть REG_SZ, REG_DWORD или REG_EXPAND_SZ.";
        }
        const chk = registryPathAllowed(regPath, true);
        if (!chk.ok) return "Ошибка: " + chk.error;
        const esc = regPath.replace(/'/g, "''");
        const escName = name.replace(/'/g, "''");
        const valPs = type === "REG_DWORD" ? String(Number(value) || 0) : value.replace(/'/g, "''");
        const ps =
          "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
          "$p = '" + esc + "';" +
          "New-Item -Path $p -Force | Out-Null;" +
          "New-ItemProperty -Path $p -Name '" + escName + "' -Value '" + valPs + "' -PropertyType " + type + " -Force | Out-Null;" +
          "Write-Output 'OK'";
        const r = await psScript(ps, 20000);
        if (!r.ok || (r.out || "").indexOf("OK") === -1) {
          return "Ошибка записи: " + (((r.err || "") + " " + (r.out || "")).trim() || "неизвестная причина") + " — проверь права (HKCU не требует админа) или путь.";
        }
        invalidatePsCache("reg:"); // запись сделана — кэш чтения реестра больше не верен
        return "OK — значение «" + name + "» = «" + value + "» (" + type + ") записано в " + regPath;
    },
    "wingetSearch": async (args, settings) => {
        if (process.platform !== "win32") return "Ошибка: winget доступен только на Windows.";
        const q = String(args.query || "").trim();
        if (!q) return "Ошибка: укажи query (например python, ffmpeg, ollama).";
        const r = await spawnRaw(["winget", "search", q, "--accept-source-agreements", "--disable-interactivity"], { cwd: os.homedir(), timeoutMs: 60000 });
        const out = (r.out || "").trim();
        if (!r.ok && !out) {
          return "winget недоступен: " + ((r.err || "").trim() || "код " + r.code) + ". Установи winget (Microsoft Store: «App Installer») или используй installSystemPackage — при отсутствии winget попробует choco/scoop.";
        }
        const lines = out.split("\n").filter((l) => l.trim() && !/^Name\s+Id\s+Version\s+Source/i.test(l));
        return "Результаты winget search «" + q + "»:\n\n" + (lines.slice(0, 25).join("\n") || out || "ничего не найдено") + "\n\nУстановка: installSystemPackage(\"" + q + "\") — если ID уникален, или укажи полный ID вида Vendor.Name из списка.";
    },
    "installExe": async (args, settings) => {
        const url = String(args.url || "").trim();
        const name = String(args.name || "").trim();
        if (!/^https?:\/\//i.test(url)) {
          return "Ошибка: укажи прямой URL установщика — .exe, .msi или .zip (https://...).";
        }
        const tmpDir = path.join(os.tmpdir(), "ai-agent-install");
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { return "Ошибка: не удалось создать временную папку: " + (e.message || String(e)); }
        // Расширение берём из URL без строки запроса и #якоря. Имя файла больше
        // НЕ форсируется в .exe — иначе .msi и .zip скачивались как «installer.exe».
        const pathOnly = url.split("#")[0].split("?")[0];
        const ext = (path.extname(pathOnly) || "").toLowerCase();
        const rawBase = (name || path.basename(pathOnly) || "installer").replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.+$/, "") || "installer";
        const withExt = /\.(exe|msi|zip|msix|appx)$/i.test(rawBase) ? rawBase : rawBase + (ext || ".exe");

        // .zip — не установщик, а архив (portable-сборки): распаковываем и ищем
        // внутри .exe/.msi, чтобы сразу предложить (или выполнить) установку.
        if (ext === ".zip") {
          const destDir = path.join(tmpDir, withExt.replace(/\.zip$/i, "") + "-files");
          const res0 = await downloadAndExtractTo(url, destDir);
          if (/^Ошибка/.test(res0)) return res0;
          const found = findInstallersIn(destDir);
          if (!found.length) {
            return "Архив распакован: " + destDir + "\nУстановщика (.exe/.msi/.bat/.cmd) внутри не нашлось — это portable-сборка, запускай файлы прямо оттуда.\n" + res0;
          }
          const first = found[0];
          if (args.run !== true) {
            return (
              "Архив распакован: " + destDir + "\nНайдены установщики:\n" +
              found.slice(0, 10).map((f, i) => "  " + (i + 1) + ") " + f).join("\n") +
              "\n\nЗапустить первый: installExe({ url: ..., run: true }) — или запусти нужный файл сам через runCommand."
            );
          }
          const vZip = await verifyInstaller(first, args.sha256);
          if (!vZip.ok) return vZip.error;
          const factsZip = installerFacts(first, vZip);
          const stopZip = installerGate(vZip, args);
          if (stopZip) return factsZip + "\n\n" + stopZip + "\n\nФайл остался лежать: " + first;
          const outZ = await runTerminalCommand('"' + first + '"', os.homedir(), 300000);
          return "Архив распакован: " + destDir + "\n" + factsZip + "\n$ \"" + first + "\"\n\n" + outZ;
        }

        // .msi ставится только msiexec (прямой запуск даёт «не является приложением»).
        if (ext === ".msi") {
          if (process.platform !== "win32") return "Ошибка: .msi ставится только в Windows (msiexec). Возьми .zip или сборку для этой ОС.";
          const destMsi = path.join(tmpDir, withExt);
          const dl = await downloadFileTo(url, destMsi);
          if (!dl.ok) return dl.error;
          const vMsi = await verifyInstaller(destMsi, args.sha256);
          if (!vMsi.ok) return vMsi.error;
          const factsMsi = installerFacts(destMsi, vMsi);
          const stopMsi = installerGate(vMsi, args);
          if (stopMsi) return factsMsi + "\n\n" + stopMsi;
          const silentMsi = String(args.silentArgs || "").trim() || "/passive /norestart";
          const cmdMsi = "msiexec /i \"" + destMsi + "\" " + silentMsi;
          const outM = await runTerminalCommand(cmdMsi, os.homedir(), 300000, "cmd");
          const looksFailedM = /кодом (?!0$)[0-9]+|Access is denied|отказано в доступе|требуется повышение|administrator|1603|1722/i.test(outM);
          return (
            "Установщик скачан: " + destMsi + " (" + Math.round(dl.size / 1024 / 1024) + " МБ)\n" +
            factsMsi + "\n" +
            "$ " + cmdMsi + "\n\n" + outM +
            (looksFailedM
              ? "\n\nmsiexec вернул ошибку (1603/1722 — установка не прошла). Часто нужны права администратора: runCommandAsAdmin(\"" + cmdMsi.replace(/"/g, "") + "\")."
              : "\n\nПроверь: checkInstalledProgram(\"" + (name || "программа") + "\").")
          );
        }

        // .exe и всё остальное — как раньше: скачать и запустить с тихими ключами.
        const silent = String(args.silentArgs || "").trim() || "/S";
        const dest = path.join(tmpDir, withExt);
        const dlx = await downloadFileTo(url, dest);
        if (!dlx.ok) return dlx.error;
        const vExe = await verifyInstaller(dest, args.sha256);
        if (!vExe.ok) return vExe.error;
        const factsExe = installerFacts(dest, vExe);
        const stopExe = installerGate(vExe, args);
        if (stopExe) return factsExe + "\n\n" + stopExe;
        const cmd = '"' + dest + '" ' + silent;
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        const looksFailed = /кодом [0-9]+|Access is denied|отказано в доступе|требуется повышение|administrator/i.test(out);
        return (
          "Установщик скачан: " + dest + " (" + Math.round(dlx.size / 1024 / 1024) + " МБ)\n" +
          factsExe + "\n" +
          "$ " + cmd + "\n\n" + out +
          (looksFailed
            ? "\n\nЕсли установка требует прав администратора — повтори через runCommandAsAdmin(\"" + cmd.replace(/"/g, "") + "\")."
            : "\n\nПроверь: checkInstalledProgram(\"" + (name || "программа") + "\").")
        );
    },
  };
}

module.exports = { createSystemTools };

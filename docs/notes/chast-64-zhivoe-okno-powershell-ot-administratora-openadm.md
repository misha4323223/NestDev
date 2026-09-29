## Часть 64: живое окно PowerShell от администратора (openAdminTerminal)

**Зачем.** `runCommandAsAdmin` выполняет РАЗОВУЮ команду и ждёт её конца, а вывод
админского окна приложение не перехватывает. Но агенту (и человеку) иногда нужен именно
ЖИВОЙ администраторский терминал — поработать в нём руками: доустановить, посмотреть,
покрутить настройки. Отдельного инструмента для этого не было.

**Что сделано.** Новый инструмент `openAdminTerminal` (необязательный `command`):
- `src/system-stack.js` — `adminTerminalPlan(platform, opts)` (ЧИСТАЯ функция: собирает
  argv запускателя) и `openAdminTerminal(opts)` (запускает план через `spawnRaw`).
  Windows: `Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList
  '-NoExit','-NoProfile','-ExecutionPolicy','Bypass'[,'-EncodedCommand', <b64>]` — окно
  остаётся открытым (`-NoExit`), запускатель БЕЗ `-Wait` возвращается сразу. Команда
  уезжает закодированной (base64 UTF-16LE), поэтому кавычки, пробелы и переводы строк в
  ней не ломают ArgumentList. План вынесен наружу отдельно: запрос UAC в тесте не нажать,
  поэтому набор проверяет план, а следствие (окно появилось) — дело живой проверки.
- macOS/Linux — ЧЕСТНЫЙ отказ со ссылкой на `runCommandAsAdmin` (там уже есть запрос
  прав): делать вид, что окно открылось, нельзя.
- Проводка как у `runCommandAsAdmin`: политика (`terminal.admin`, риск high,
  обязательное подтверждение + текст в `describe`), схема в `tool-schemas.js`, алиасы
  (`open_admin_terminal` / `admin_terminal` / `terminal_admin`) и группа «system» в
  `agent-core.js`, упоминание в `prompts.js`, обработчик в `agent-tools-run.js`, дом
  `agent-tools.js`, передача в `main.js` (две точки), проверка имени в
  `scripts/live-tools-run.js`.

**Грабли.** Запуск БЕЗ `-Wait` — это и есть отличие от `runCommandAsAdmin`: с `-Wait`
вызов висел бы, пока человек работает в окне. И таймаут запускателя короткий (120 с):
забытый или отклонённый запрос UAC иначе подвесил бы вызов на весь длинный таймаут.
Набор `test/admin-terminal.test.js` — 10 проверок (план, отказ на не-Windows, проводка).

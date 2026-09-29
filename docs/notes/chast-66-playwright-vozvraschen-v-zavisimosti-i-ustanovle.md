## Часть 66: Playwright возвращён в зависимости — и установлен

**Зачем.** Часть 65 убрала `backup-playwright/` из `.gitignore`, но сам пакет оставался
удалённым из проекта: в `dependencies` был только `electron-updater`, в `package-lock.json`
записей `playwright` / `playwright-core` не было, а `node_modules/` отсутствовал целиком.
Браузерные инструменты агента (`browser*`, `src/browser-tools.js`) требуют настоящий пакет —
без него автоматизация браузера мертва. Решено вернуть его ВЕЗДЕ: зависимость, лок, диск.

**Что сделано.**
- `package.json` — в `dependencies` снова `"playwright": "^1.49.1"`. Строку добавил
  `backup-playwright/restore.js` — именно ДОБАВИЛ, а не перезаписал файл снимком: скрипты и
  тесты частей 60–65 уцелели (ради этого фолбэк и переписывался в части 65).
- `package-lock.json` — `npm install --ignore-scripts` вернул записи `node_modules/playwright`,
  `node_modules/playwright-core` и строку в корневых `dependencies`: диф РОВНО 29 строк, ничего
  чужого не поехало.
- `node_modules/` — поставлен: 299 пакетов, 0 уязвимостей, `--ignore-scripts` (то есть БЕЗ
  скачивания браузеров Playwright — сотен мегабайт). Спека `^1.49.1` разрешилась в **1.63.0**.
- `electron-builder.yml` не трогали: `asarUnpack` для `playwright` / `playwright-core` стоял на
  месте с самого удаления (2c2a000) и остался.
- `test/repo-shape.test.js` — проверка РАЗВЁРНУТА: теперь она ТРЕБУЕТ, чтобы `playwright` был в
  `dependencies`, в `package-lock.json` (обе записи) и в `asarUnpack`; каталог
  `backup-playwright/` остаётся в репозитории как заготовка на случай повторного удаления.

**Грабли.** `npm install` БЕЗ `--ignore-scripts` дополнительно тянет браузеры Playwright — в этом
проекте так не делаем. И тот же урок, что в части 65: снимок `.bak` стареет, поэтому фолбэк
ДОБАВЛЯЕТ недостающую строку, а не копирует файл поверх — иначе правки частей 60–65 пропали бы.

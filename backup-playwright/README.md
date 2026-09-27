# backup-playwright — фолбэк удаления Playwright

**Статус на сейчас (часть 66): Playwright В ЗАВИСИМОСТЯХ.** В `package.json` снова
`"playwright": "^1.49.1"`, в `package-lock.json` — записи `playwright` / `playwright-core`,
пакет стоит в `node_modules` (собран с `--ignore-scripts`, без скачивания браузеров).
Браузерные инструменты агента (`browser*`) работают именно на нём.

Этот каталог **лежит в репозитории** (из `.gitignore` исключён специально): снимки и скрипт —
готовый набор на случай, если Playwright решат убрать СНОВА. Тогда по нему и удаление, и
возврат делаются в один шаг, из любого клона, а не только с одной машины.

## Что удалено из проекта (ровно 4 места, как в коммите `2c2a000`)

| Где | Что сделано |
|---|---|
| `package.json` | убрана строка `"playwright": "^1.49.1"` из `dependencies` |
| `package-lock.json` | пересобран командой `npm install --package-lock-only --ignore-scripts` — выпали записи `node_modules/playwright`, `node_modules/playwright-core` и строка в корневых `dependencies` |
| `node_modules/playwright`, `node_modules/playwright-core` | удалены с диска (на момент удаления их и не было) |
| `electron-builder.yml` | комментарий перефразирован; `asarUnpack: node_modules/playwright/**` и `playwright-core/**` **оставлены** |

**Код не тронут:** `src/browser-tools.js` (ленивый `require`), live-скрипты в `scripts/`
и тесты с подставным playwright — на месте. `bun.lock` Playwright не содержал и до
удаления (там 0 совпадений — это ожидаемо).

## Что лежит в папке

| Файл | Назначение |
|---|---|
| `restore.js` | скрипт-фолбэк: возвращает Playwright в проект |
| `package.json.bak` | снимок `package.json` **до** удаления — источник версии `^1.49.1` |
| `electron-builder.yml.bak` | снимок конфига сборки: возвращается, если из него пропали исключения `asarUnpack` |
| `package-lock.json.bak` | справочный снимок лока до удаления. `restore.js` его **не использует** — лок пересобирает сам `npm` |
| `README.md` | это описание |

Каталог `node_modules/playwright` отдельным архивом не бэкапится — он восстанавливается
через `npm install`.

## Как восстановить всё

Из корня проекта:

```bash
node backup-playwright/restore.js
```

Скрипт **не перезаписывает файлы вслепую** (иначе он стирал бы всё, что изменилось в
`package.json` после удаления playwright). Он именно добавляет недостающее:

1. **`package.json`** — вставляет `"playwright": "<версия из снимка>"` в `dependencies`,
   остальные поля и порядок ключей остаются как были; если playwright уже есть — шаг
   пропускается;
2. **`electron-builder.yml`** — возвращает снимок только если из конфига пропали
   исключения `asarUnpack` для playwright (обычно они на месте, и файл не трогается);
3. **`package-lock.json` + `node_modules`** — ставит пакет: `npm install --ignore-scripts`
   (лок обновляется сам; если сети нет — файлы всё равно готовы, установку можно
   повторить вручную).

Посмотреть план, ничего не меняя:

```bash
node backup-playwright/restore.js --dry-run
```

Только файлы, без установки:

```bash
node backup-playwright/restore.js --no-install
```

Проверка после восстановления:

```bash
grep -n playwright package.json package-lock.json electron-builder.yml
npm test
```

## Как удалить Playwright снова

Повторите 4 шага из таблицы выше, либо вручную:

```bash
# 1) строка "playwright": "^1.49.1" убирается из package.json
# 2) пересобрать лок:
npm install --package-lock-only --ignore-scripts
# 3) удалить пакеты с диска:
rm -rf node_modules/playwright node_modules/playwright-core
# 4) electron-builder.yml — asarUnpack оставить как есть
```

Перед повторным удалением обновите снимки в этой папке (`.bak`-файлы), чтобы фолбэк
оставался актуальным. Форма проверки, что фолбэк не потерялся, живёт в
`test/repo-shape.test.js` (каталог в репозитории, `.gitignore` его не прячет,
`restore.js` разбирается и отвечает на `--dry-run`).

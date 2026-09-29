## Часть 39, заход 3: сеть вкладки и покой — своим модулем (src/browser-net.js)

Третий шов. Кольцевой журнал запросов вкладки (`netRecorder` и константы
`NET_MAX`/`NET_POST_MAX`/`NET_STATIC`), инструмент `browserNetwork` и `browserWaitForIdle` уехали в
`src/browser-net.js` (193 строки). `browser-tools.js`: **2601 → 2446**.

**Зависимости — только мостом.** `network` зовёт `needTab` (сессия) и `maskForm` (он теперь в
`browser-replay.js`), `waitForIdle` — `needTab` и `sleep`. `needTab` и `sleep` приходят мостом
(`setBrowserNetDeps`), `maskForm`/`idle*InPage` — обычными require. Тела функций остались байт в байт.

**НАХОДКА (ловится только require, не `node --check`).** Мосты подключались в порядке «replay → net»,
и `setBrowserReplayDeps({ …, netRecorder })` вызывался РАНЬШЕ, чем `netRecorder` объявлялся как
`const` из `browser-net`. Это мёртвая зона (`ReferenceError: Cannot access 'netRecorder' before
initialization`) — модуль падал при загрузке, а `node --check` этого не видит: синтаксис цел.
Порядок исправлен: сначала `netRecorder`, потом мосты. **Правило на будущее:** после переноса с
мостами модуль надо не только `node --check`, но и `require`.

**Сверка ДО/ПОСЛЕ:** 64/64 функции совпали байт в байт. `npm test` — 64 набора, 1333 проверки,
0 падений. Живые: `test:boot`, `test:live:browser` — чисто.

**Негативный контроль** (файл восстановлен байт в байт, `sha256` тот же — `91de8425…`): в `network`
снял отсев статики. Покраснело и там, и там: сверка — «исходник network изменился»; набор — падение
«browserNetwork: что ушло на сервер и что он ответил».

**Что дальше.** Карта/наблюдение (`collectMap`/overlay*/поиск элементов) и прокрутка/догрузка
(`scroll`/`hover`/`loadAllScroll`/`revealText`) — своими модулями; ядро сессии (запуск, вкладки,
CDP, инструменты open/fill/click) остаётся в `browser-tools.js`.

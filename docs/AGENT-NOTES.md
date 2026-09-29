# Блокнот агента: индекс журнала работ

Полный текст каждой части лежит рядом, в `notes/`, по файлу на часть. Здесь
осталось только то, что нужно для навигации: что в журнале есть и куда идти за
подробностями. Так этот файл читается редактором и просматривается глазами, а не
ищется поиском по 1,5 МБ.

**Как этим пользоваться.** Сначала `HANDOFF.md` (состояние и правила), затем
`ARCHITECTURE.md` (где что лежит), и только потом — нужная часть журнала: в ней
«зачем» и «почему так», которых не видно в коде.

**Правило.** Текст частей не переписывается: файлы в `notes/` — это то, что
раньше лежало здесь, слово в слово. Что перенос ничего не потерял, проверяет
`test/docs.test.js`: он сверяет отпечаток содержимого всех файлов журнала.

**Часть 43** — [`notes/chast-43-poslednie-dva-mesta-bez-svoey-gruppy-processov-r.md`](notes/chast-43-poslednie-dva-mesta-bez-svoey-gruppy-processov-r.md) — уехала одним файлом, а
встроенный в неё начальный журнал проекта (174 раздела: версии 1.5.0 … 1.5.79,
заметки о проекте, инструментах и общении) разложен по разделам в
`notes/начальный-журнал/` — 9 файлов по 20 разделов.

## Части

| № | О чём | Полный текст | Строк |
|---:|---|---|---:|
| 80 | ключи доступа в карточке — по существующему адресу (404 на весь список) | [`notes/chast-80-klyuchi-dostupa-v-kartochke-po-sushchestvuyushchemu-adresu.md`](notes/chast-80-klyuchi-dostupa-v-kartochke-po-sushchestvuyushchemu-adresu.md) | 48 |
| 79 | карта файла в `smoke.test.js` и бегунок в конец — читается сверху вниз | [`notes/chast-79-karta-fayla-v-smoke-test-js-i-begunok-v-konec.md`](notes/chast-79-karta-fayla-v-smoke-test-js-i-begunok-v-konec.md) | 31 |
| 78 | журнал разложен по файлам: здесь индекс, тексты в `notes/` | [`notes/chast-78-zhurnal-razlozhen-po-faylam-indeks-vmesto-15-mb.md`](notes/chast-78-zhurnal-razlozhen-po-faylam-indeks-vmesto-15-mb.md) | 28 |
| 77 | документы переехали в `docs/`, а передача разгружена (этапы 0 и 1) | [`notes/chast-77-dokumenty-pereehali-v-docs-a-peredacha-razgruzhe.md`](notes/chast-77-dokumenty-pereehali-v-docs-a-peredacha-razgruzhe.md) | 8 |
| 76 | панель облака называет баланс тревожного счёта, а свёрнутая плитка — только «ошибка API» | [`notes/chast-76-panel-oblaka-nazyvaet-balans-trevozhnogo-scheta.md`](notes/chast-76-panel-oblaka-nazyvaet-balans-trevozhnogo-scheta.md) | 8 |
| 75 | действия облака в интерфейсе — машины, IAM, функции, деньги (`yc-actions.js`) | [`notes/chast-75-deystviya-oblaka-v-interfeyse-mashiny-iam-funkci.md`](notes/chast-75-deystviya-oblaka-v-interfeyse-mashiny-iam-funkci.md) | 51 |
| 74 | панель облака стала полкой сервисов — с их иконками, поиском и строкой здоровья | [`notes/chast-74-panel-oblaka-stala-polkoy-servisov-s-ih-ikonkami.md`](notes/chast-74-panel-oblaka-stala-polkoy-servisov-s-ih-ikonkami.md) | 71 |
| 73 | сайт открывается по https:// на своём домене — сертификат и Cloud CDN (`yc-cdn.js`) | [`notes/chast-73-sayt-otkryvaetsya-po-https-na-svoem-domene-serti.md`](notes/chast-73-sayt-otkryvaetsya-po-https-na-svoem-domene-serti.md) | 71 |
| 72 | деньги в облаке видно — баланс, пороги, живые цены и «хвосты» в рублях (`yc-billing.js`) | [`notes/chast-72-dengi-v-oblake-vidno-balans-porogi-zhivye-ceny-i.md`](notes/chast-72-dengi-v-oblake-vidno-balans-porogi-zhivye-ceny-i.md) | 58 |
| 71 | Cloud Functions видны, вызываются и выкатываются (`yc-functions.js`) | [`notes/chast-71-cloud-functions-vidny-vyzyvayutsya-i-vykatyvayut.md`](notes/chast-71-cloud-functions-vidny-vyzyvayutsya-i-vykatyvayut.md) | 74 |
| 70 | IAM виден и управляем — сервисные аккаунты, роли и ключи (`yc-iam.js`) | [`notes/chast-70-iam-viden-i-upravlyaem-servisnye-akkaunty-roli-i.md`](notes/chast-70-iam-viden-i-upravlyaem-servisnye-akkaunty-roli-i.md) | 46 |
| 69 | облако доведено до машин — сеть VPC (`yc-vpc.js`) и Compute (`yc-compute.js`) | [`notes/chast-69-oblako-dovedeno-do-mashin-set-vpc-yc-vpc-js.md`](notes/chast-69-oblako-dovedeno-do-mashin-set-vpc-yc-vpc-js.md) | 28 |
| 68 | прогон больше не «замолкает» — упавший шаг и оборванный поток названы вслух | [`notes/chast-68-progon-bolshe-ne-zamolkaet-upavshiy-shag-i-oborv.md`](notes/chast-68-progon-bolshe-ne-zamolkaet-upavshiy-shag-i-oborv.md) | 51 |
| 67 | план из чата становится планом миссии (карточка больше не пустая) | [`notes/chast-67-plan-iz-chata-stanovitsya-planom-missii-kartochk.md`](notes/chast-67-plan-iz-chata-stanovitsya-planom-missii-kartochk.md) | 47 |
| 66 | Playwright возвращён в зависимости — и установлен | [`notes/chast-66-playwright-vozvraschen-v-zavisimosti-i-ustanovle.md`](notes/chast-66-playwright-vozvraschen-v-zavisimosti-i-ustanovle.md) | 27 |
| 65 | фолбэк удалённого playwright — в репозитории (backup-playwright/) | [`notes/chast-65-folbek-udalennogo-playwright-v-repozitorii-backu.md`](notes/chast-65-folbek-udalennogo-playwright-v-repozitorii-backu.md) | 31 |
| 64 | живое окно PowerShell от администратора (openAdminTerminal) | [`notes/chast-64-zhivoe-okno-powershell-ot-administratora-openadm.md`](notes/chast-64-zhivoe-okno-powershell-ot-administratora-openadm.md) | 30 |
| 63 | окно контекста модели — задаётся вручную, кликом по чипу «Контекст» | [`notes/chast-63-okno-konteksta-modeli-zadaetsya-vruchnuyu-klikom.md`](notes/chast-63-okno-konteksta-modeli-zadaetsya-vruchnuyu-klikom.md) | 43 |
| 62 | прокси для внешних API — работа без VPN из России | [`notes/chast-62-proksi-dlya-vneshnih-api-rabota-bez-vpn-iz-rossi.md`](notes/chast-62-proksi-dlya-vneshnih-api-rabota-bez-vpn-iz-rossi.md) | 71 |
| 61 | у каждой роли — своя папка, а в ней PROMPT.md (по каждому проекту) | [`notes/chast-61-u-kazhdoy-roli-svoya-papka-a-v-ney-prompt.md`](notes/chast-61-u-kazhdoy-roli-svoya-papka-a-v-ney-prompt.md) | 33 |
| 60 | чекбоксы Яндекс.Облака больше не сбрасываются кнопкой «Сохранить» | [`notes/chast-60-chekboksy-yandeks-oblaka-bolshe-ne-sbrasyvayutsy.md`](notes/chast-60-chekboksy-yandeks-oblaka-bolshe-ne-sbrasyvayutsy.md) | 25 |
| 59 | просьба не по роли — агент ПРЕДЛАГАЕТ переключиться, а не молчит | [`notes/chast-59-prosba-ne-po-roli-agent-predlagaet-pereklyuchits.md`](notes/chast-59-prosba-ne-po-roli-agent-predlagaet-pereklyuchits.md) | 38 |
| 58 | бесплатные модели подсвечены у ЛЮБОГО провайдера + фильтр «только бесплатные» | [`notes/chast-58-besplatnye-modeli-podsvecheny-u-lyubogo-provayde.md`](notes/chast-58-besplatnye-modeli-podsvecheny-u-lyubogo-provayde.md) | 22 |
| 57 | список моделей провайдера виден ЦЕЛИКОМ — поиск вместо обрезки | [`notes/chast-57-spisok-modeley-provaydera-viden-celikom-poisk-vm.md`](notes/chast-57-spisok-modeley-provaydera-viden-celikom-poisk-vm.md) | 21 |
| 56 | таблицы у агента — настоящий Excel и Google Sheets (гибрид) | [`notes/chast-56-tablicy-u-agenta-nastoyaschiy-excel-i-google-she.md`](notes/chast-56-tablicy-u-agenta-nastoyaschiy-excel-i-google-she.md) | 53 |
| 55 | полный журнал действий агента — что он делал и что получил (для продакшена) | [`notes/chast-55-polnyy-zhurnal-deystviy-agenta-chto-on-delal-i-c.md`](notes/chast-55-polnyy-zhurnal-deystviy-agenta-chto-on-delal-i-c.md) | 29 |
| 54 | агент видел только начало вывода — обрезка теперь держит оба конца | [`notes/chast-54-agent-videl-tolko-nachalo-vyvoda-obrezka-teper-d.md`](notes/chast-54-agent-videl-tolko-nachalo-vyvoda-obrezka-teper-d.md) | 28 |
| 53 | агент больше не захлёбывается контекстом — честный учёт, ступени ужатия и памятка, которая заменяет | [`notes/chast-53-agent-bolshe-ne-zahlebyvaetsya-kontekstom-chestn.md`](notes/chast-53-agent-bolshe-ne-zahlebyvaetsya-kontekstom-chestn.md) | 60 |
| 52 | кнопку «▶ Продолжить» зажигает прогон — «продолжай» руками больше не нужен | [`notes/chast-52-knopku-prodolzhit-zazhigaet-progon-prodolzhay-ru.md`](notes/chast-52-knopku-prodolzhit-zazhigaet-progon-prodolzhay-ru.md) | 74 |
| 51 | таблицы базы YDB видны человеку — отношение в консоли облака (✅ сделано) | [`notes/chast-51-tablicy-bazy-ydb-vidny-cheloveku-otnoshenie-v-ko.md`](notes/chast-51-tablicy-bazy-ydb-vidny-cheloveku-otnoshenie-v-ko.md) | 64 |
| 50 | база YDB — таблицы и записи (инструмент ycDb) | [`notes/chast-50-baza-ydb-tablicy-i-zapisi-instrument-ycdb.md`](notes/chast-50-baza-ydb-tablicy-i-zapisi-instrument-ycdb.md) | 71 |
| 49 | публичный доступ к бакету + «Отправить» уезжала под панель | [`notes/chast-49-publichnyy-dostup-k-baketu-otpravit-uezzhala-pod.md`](notes/chast-49-publichnyy-dostup-k-baketu-otpravit-uezzhala-pod.md) | 124 |
| 48 | настройки стирались на старте — «Отправить» не работала совсем | [`notes/chast-48-nastroyki-stiralis-na-starte-otpravit-ne-rabotal.md`](notes/chast-48-nastroyki-stiralis-na-starte-otpravit-ne-rabotal.md) | 36 |
| 47 | файлы бакета Object Storage — посмотреть, положить, забрать и убрать | [`notes/chast-47-fayly-baketa-object-storage-posmotret-polozhit-z.md`](notes/chast-47-fayly-baketa-object-storage-posmotret-polozhit-z.md) | 71 |
| 46 | облако руками агента — версии секретов, записи DNS и чистка реестра | [`notes/chast-46-oblako-rukami-agenta-versii-sekretov-zapisi-dns.md`](notes/chast-46-oblako-rukami-agenta-versii-sekretov-zapisi-dns.md) | 28 |
| 45 | сохранённая модель сама сбрасывалась — три тихих пути | [`notes/chast-45-sohranennaya-model-sama-sbrasyvalas-tri-tihih-pu.md`](notes/chast-45-sohranennaya-model-sama-sbrasyvalas-tri-tihih-pu.md) | 37 |
| 44 | куда приложение кладёт работу агента — миссии, прогоны и дела | [`notes/chast-44-kuda-prilozhenie-kladet-rabotu-agenta-missii-pro.md`](notes/chast-44-kuda-prilozhenie-kladet-rabotu-agenta-missii-pro.md) | 99 |
| 43 | последние два места без своей группы процессов — runGit и spawnRaw | [`notes/chast-43-poslednie-dva-mesta-bez-svoey-gruppy-processov-r.md`](notes/chast-43-poslednie-dva-mesta-bez-svoey-gruppy-processov-r.md) | 82 |
| 34 | прогон агента и откат правок — свои каналы (1.5.189) | [`notes/chast-34-progon-agenta-i-otkat-pravok-svoi-kanaly-1-5.md`](notes/chast-34-progon-agenta-i-otkat-pravok-svoi-kanaly-1-5.md) | 83 |
| 35 | реестр агентских инструментов и вызов инструмента (1.5.190) | [`notes/chast-35-reestr-agentskih-instrumentov-i-vyzov-instrument.md`](notes/chast-35-reestr-agentskih-instrumentov-i-vyzov-instrument.md) | 329 |
| 36 | скриншоты страницы — своим модулем (src/screens.js) | [`notes/chast-36-skrinshoty-stranicy-svoim-modulem-src-screens-js.md`](notes/chast-36-skrinshoty-stranicy-svoim-modulem-src-screens-js.md) | 63 |
| 36 | сбор вывода одной командой — в bg-processes (src/bg-processes.js) | [`notes/chast-36-sbor-vyvoda-odnoy-komandoy-v-bg-processes-src-bg.md`](notes/chast-36-sbor-vyvoda-odnoy-komandoy-v-bg-processes-src-bg.md) | 60 |
| 36 | темп, строка облака, проверка записи и памятка — по домам | [`notes/chast-36-temp-stroka-oblaka-proverka-zapisi-i-pamyatka-po.md`](notes/chast-36-temp-stroka-oblaka-proverka-zapisi-i-pamyatka-po.md) | 284 |
| 38 | разбор `src/agent-store.js` на четыре модуля (21 сентября 2026) | [`notes/chast-38-razbor-src-agent-store-js-na-chetyre-modulya-21.md`](notes/chast-38-razbor-src-agent-store-js-na-chetyre-modulya-21.md) | 49 |
| 39 | функции страницы — своим модулем (src/browser-inpage.js) | [`notes/chast-39-funkcii-stranicy-svoim-modulem-src-browser-inpag.md`](notes/chast-39-funkcii-stranicy-svoim-modulem-src-browser-inpag.md) | 47 |
| 39 | replay и работа с формами — своим модулем (src/browser-replay.js) | [`notes/chast-39-replay-i-rabota-s-formami-svoim-modulem-src-brow.md`](notes/chast-39-replay-i-rabota-s-formami-svoim-modulem-src-brow.md) | 29 |
| 39 | сеть вкладки и покой — своим модулем (src/browser-net.js) | [`notes/chast-39-set-vkladki-i-pokoy-svoim-modulem-src-browser-ne.md`](notes/chast-39-set-vkladki-i-pokoy-svoim-modulem-src-browser-ne.md) | 28 |
| 39 | карта страницы и поиск элементов — своим модулем (src/browser-map.js) | [`notes/chast-39-karta-stranicy-i-poisk-elementov-svoim-modulem-s.md`](notes/chast-39-karta-stranicy-i-poisk-elementov-svoim-modulem-s.md) | 46 |
| 39 | прокрутка, наведение и догрузка — своим модулем (src/browser-scroll.js) | [`notes/chast-39-prokrutka-navedenie-i-dogruzka-svoim-modulem-src.md`](notes/chast-39-prokrutka-navedenie-i-dogruzka-svoim-modulem-src.md) | 66 |
| 40 | облачные инструменты агента — своим модулем (src/agent-tools-cloud.js) | [`notes/chast-40-oblachnye-instrumenty-agenta-svoim-modulem-src-a.md`](notes/chast-40-oblachnye-instrumenty-agenta-svoim-modulem-src-a.md) | 74 |
| 40 | git и GitHub — своим модулем (src/agent-tools-git.js) | [`notes/chast-40-git-i-github-svoim-modulem-src-agent-tools-git.md`](notes/chast-40-git-i-github-svoim-modulem-src-agent-tools-git.md) | 75 |
| 40 | файлы — чтение и поиск своим модулем (src/agent-tools-files.js) | [`notes/chast-40-fayly-chtenie-i-poisk-svoim-modulem-src-agent-to.md`](notes/chast-40-fayly-chtenie-i-poisk-svoim-modulem-src-agent-to.md) | 74 |
| 40 | файлы — запись и правки своим модулем (src/agent-tools-write.js). НАЙДЕН И ИСПРАВЛЕН БАГ | [`notes/chast-40-fayly-zapis-i-pravki-svoim-modulem-src-agent-too.md`](notes/chast-40-fayly-zapis-i-pravki-svoim-modulem-src-agent-too.md) | 87 |
| 40 | команды, оболочка и фоновые процессы (src/agent-tools-run.js) | [`notes/chast-40-komandy-obolochka-i-fonovye-processy-src-agent-t.md`](notes/chast-40-komandy-obolochka-i-fonovye-processy-src-agent-t.md) | 65 |
| 40 | таймаут команды гасит оболочку, а её дети живут | [`notes/chast-40-taymaut-komandy-gasit-obolochku-a-ee-deti-zhivut.md`](notes/chast-40-taymaut-komandy-gasit-obolochku-a-ee-deti-zhivut.md) | 45 |
| 40 | находка закрыта — таймаут гасит ДЕРЕВО (src/shell-tools.js) | [`notes/chast-40-nahodka-zakryta-taymaut-gasit-derevo-src-shell-t.md`](notes/chast-40-nahodka-zakryta-taymaut-gasit-derevo-src-shell-t.md) | 72 |
| 40 | система и установка ПО — своим модулем (src/agent-tools-system.js) | [`notes/chast-40-sistema-i-ustanovka-po-svoim-modulem-src-agent-t.md`](notes/chast-40-sistema-i-ustanovka-po-svoim-modulem-src-agent-t.md) | 40 |
| 40 | сеть и проверки доступности — своим модулем (src/agent-tools-net.js) | [`notes/chast-40-set-i-proverki-dostupnosti-svoim-modulem-src-age.md`](notes/chast-40-set-i-proverki-dostupnosti-svoim-modulem-src-age.md) | 42 |
| 40 | пояс проекта — своим модулем (src/agent-tools-memory.js) | [`notes/chast-40-poyas-proekta-svoim-modulem-src-agent-tools-memo.md`](notes/chast-40-poyas-proekta-svoim-modulem-src-agent-tools-memo.md) | 91 |
| 40 | миссии и план — своим модулем (src/agent-tools-mission.js) | [`notes/chast-40-missii-i-plan-svoim-modulem-src-agent-tools-miss.md`](notes/chast-40-missii-i-plan-svoim-modulem-src-agent-tools-miss.md) | 88 |
| 40 | остановки после ответа внешнего API и план, которого не было у миссии | [`notes/chast-40-ostanovki-posle-otveta-vneshnego-api-i-plan-koto.md`](notes/chast-40-ostanovki-posle-otveta-vneshnego-api-i-plan-koto.md) | 95 |
| 40 | окно и рабочий стол — своим модулем (src/agent-tools-app.js) | [`notes/chast-40-okno-i-rabochiy-stol-svoim-modulem-src-agent-too.md`](notes/chast-40-okno-i-rabochiy-stol-svoim-modulem-src-agent-too.md) | 60 |
| 40 | Часть 40, заход 9 — вложения и разработка своим модулем (`agent-tools-devtools.js`) | [`notes/chast-40-chast-40-zahod-9-vlozheniya-i-razrabotka-svoim-m.md`](notes/chast-40-chast-40-zahod-9-vlozheniya-i-razrabotka-svoim-m.md) | 76 |
| 40 | медиа, просмотр и справка — своим модулем (src/agent-tools-media.js) | [`notes/chast-40-media-prosmotr-i-spravka-svoim-modulem-src-agent.md`](notes/chast-40-media-prosmotr-i-spravka-svoim-modulem-src-agent.md) | 33 |
| 40 | пароли сайтов и почта — своим модулем (src/agent-tools-vault.js) | [`notes/chast-40-paroli-saytov-i-pochta-svoim-modulem-src-agent-t.md`](notes/chast-40-paroli-saytov-i-pochta-svoim-modulem-src-agent-t.md) | 42 |
| 40 | окружение агента и OTA — своим модулем (src/agent-tools-env.js) | [`notes/chast-40-okruzhenie-agenta-i-ota-svoim-modulem-src-agent.md`](notes/chast-40-okruzhenie-agenta-i-ota-svoim-modulem-src-agent.md) | 61 |
| 40 | браузер агента — своим модулем (src/agent-tools-browser.js) | [`notes/chast-40-brauzer-agenta-svoim-modulem-src-agent-tools-bro.md`](notes/chast-40-brauzer-agenta-svoim-modulem-src-agent-tools-bro.md) | 139 |
| 41 | контекст прогона — работа переживает паузу (src/run-context.js) | [`notes/chast-41-kontekst-progona-rabota-perezhivaet-pauzu-src-ru.md`](notes/chast-41-kontekst-progona-rabota-perezhivaet-pauzu-src-ru.md) | 50 |
| 42 | вопрос человеку действительно останавливает прогон (src/ask-wait.js) | [`notes/chast-42-vopros-cheloveku-deystvitelno-ostanavlivaet-prog.md`](notes/chast-42-vopros-cheloveku-deystvitelno-ostanavlivaet-prog.md) | 73 |

## Начальный журнал (внутри части 43)

| № | Разделы | Полный текст | Строк |
|---:|---|---|---:|
| 1 | Общение … Умное переключение ключей (1.5.15) | [`notes/начальный-журнал/01-obschenie-do-umnoe-pereklyuchenie-kly.md`](notes/начальный-журнал/01-obschenie-do-umnoe-pereklyuchenie-kly.md) | 250 |
| 2 | 1.5.16 — удобства из Replit: статус-бар, вкладки файлов с подсветкой, палитра команд … 1.5.38 — почему приложение «жевало» при печати (производительность интерфейса) | [`notes/начальный-журнал/02-1-5-16-udobstva-iz-replit-st-do-1-5-38-pochemu-prilozhen.md`](notes/начальный-журнал/02-1-5-16-udobstva-iz-replit-st-do-1-5-38-pochemu-prilozhen.md) | 880 |
| 3 | 1.5.39 — браузер: агент делает «сразу», а не ищет селекторы … 1.5.63 — агент снова работает с окном приложения: «продолжай» больше не выбивает схемы | [`notes/начальный-журнал/03-1-5-39-brauzer-agent-delaet-do-1-5-63-agent-snova-rabot.md`](notes/начальный-журнал/03-1-5-39-brauzer-agent-delaet-do-1-5-63-agent-snova-rabot.md) | 1068 |
| 4 | 1.5.64 — панель плана не появлялась: ReferenceError на «голом» имени функции ядра … 1.5.83 — installExe: скачать → проверить → показать → запустить | [`notes/начальный-журнал/04-1-5-64-panel-plana-ne-poyavl-do-1-5-83-installexe-skacha.md`](notes/начальный-журнал/04-1-5-64-panel-plana-ne-poyavl-do-1-5-83-installexe-skacha.md) | 1025 |
| 5 | 1.5.84 — секреты выдаются конкретному инструменту, а не всем командам сразу … Этап 3.1: быстрый запуск превью — свой модуль (1.5.103) | [`notes/начальный-журнал/05-1-5-84-sekrety-vydayutsya-ko-do-etap-3-1-bystryy-zapusk.md`](notes/начальный-журнал/05-1-5-84-sekrety-vydayutsya-ko-do-etap-3-1-bystryy-zapusk.md) | 1299 |
| 6 | Замер локальной модели: как его найти (1.5.104) … 1.5.135 — «версия кода» перестаёт врать, а старый набор — перекрывать свежий код | [`notes/начальный-журнал/06-zamer-lokalnoy-modeli-kak-eg-do-1-5-135-versiya-koda-per.md`](notes/начальный-журнал/06-zamer-lokalnoy-modeli-kak-eg-do-1-5-135-versiya-koda-per.md) | 1249 |
| 7 | Этап 3.8, часть 3: панель настроек — свой модуль (1.5.136) … Этап B, часть 5: настройки, подключения и история чатов уезжают в `settings-store.js` (1.5.154) | [`notes/начальный-журнал/07-etap-3-8-chast-3-panel-nastr-do-etap-b-chast-5-nastroyki.md`](notes/начальный-журнал/07-etap-3-8-chast-3-panel-nastr-do-etap-b-chast-5-nastroyki.md) | 1627 |
| 8 | Этап B, часть 6: пути и git уезжают из `main.js` своим модулем (1.5.155) … Этап B, часть 21: чтение файлов инструментами — свой модуль (1.5.174) | [`notes/начальный-журнал/08-etap-b-chast-6-puti-i-git-ue-do-etap-b-chast-21-chtenie.md`](notes/начальный-журнал/08-etap-b-chast-6-puti-i-git-ue-do-etap-b-chast-21-chtenie.md) | 1240 |
| 9 | Выкладка релиза одной командой (1.5.175) … Этап B, часть 33: каналы терминала, самообновления и выбора папки | [`notes/начальный-журнал/09-vykladka-reliza-odnoy-komand-do-etap-b-chast-33-kanaly-t.md`](notes/начальный-журнал/09-vykladka-reliza-odnoy-komand-do-etap-b-chast-33-kanaly-t.md) | 1057 |

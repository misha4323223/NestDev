# Прокси для AI-API (NestDev)

Маленький обратный прокси: приложение обращается к нему, а он пересылает запрос
к настоящему API и добавляет CORS. Нужен, чтобы работать из России без VPN.

## Почему старый адрес перестал работать

Раньше прокси жил на **Deno Deploy Classic** (`dash.deno.com`) — адрес вида
`https://late-partridge-8244.pimashin2016.deno.net`. Классику **отключили
20 июля 2026 года**. После отключения такие адреса отвечают ошибкой:

```
503: Service Unavailable (SUSPENDED)
This application is currently suspended.
Deno Deploy encountered an error while processing this request.
```

Это ответ **самой платформы Deno Deploy**, а не приложения NestDev: воркеру
больше негде выполняться. Поэтому в настройках и появляется
«Модели не загрузились: API error 503…».

## Как поднять заново (новый Deno Deploy)

1. Открой <https://console.deno.com> и войди через GitHub.
2. **New App** → выбери репозиторий `misha4323223/local-ai-agent`.
3. Укажи точку входа (entrypoint): `proxy/main.ts`.
   (Либо собери/задеплой из папки `proxy/` через `deployctl`.)
4. Дождись сборки и скопируй выданный адрес приложения.
5. В NestDev в настройках провайдера введи в поле «Базовый URL»:

   ```
   https://<адрес-приложения>.deno.net/https://router.bynara.id/v1
   ```

6. Нажми «Проверить подключение» — должен загрузиться список моделей.

## Если новый Deno Deploy из России недоступен

Тот же файл `main.ts` работает и на **Cloudflare Workers** (адаптер `fetch`), и на
любом другом хостинге, где есть `Deno.serve`/`fetch`. Тогда в поле «Базовый URL»
подставь адрес нового воркера по той же схеме
`<адрес-воркера>/https://router.bynara.id/v1`.

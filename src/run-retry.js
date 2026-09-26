"use strict";

/* ─── Восстановление прогона после отказа запроса (лимиты, сбои, переполнение) ──
   Вынесено из main.js (этап B, часть 16 — третий заход в ядро чата runAi).

   Здесь решается, что делать с НЕудовлетворительным ответом провайдера: подождать
   и повторить тот же раунд, выключить метрики токенов, ужать историю или честно
   остановиться с понятным объяснением. Ошибки тут тихие и дорогие:

     • не подождали лимит — раунд потерян, а человек пишет «продолжай» руками,
       хотя всё, что нужно, — подождать окно лимита (это и был дефект 1.5.67);
     • не сбросили счётчики на успехе — прогон «сдаётся» посреди работы;
     • «холодный» отказ пула (503 cache_only_cold) приняли за фатальную ошибку —
       хотя повтор того же запроса лечится попаданием в кэш;
     • не ужали контекст — на модели с малым окном прогон падает навсегда;
     • не выключили stream_options после отказа строгого сервера — каждый раунд
       падает по кругу на одном и том же месте;
     • оборванную связь (ответа не было вовсе) приняли за фатальную ошибку —
       хотя она лечится ожиданием и повтором того же раунда (transport).

   Живые значения приходят мостами: бюджет контекста — функциями (он ужимается
   здесь же), ужатие истории — обратным вызовом (история и контекст-менеджер
   живут в прогоне), лимитер провайдера — общим объектом (один на провайдера). */

function createRunRetry(deps) {
  const {
    settings,
    provider,
    emit,
    termEmit,
    rateLimiter,
    // Бюджет контекста и ужатие истории: при переполнении окна раунд повторяется
    // с резко урезанной историей. Формула и пересборка списка — в прогоне.
    getBudget,
    shrinkContext,
    // Функции ядра — именами, как их зовёт прогон.
    friendlyRateLimitError,
    rateLimitInfo,
    coldCacheInfo,
    UNAVAILABLE_MAX,
  } = deps;

  const state = {
    // stream_options.include_usage: провайдер отдаёт токены/кэш только по флагу,
    // строгий сервер может его не знать. Выключаем на весь запуск, а не «на раунд».
    includeUsage: true,
    // reasoning_effort / think — наша добавка из плашки Reasoning. Строгая сборка
    // может такого поля не знать: тогда выключаем его на весь запуск и повторяем.
    reasoning: true,
    rateRetries: 0, // сколько раз ждали лимит 429 в этом запуске
    rateWaitedMs: 0, // и сколько всего секунд простояли
    unavailableRetries: 0, // повторы «холодного» отказа пула / 5xx
    contextRetried: false, // переполнение контекста лечим один раз
  };
  // Пауза внедряемая: ожидание лимита — часть решения, и её надо уметь проверить,
  // не высиживая десятки секунд в тестах.
  const pause = deps.pause || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Сколько всего разрешено простоять в ожидании лимита (429) за один запуск. Три паузы
  // по 5 с лимит «8 запросов в минуту» не лечат: раньше прогон падал, и пользователь
  // писал «продолжай» руками. Ждём сами, но с потолком — чтобы не висеть вечно.
  const RATE_WAIT_BUDGET_MS =
    deps.rateWaitBudgetMs != null ? deps.rateWaitBudgetMs : Math.max(60000, Number(process.env.AI_AGENT_RATE_WAIT_MS) || 10 * 60 * 1000);

  // Темп: если лимит провайдера уже известен, пауза выдерживается ЗАРАНЕЕ, а не после
  // отказа. Это главный выигрыш по времени: 429 — потерянный раунд.
  const pace = async () => {
    const paced = await rateLimiter.take();
    if (paced > 800) {
      termEmit({
        type: "metrics",
        text: "⏳ Держу темп провайдера: пауза " + Math.round(paced / 1000) + " с перед запросом (лимит уже известен).",
      });
    }
    return paced;
  };

  // Успешный ответ снимает счётчики отказов: иначе прогон «сдался бы» на первой
  // же неудаче после часа работы.
  const noteSuccess = () => {
    state.rateRetries = 0;
    state.unavailableRetries = 0;
  };

  // Что делать с отказом. Возвращает { kind: "repeat" } (раунд повторяется) либо
  // { kind: "throw", error } — фатальная ошибка с человеческим текстом.
  // Подождать успевает сама: ожидание — часть решения, а не отдельный шаг прогона.
  const plan = async (failure) => {
    const status = failure.status;
    const detail = String(failure.detail == null ? "" : failure.detail);
    const repeat = (what) => ({ kind: "repeat", what: what });

    // Строгий OpenAI-совместимый сервер может не знать stream_options (мы просили им
    // токены и кэш). Это не ошибка пользователя: выключаем флаг и повторяем раунд.
    if (
      state.includeUsage &&
      (status === 400 || status === 422) &&
      /stream_options|include_usage|unknown|unrecognized|unsupported|extra|invalid/i.test(detail) &&
      !/context|too long|maximum|num_ctx/i.test(detail)
    ) {
      state.includeUsage = false;
      termEmit({
        type: "metrics",
        text: "Провайдер не понял stream_options.include_usage — отключаю (запрос без метрик токенов).",
      });
      return repeat("usage-off");
    }

    // Рассуждения (reasoning_effort / think) — наша добавка из плашки Reasoning.
    // Совместимая сборка может такого поля не знать: выключаем его и повторяем раунд
    // один раз. Отдельным условием, а не вместе с метриками: за один повтор меняем
    // одно поле, иначе непонятно, что именно помогло.
    if (
      state.reasoning &&
      (status === 400 || status === 422) &&
      // Только слова про само поле рассуждений. Общие «unknown / unsupported» здесь
      // намеренно НЕ ловятся: под них попадает и отказ из-за stream_options, а он
      // лечится выше — иначе один и тот же отказ крутился бы бесконечно.
      /reasoning|\bthink\b/i.test(detail)
    ) {
      state.reasoning = false;
      termEmit({
        type: "metrics",
        text: "Провайдер не понял настройку рассуждений — отключаю её (запрос без reasoning_effort).",
      });
      // Окно запоминает отказ ПО МОДЕЛИ и убирает плашку 🧠 (chat-events → reasoning.js):
      // иначе каждый новый запуск платил бы одним отклонённым раундом заново, хотя
      // ответ уже известен — эта конкретная сборка такого поля не знает.
      emit({ type: "reasoning_unsupported", key: provider + "|" + String(settings.model || "") });
      return repeat("reasoning-off");
    }

    // Лимиты провайдера (Groq free ~7K токенов/мин): понятное объяснение вместо сырого
    // JSON. Проверяем ДО повтора: у Groq лимит по токенам, повтор бессмысленен — там
    // свой совет. Порядок важен, и он же проверяется в тестах.
    const friendly = friendlyRateLimitError(status, detail, settings);
    if (friendly) return { kind: "throw", error: new Error(friendly) };

    // 429 (лимит запросов): ждём столько, сколько просил провайдер, и повторяем ТОТ ЖЕ
    // раунд. Ждём САМИ — до потолка rateWaitBudgetMs. Раньше после трёх коротких пауз
    // прогон падал с ошибкой, и пользователю приходилось писать «продолжай» вручную —
    // хотя всё, что нужно, это подождать окно лимита.
    if (status === 429) {
      const info = rateLimitInfo(status, failure.headers, detail);
      rateLimiter.note(info);
      const wantMs = Math.max(2000, Math.min(info.retryMs || 5000, 60000));
      const leftMs = RATE_WAIT_BUDGET_MS - state.rateWaitedMs;
      if (leftMs < 1000) {
        return {
          kind: "throw",
          error: new Error(
            "API error 429: лимит провайдера на запросы. Ждал сам " + Math.round(state.rateWaitedMs / 1000) +
            " с, но лимит не отпускает — подожди минуту и напиши «продолжай» или выбери модель " +
            "с большим лимитом в настройках."
          ),
        };
      }
      const waitMs = Math.min(wantMs, leftMs);
      state.rateRetries++;
      state.rateWaitedMs += waitMs;
      const sec = Math.max(1, Math.round(waitMs / 1000));
      const note =
        "⏳ Лимит провайдера на запросы: жду " + sec + " с и повторю сам (попытка " + state.rateRetries + ")" +
        (info.rpm ? ", лимит ≈" + Math.round(info.rpm) + " запросов/мин" : "") +
        ". Писать ничего не нужно.";
      termEmit({ type: "metrics", text: note + " Всего в ожидании: " + Math.round(state.rateWaitedMs / 1000) + " с." });
      // Пользователь должен видеть, что прогон жив и ждёт сам.
      emit({ type: "notice", text: note });
      await pause(waitMs);
      if (waitMs >= 15000) emit({ type: "notice", text: "▶ Продолжаю работу после лимита." });
      return repeat("rate");
    }

    // 503 и cache_only_cold: пул провайдера отклонил «холодный» запрос (принимает
    // только попадание в кэш) или перегружен. Раньше это падало сырым JSON провайдера,
    // хотя лечится повтором того же раунда: историю мы не переписываем, поэтому повтор
    // уже может попасть в кэш. Смена ключа внутри того же пула не поможет.
    const cold = coldCacheInfo(status, detail, state.unavailableRetries + 1);
    if (cold) {
      if (state.unavailableRetries < UNAVAILABLE_MAX) {
        state.unavailableRetries++;
        termEmit({ type: "metrics", text: cold.text });
        await pause(cold.waitMs);
        return repeat("cold");
      }
      return {
        kind: "throw",
        error: new Error(
          cold.cold
            ? "API error 503 cache_only_cold: провайдер принимает только запрос с готовым кэшем. " +
              "Повторил " + UNAVAILABLE_MAX + " раза — пул всё ещё отказывает. Подожди 10–30 с и напиши «продолжай» " +
              "или выбери другую модель/тариф: смена ключа внутри того же бесплатного пула не поможет."
            : cold.why === "body"
            ? "API error " + status + ": провайдер не смог прочитать тело запроса (обрыв на его стороне). " +
              "Повторил " + UNAVAILABLE_MAX + " раза — подожди немного и напиши «продолжай». " +
              "Если это повторяется на каждом шаге, выбери другую модель или провайдера в настройках."
            : "API error " + status + ": провайдер временно недоступен. Повторил " + UNAVAILABLE_MAX +
              " раза — подожди немного и напиши «продолжай»."
        ),
      };
    }

    // Переполнение контекста (частая беда локальных моделей Ollama с малым окном):
    // один раз повторяем запрос с резко урезанной историей, чтобы не падать.
    if (!state.contextRetried && /context|too long|maximum|num_ctx|token/i.test(detail) && getBudget() > 3000) {
      state.contextRetried = true;
      await shrinkContext();
      return repeat("context");
    }

    // 402 = Insufficient Balance: у провайдера кончились деньги. Подсказываем по-русски.
    if (status === 402) {
      return {
        kind: "throw",
        error: new Error(
          "API error 402: Недостаточно средств на балансе провайдера (" + (settings.provider || "openai") +
          "). Пополни счёт или выбери другого провайдера/модель в настройках."
        ),
      };
    }
    return { kind: "throw", error: new Error("API error " + status + ": " + detail) };
  };

  // ── Оборванная связь: ответа с кодом нет вообще ─────────────────────────────
  // Второй вид «остановки после обращения к внешнему сервису»: запрос ушёл, а ответа
  // не было — сеть моргнула (ECONNRESET/EPIPE/ETIMEDOUT), прокси закрыл поток,
  // «fetch failed» с сорванным сокетом. Раньше это роняло прогон С ПЕРВОЙ ПОПЫТКИ:
  // человек видел «Сетевая ошибка…» и писал «продолжай» руками — хотя достаточно
  // было подождать пару секунд и повторить тот же раунд. Здесь повтор тот же, а
  // фатальный текст остаётся понятным.
  //
  // Посторонние ошибки НЕ перехватываются: неверный адрес, неизвестный хост, отказ в
  // соединении и ошибки сертификата не лечатся ожиданием — про них говорим сразу.
  const TRANSIENT_NET = /fetch failed|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|other side closed|premature close|terminated|UND_ERR/i;
  const FATAL_NET = /ENOTFOUND|EAI_NONAME|ECONNREFUSED|ERR_INVALID_URL|ERR_TLS|CERT_|UNABLE_TO_VERIFY/i;
  // Свой график пауз: сеть моргает быстрее, чем перегруженный пул провайдера.
  const NET_WAITS = [2000, 5000, 10000];
  const transport = async (err) => {
    if (!err || err.name === "AbortError") return null;
    const cause = err.cause || null;
    const text = [err.message, cause && (cause.code || cause.message), err.code].filter(Boolean).join(" · ");
    if (!text || FATAL_NET.test(text) || !TRANSIENT_NET.test(text)) return null;
    if (state.unavailableRetries < UNAVAILABLE_MAX) {
      state.unavailableRetries++;
      const waitMs = NET_WAITS[Math.min(NET_WAITS.length - 1, state.unavailableRetries - 1)];
      termEmit({
        type: "metrics",
        text: "⏳ Связь с провайдером оборвалась. Жду " + Math.round(waitMs / 1000) + " с и повторяю тот же раунд.",
      });
      await pause(waitMs);
      return { kind: "repeat" };
    }
    return {
      kind: "throw",
      error: new Error(
        "Сетевая ошибка при запросе к " + provider + ": " + text + ". Повторил " + UNAVAILABLE_MAX +
        " раза — подожди немного и напиши «продолжай»; если повторяется, проверь соединение или выбери другого провайдера."
      ),
    };
  };

  return { state: state, pace: pace, noteSuccess: noteSuccess, plan: plan, transport: transport, provider: provider };
}

module.exports = { createRunRetry };

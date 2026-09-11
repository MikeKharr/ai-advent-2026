// Агент «аналитик новостей»: один запуск — одна цепочка стадий с событием
// на каждую (ADR 2026-09-09-0854, п. 4). Заголовки — глаголом совершенного
// вида, не длиннее 60 знаков; детали — одна строка, длинное — с новой
// строки, страница покажет его в раскрытии.
//
// Никогда не бросает: любая ошибка — терминальное событие и статус
// `failed`. Уронить запуск молча значит оставить страницу в «выполняется».

import { randomUUID } from 'node:crypto'
import {
  articlesThatFit,
  askRouter,
  askSummary,
  buildSummaryRequest,
  effectiveBudget,
  effectiveContext,
  fetchLimits,
  fitDialog,
  fitToBudget,
  guardLinks,
  estimateTokens,
  requestTokens,
  SUMMARY_CLASS,
  SUMMARY_PROVIDER,
} from './llm.js'
import {
  budgetFor,
  inputBudgetFor,
  MODELS,
  PARAM_LIMITS,
  PROMPT_PRESETS,
  isSessionId,
  parseParams,
  parseSphere,
  parseSummarizeAt,
  parseSystem,
} from './params.js'
import { TERMINAL } from './runs.js'

/**
 * Сколько последних реплик пользователя участвуют в отборе статей. Больше
 * трёх — и слова давнего поворота разговора начинают перевешивать нынешний
 * вопрос; меньше — теряется тема, названная парой сообщений раньше.
 */
const RECENT_USER_MESSAGES = 3

/**
 * Верхняя граница подборки, когда число статей не задано. Это не предел
 * ответа, а защита от бессмысленной работы: реально ограничивают потолок
 * на издание (восемь лент по пять статей) и предел входа модели.
 */
const FILL_LIMIT = 200

/** «2.0 с» / «320 мс» — для деталей события; страница форматирует сама. */
function seconds(ms) {
  return ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(1)} с`
}

/**
 * Отказ роутера, не дошедший до провайдера, денег не стоил: день по этому
 * признаку возвращает слот лимитера, иначе поток отказов выест суточный
 * предел зря.
 */
function paidNothing(error) {
  return (
    error.code === 'budget_exceeded' ||
    error.code === 'refused' ||
    error.code === 'no_provider' ||
    (Array.isArray(error.attempts) && error.attempts.length === 0) ||
    (error.status >= 400 && error.status < 500 && error.status !== 429)
  )
}

/** Текст отказа роутера для пользователя — как в дне 5. */
function explainRouterError(error) {
  if (error.code === 'budget_exceeded') {
    // Роутер отвечает так и когда остаток есть, но запрос в него не влез:
    // «попробуйте завтра» было бы неправдой — хватит меньшей подборки.
    return /не помещается/.test(error.message)
      ? 'Запрос слишком большой для остатка суточного лимита. Уменьшите статей на издание или контекст.'
      : 'Суточный лимит расхода приложения исчерпан, попробуйте завтра.'
  }
  return `Модель не ответила: ${error.message}`
}

export function createNewsAnalyst({
  agent,
  archive,
  runs,
  env,
  sessions = null,
  fetchImpl = fetch,
  now = Date.now,
  log = console.error,
}) {
  // Промпт из реестра — основа; запуск может прийти со своим (см. parseSystem).
  const baseSystem = agent.systemPrompt
  const limitsOf = () => fetchLimits(env, agent.taskClass, { fetchImpl }).catch(() => null)
  // Один запуск на сессию за раз: два параллельных перемешали бы порядок
  // реплик в базе, и диалог перестал бы быть диалогом (ADR 2026-09-09-1906).
  const busy = new Set()

  return {
    id: agent.id,
    version: agent.version,

    /** Идёт ли в этой сессии запуск. Проверяется до создания следующего. */
    isBusy: (sessionId) => sessionId !== null && busy.has(sessionId),
    /** Занять сессию — синхронно, в том же такте, что и создание запуска. */
    hold(sessionId) {
      if (sessionId) busy.add(sessionId)
    },

    /** Вход запуска: проверяется здесь, на границе агента, а не у дня. */
    parseInput(body) {
      if (!body || typeof body !== 'object')
        return { ok: false, message: 'input должен быть объектом' }
      const sphere = parseSphere(body.sphere)
      if (!sphere.ok) return { ok: false, message: sphere.message }
      const parsed = parseParams(body, {
        maxOutputTokens: env.MAX_OUTPUT_TOKENS,
        defaults: agent.defaults,
      })
      if (!parsed.ok) return { ok: false, message: parsed.message }
      // Тема необязательна с дня 8, но спрашивать всё равно надо о чём-то:
      // пустые и тема, и сообщение — это запуск ни за чем.
      if (sphere.sphere === '' && parsed.params.prompt === '')
        return { ok: false, message: 'Напишите сообщение' }
      const system = parseSystem(body.system)
      if (!system.ok) return { ok: false, message: system.message }
      // Порог сводки необязателен: без него агент ведёт себя как в днях 7–8.
      const summarizeAt = parseSummarizeAt(body.summarizeAt, parsed.params.contextTokens)
      if (!summarizeAt.ok) return { ok: false, message: summarizeAt.message }
      // Сессия необязательна: без неё агент ведёт себя как в дне 6.
      const sessionId = body.sessionId ?? null
      if (sessionId !== null && !isSessionId(sessionId))
        return { ok: false, message: 'Поле sessionId должно быть идентификатором сессии' }
      if (this.isBusy(sessionId))
        return { ok: false, message: 'Дождитесь ответа на предыдущее сообщение' }
      return {
        ok: true,
        input: {
          sphere: sphere.sphere,
          params: parsed.params,
          system: system.system,
          sessionId,
          summarizeAt: summarizeAt.value,
        },
      }
    },

    /**
     * Описание для реестра и окна передачи: имя, версия, назначение,
     * системный промпт как есть, инструменты, модели с живым пределом,
     * готовые запросы и умолчания. Ключей и чужих данных здесь нет.
     */
    async describe() {
      const limits = await limitsOf()
      const fresh = archive.all().slice(0, PARAM_LIMITS.articles)
      const models = MODELS.map((m) => {
        const budget = effectiveBudget(m.id, inputBudgetFor(m.id), limits)
        return {
          ...m,
          budgetTokens: budget.tokens,
          budgetSource: budget.source,
          quota: budget.quota,
          available: budget.available,
          articlesFit: fresh.length > 0 ? articlesThatFit(baseSystem, fresh, budget.tokens) : null,
        }
      })
      return {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        purpose: agent.purpose,
        systemPrompt: baseSystem,
        taskClass: agent.taskClass,
        tools: [archive.describe()],
        models,
        presets: PROMPT_PRESETS,
        defaults: agent.defaults,
        limits: { ...PARAM_LIMITS, maxTokens: env.MAX_OUTPUT_TOKENS },
      }
    },

    /** Выполняет запуск до терминального события. Возвращает, когда всё записано. */
    async execute(run) {
      const { sphere, params, sessionId } = run.input
      // Свой промпт запуска или промпт из реестра. Всё, что считает размер
      // запроса и зовёт модель, обязано брать именно его: иначе агент
      // пообещает, что подборка влезает, по чужой мерке.
      const system = run.input.system ?? baseSystem
      const systemOverridden = run.input.system !== null && run.input.system !== undefined
      const startedAt = now()
      const memory = sessions !== null && sessionId !== null
      const summarizeAt = run.input.summarizeAt ?? null
      /** Хвост диалога, ушедший модели. Заполняется после запроса пределов. */
      let transcript = []
      /** Реплики для слов отбора, если они не совпадают с хвостом (режим сводки). */
      let recentTalk = null
      /** Текст сводки, ушедший модели, и итог сжатия в этом запуске. */
      let summaryText = null
      let summarized = null
      /** Вызов сводки дошёл до провайдера — запуск уже стоил денег. */
      let summaryPaid = false
      let context = {
        used: 0,
        effective: 0,
        requested: params.contextTokens,
        messages: 0,
        dropped: 0,
      }
      /** Реплика пользователя пишется до вызова модели: вопрос был задан. */
      let asked = false
      let memoryFailed = false
      const remember = (role, text, tokens, meta) => {
        if (!memory) return
        try {
          sessions.append({ sessionId, role, text, tokens, runId: run.id, meta })
        } catch (error) {
          // Диалог без записи хуже, чем диалог, но лучше, чем упавший запуск.
          // Идентификатор сессии — ключ к переписке: в лог идёт только начало.
          memoryFailed = true
          log(`сессия ${sessionId.slice(0, 8)}…: запись не удалась: ${error.message}`)
        }
      }
      const emit = (fields) => runs.emit(run.id, fields)

      /**
       * Сжатие истории: прежняя сводка и реплики после неё → новая сводка,
       * всегда Haiku (ADR 2026-09-11-1608). Отказ запуск не валит: сводка
       * остаётся прежней, реплики идут хвостом, в мониторе предупреждение.
       * Возвращает итог сжатия или null.
       */
      const compress = async (previous, fresh, freshTokens) => {
        const sourceTokens = (previous?.tokens ?? 0) + freshTokens
        const request = buildSummaryRequest(previous?.text ?? null, fresh, summarizeAt)
        const requestSize = estimateTokens(request.system) + estimateTokens(request.input)
        const label = MODELS.find((m) => m.id === SUMMARY_PROVIDER)?.label ?? SUMMARY_PROVIDER
        const started = now()
        emit({
          stage: 'llm_call',
          title: 'Сжимаю историю',
          detail: `${label} — при любой модели чата; ${sourceTokens} токенов исходника, сводка до ${request.answerTokens}`,
          data: {
            provider: SUMMARY_PROVIDER,
            taskClass: SUMMARY_CLASS,
            requestTokens: requestSize,
            answerTokens: request.answerTokens,
            sourceTokens,
            summarizeAt,
          },
        })
        let answer
        try {
          answer = await askSummary(request, env, { fetchImpl })
          if (answer.text.trim() === '') throw new Error('модель вернула пустую сводку')
        } catch (error) {
          if (!paidNothing(error)) summaryPaid = true
          log(`запуск ${run.id}: сводка: ${error.code ?? ''} ${error.message}`)
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Историю не сжал',
            detail: `${explainRouterError(error)}\nсводка прежняя, реплики идут хвостом в пределах окна`,
            data: { code: error.code ?? null, status: error.status ?? null },
            durationMs: now() - started,
          })
          return null
        }
        summaryPaid = true
        const ms = now() - started
        const text = answer.text.trim()
        const tokens = answer.usage.outputTokens ?? estimateTokens(text)
        const callTokens = (answer.usage.inputTokens ?? requestSize) + tokens
        emit({
          stage: 'llm_result',
          title: 'Получил сводку',
          detail: `${answer.provider?.model ?? SUMMARY_PROVIDER}, ${seconds(ms)}, ${answer.usage.inputTokens ?? '?'} → ${answer.usage.outputTokens ?? '?'} токенов`,
          data: {
            provider: answer.provider,
            usage: answer.usage,
            truncated: answer.truncated,
            providerDurationMs: answer.durationMs,
          },
          durationMs: ms,
        })
        if (answer.truncated) {
          emit({
            stage: 'warning',
            level: 'warn',
            title: `Сводка обрезана потолком ${request.answerTokens} токенов`,
            detail: 'конец пересказа потерян',
            data: { answerTokens: request.answerTokens },
          })
        }
        try {
          sessions.saveSummary({
            sessionId,
            text,
            tokens,
            sourceTokens,
            throughId: fresh.at(-1).id,
            model: answer.provider?.model ?? null,
            truncated: answer.truncated,
            spentTokens: callTokens,
          })
        } catch (error) {
          // Сводка получена и оплачена, но не сохранилась: в этот запуск она
          // не идёт, чтобы экран и база не разошлись.
          memoryFailed = true
          log(`сессия ${sessionId.slice(0, 8)}…: сводка не записана: ${error.message}`)
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Историю не сжал',
            detail: 'сводка не записалась, реплики идут хвостом в пределах окна',
            data: { memory: 'failed' },
          })
          return null
        }
        const ratio = Math.round((tokens / sourceTokens) * 100) / 100
        emit({
          stage: 'planning',
          title: `Сжал историю: ${sourceTokens} → ${tokens} токенов (${Math.round(ratio * 100)} %)`,
          detail: `сжал ${label}; порог ${summarizeAt}`,
          data: { sourceTokens, tokens, ratio, messages: fresh.length },
        })
        return { text, tokens, sourceTokens, ratio, totalTokens: callTokens }
      }
      // С момента запроса к роутеру вызов считается оплаченным, пока роутер
      // не сказал обратного: неожиданная ошибка после ответа модели не должна
      // возвращать дню слот за деньги, которые уже потрачены.
      let modelAsked = false
      const fail = ({ code, message, status = null, paid = modelAsked, title }) => {
        // Ошибка видна в чате, но в контекст модели не идёт: это наш текст.
        if (asked) remember('agent', message, 0, { error: true, code })
        return runs.finish(run.id, {
          status: 'failed',
          error: { code, message, paidNothing: !(paid || summaryPaid) },
          event: {
            stage: 'error',
            level: 'error',
            title,
            detail: message,
            data: { code, status },
            durationMs: now() - startedAt,
          },
        })
      }

      try {
        emit({
          stage: 'received',
          title: 'Получил запрос',
          detail:
            params.articles === null
              ? `модель ${params.model}, подборка под предел модели`
              : `модель ${params.model}, статей до ${params.articles}`,
          data: {
            model: params.model,
            articles: params.articles,
            perSource: params.perSource,
            maxTokens: params.maxTokens,
            temperature: params.temperature,
            promptChars: params.prompt.length,
            stopSequences: params.stopSequences.length,
            systemOverridden,
            systemChars: system.length,
          },
        })
        if (systemOverridden) {
          // Свой промпт меняет поведение агента, и это должно быть видно
          // в мониторе: текста здесь нет, только сам факт и длина.
          emit({
            stage: 'planning',
            title: 'Взял ваш системный промпт',
            detail: `${system.length} знаков вместо промпта из реестра`,
            data: { systemOverridden: true, systemChars: system.length },
          })
        }

        // Пределы модели и память поднимаются до архива: с дня 8 отбор идёт
        // по словам разговора, значит хвост диалога нужен раньше подборки
        // (ADR 2026-09-09-2134).
        const limits = await limitsOf()
        const budget = effectiveBudget(params.model, inputBudgetFor(params.model), limits)

        // Диалог берётся до статей: сначала память, потом подборка на
        // остаток. Действующий размер меньше заданного, если предел входа
        // модели не позволяет (ADR 2026-09-09-1906).
        const effective = effectiveContext(params.contextTokens, budget.tokens)
        if (memory && effective > 0 && summarizeAt !== null) {
          // Режим сводки (ADR 2026-09-11-1608): реплики после сводки копятся
          // до порога N, затем один раз, до ответа, сжимаются вместе с ней.
          let stored = sessions.summary(sessionId)
          let fresh = sessions.since(sessionId, stored?.throughId ?? 0)
          // Слова для отбора — из реплик до сжатия: после него хвост пуст,
          // а тема разговора жива в последних сообщениях пользователя.
          recentTalk = fresh
          const freshTokens = fresh.reduce((sum, m) => sum + m.tokens, 0)
          if (freshTokens >= summarizeAt) {
            const done = await compress(stored, fresh, freshTokens)
            if (done) {
              stored = { text: done.text, tokens: done.tokens }
              fresh = []
              // Текст сводки — в её строке и в GET сессии; здесь только числа.
              summarized = {
                sourceTokens: done.sourceTokens,
                tokens: done.tokens,
                ratio: done.ratio,
                totalTokens: done.totalTokens,
              }
            }
          }
          // Окно — страховка: сводка, не поместившаяся в него целиком, не идёт,
          // а свежим репликам остаётся то, что сводка не заняла.
          summaryText = stored && stored.tokens <= effective ? stored.text : null
          const summaryTokens = summaryText === null ? 0 : stored.tokens
          const tail = fitDialog(fresh, effective - summaryTokens)
          transcript = tail.messages
          context = {
            used: summaryTokens + tail.tokens,
            effective,
            requested: params.contextTokens,
            messages: tail.messages.length,
            dropped: tail.dropped,
            summaryTokens,
            freshTokens: tail.tokens,
            summarized,
          }
          if (summaryText !== null || tail.messages.length > 0) {
            emit({
              stage: 'planning',
              title: 'Вспомнил разговор',
              detail:
                `сводка ${summaryTokens} и ${tail.messages.length} реплик, ` +
                `${context.used} из ${effective} токенов контекста`,
              data: { ...context },
            })
          }
        } else if (memory && effective > 0) {
          const tail = sessions.tail(sessionId, effective)
          transcript = tail.messages
          context = {
            used: tail.tokens,
            effective,
            requested: params.contextTokens,
            messages: tail.messages.length,
            dropped: tail.dropped,
          }
          if (tail.messages.length > 0) {
            emit({
              stage: 'planning',
              title: 'Вспомнил разговор',
              detail:
                `${tail.messages.length} реплик, ${tail.tokens} из ${effective} токенов контекста` +
                (effective < params.contextTokens ? ` (модель даёт меньше ${params.contextTokens})` : ''),
              data: { ...context },
            })
          }
        } else {
          context = { used: 0, effective, requested: params.contextTokens, messages: 0, dropped: 0 }
        }

        // Инструмент: архив. Аргументы без текстов — тема и запрос в событие
        // не идут, только пределы отбора.
        const toolCallId = randomUUID()
        // Слова для отбора — из разговора, а не из одного поля: «а подробнее
        // про первое» само по себе не содержит ни одной зацепки, а тема живёт
        // в предыдущих репликах (ADR 2026-09-09-2134). Хвост диалога уже
        // поднят для модели, поэтому лишних чтений базы это не добавляет.
        // Только когда темы нет: дни 6 и 7 её присылают, и отбор у них
        // остаётся прежним — ADR обещает, что они не меняются.
        const query = sphere
          ? params.prompt
          : [
              ...(recentTalk ?? transcript)
                .filter((m) => m.role === 'user')
                .slice(-RECENT_USER_MESSAGES)
                .map((m) => m.text),
              params.prompt,
            ]
              .filter(Boolean)
              .join(' ')
        const toolArgs = {
          sphere,
          prompt: query,
          perSource: params.perSource,
          // Без явного числа подборку ограничивают потолок на издание и
          // предел входа модели, а не параметр.
          limit: params.articles ?? FILL_LIMIT,
          // Бюджет зависит от модели: у моделей Groq предел на запрос жёстче
          // окна, и подборка «как для Haiku» получила бы отказ 413.
          maxChars: budgetFor(params.model),
        }
        const toolStarted = now()
        emit({
          stage: 'tool_call',
          title: 'Обратился к архиву',
          detail: 'обновление лент, если пора, и отбор статей под запрос',
          data: {
            tool: archive.name,
            args: {
              perSource: toolArgs.perSource,
              limit: toolArgs.limit,
              maxChars: toolArgs.maxChars,
            },
          },
          toolCallId,
        })
        const found = await archive.run(toolArgs)
        const failedSources = found.refresh.failed.map((f) => f.source)
        emit({
          stage: 'tool_result',
          title: 'Отобрал статьи',
          detail: `${found.items.length} из ${found.total} в архиве, по запросу ${found.matched}`,
          data: {
            tool: archive.name,
            total: found.total,
            selected: found.items.length,
            matched: found.matched,
            refreshed: found.refresh.refreshed,
            added: found.refresh.added,
            dropped: found.refresh.dropped,
            failedSources,
          },
          durationMs: now() - toolStarted,
          toolCallId,
        })
        if (found.refresh.attempted && !found.refresh.refreshed) {
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Архив не обновился',
            detail: 'ленты не ответили, статьи прежние',
          })
        } else if (failedSources.length > 0) {
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Часть лент не ответила',
            detail: `без обновления: ${failedSources.join(', ')}`,
            data: { failedSources },
          })
        }
        if (found.items.length === 0) {
          return fail({
            code: 'archive_empty',
            title: 'Архив пуст',
            message: 'Архив пуст: ни одна лента пока не отдала статей. Попробуйте позже.',
          })
        }

        // Реплика пользователя записывается до вызова модели: вопрос задан,
        // и неудачный запуск не должен делать вид, что его не было. Но после
        // проверки архива: пустой архив не оставлял следа и в дне 7.
        remember('user', params.prompt || sphere, estimateTokens(params.prompt || sphere), {
          sphere,
        })
        asked = true

        const fitStarted = now()
        const items = fitToBudget(
          system,
          sphere,
          params,
          found.items,
          budget.tokens,
          transcript,
          summaryText,
        )
        const needed = requestTokens(system, sphere, params, items, transcript, summaryText)
        emit({
          stage: 'planning',
          title: 'Подогнал под модель',
          detail: `${items.length} из ${found.items.length} статей, ${needed} из ${budget.tokens} токенов`,
          data: {
            budgetTokens: budget.tokens,
            budgetSource: budget.source,
            requestTokens: needed,
            contextTokens: context.used,
            used: items.length,
            selected: found.items.length,
            withText: items.filter((i) => i.text).length,
          },
          durationMs: now() - fitStarted,
        })
        if (needed > budget.tokens) {
          // Если не помещается даже одна статья, звать модель незачем:
          // она ответит отказом, а слот суточного предела будет потрачен.
          const reset = budget.quota?.resetAt
            ? ` Сброс: ${new Date(budget.quota.resetAt).toLocaleTimeString('ru-RU')}.`
            : ''
          const blame =
            context.used > 0
              ? ` Из них ${context.used} занял контекст разговора — его размер можно уменьшить.`
              : ''
          return fail({
            code: 'budget_too_small',
            title: 'Не хватает предела модели',
            message:
              `У модели сейчас осталось ${budget.tokens} токенов на запрос — не хватает даже на одну статью.` +
              `${blame}${reset} Выберите другую модель или подождите.`,
          })
        }

        // Модель — через роутер, явным провайдером.
        const llmStarted = now()
        emit({
          stage: 'llm_call',
          title: 'Спросил модель',
          detail: `${params.model}, ${needed} токенов входа, ответ до ${params.maxTokens}`,
          data: {
            provider: params.model,
            taskClass: agent.taskClass,
            requestTokens: needed,
            answerTokens: params.maxTokens,
            temperature: params.temperature === 1 ? null : params.temperature,
            stopSequences: params.stopSequences.length,
          },
        })
        let answer
        modelAsked = true
        try {
          answer = await askRouter(
            {
              system,
              taskClass: agent.taskClass,
              sphere,
              params,
              items,
              transcript,
              summary: summaryText,
            },
            env,
            { fetchImpl },
          )
        } catch (error) {
          log(`запуск ${run.id}: роутер: ${error.code ?? ''} ${error.message}`)
          return fail({
            code: error.code ?? (error.status === 429 ? 'rate_limited' : 'router_error'),
            status: error.status ?? null,
            title: 'Модель не ответила',
            message: explainRouterError(error),
            paid: !paidNothing(error),
          })
        }
        const llmMs = now() - llmStarted
        const modelName = answer.provider?.model ?? params.model
        emit({
          stage: 'llm_result',
          title: 'Получил ответ',
          detail: `${modelName}, ${seconds(llmMs)}, ${answer.usage.inputTokens ?? '?'} → ${answer.usage.outputTokens ?? '?'} токенов`,
          data: {
            provider: answer.provider,
            usage: answer.usage,
            truncated: answer.truncated,
            providerDurationMs: answer.durationMs,
          },
          durationMs: llmMs,
        })
        if (answer.truncated) {
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Ответ обрезан лимитом токенов',
            detail: `ответ упёрся в ${params.maxTokens} токенов`,
            data: { maxTokens: params.maxTokens },
          })
        }

        // Проверка ссылок по белому списку подборки. Список вырезанного —
        // в деталях с новой строки: одно событие, а не по событию на ссылку.
        const guard = guardLinks(answer.text, items)
        const guardDetail =
          guard.total === 0
            ? 'ссылок в ответе нет'
            : guard.stripped.length === 0
              ? `все ${guard.total} из списка источников`
              : `вырезано ${guard.stripped.length} из ${guard.total}\n${guard.stripped.join('\n')}`
        emit({
          stage: 'guard',
          level: guard.stripped.length > 0 ? 'warn' : 'info',
          title: 'Проверил ссылки',
          detail: guardDetail,
          data: { links: guard.total, stripped: guard.stripped.length },
        })

        const totalMs = now() - startedAt
        // Своя оценка, когда провайдер не сказал: Ollama `usage` не присылает,
        // а нулём такая итерация обнулила бы и сумму по всей переписке.
        const answerTokens =
          (answer.usage.inputTokens ?? needed) +
          (answer.usage.outputTokens ?? estimateTokens(answer.text))
        // Запуск обошёлся в ответ плюс вызов сводки. В сводке ответа —
        // только ответ: цена сводки копится в её строке в базе, и сумма
        // сессии сложила бы её дважды (ADR 2026-09-11-1608).
        const totalTokens = answerTokens + (summarized?.totalTokens ?? 0)
        // Сводка переживает перезапуск вместе с перепиской: события монитора
        // живут до перезагрузки страницы, а «что было в этой итерации»
        // должно читаться и завтра (ADR 2026-09-09-1906).
        const summary = {
          model: answer.provider?.model ?? params.model,
          provider: params.model,
          articlesUsed: items.length,
          articlesSelected: found.items.length,
          matched: found.matched,
          withText: items.filter((i) => i.text).length,
          refreshed: found.refresh.refreshed,
          links: guard.total,
          strippedLinks: guard.stripped.length,
          inputTokens: answer.usage.inputTokens,
          outputTokens: answer.usage.outputTokens,
          totalTokens: answerTokens,
          durationMs: totalMs,
          budgetTokens: budget.tokens,
          budgetSource: budget.source,
          contextUsed: context.used,
          contextEffective: context.effective,
          contextRequested: context.requested,
          contextMessages: context.messages,
          contextDropped: context.dropped,
          truncated: answer.truncated,
          systemOverridden,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          perSource: params.perSource,
          articles: params.articles,
          stopSequences: params.stopSequences.length,
          // Поля режима сводки — только в нём: у дней 7–8 сводка ответа прежняя.
          ...(summarizeAt !== null
            ? {
                summarizeAt,
                summaryTokens: context.summaryTokens ?? 0,
                freshTokens: context.freshTokens ?? 0,
                summarized,
              }
            : {}),
        }
        // Ответ модели — в переписку: он же станет контекстом следующего
        // сообщения. Считаем его выходными токенами, а не заново.
        // Провайдер может не прислать usage (так делает Ollama). Ноль здесь
        // означал бы «реплика ничего не весит», и она никогда не вытеснялась
        // бы из контекста — считаем оценкой, той же, что у роутера.
        remember(
          'agent',
          guard.text,
          answer.usage.outputTokens ?? estimateTokens(guard.text),
          summary,
        )

        if (memoryFailed) {
          // Память обещана, и её отказ не должен быть виден только в логе
          // контейнера: после перезагрузки этой реплики в чате не будет.
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Не записал разговор',
            detail: 'ответ показан, но в переписку не попал — после перезагрузки его не будет',
            data: { memory: 'failed' },
          })
        }

        runs.finish(run.id, {
          status: 'succeeded',
          result: {
            answer: guard.text,
            memoryFailed,
            summary,
            context,
            totalTokens,
            model: answer.provider,
            usage: answer.usage,
            truncated: answer.truncated,
            durationMs: answer.durationMs,
            systemOverridden,
            selection: {
              budgetChars: toolArgs.maxChars,
              budgetTokens: budget.tokens,
              budgetSource: budget.source,
              used: items.length,
              selected: found.items.length,
              matched: found.matched,
              withText: items.filter((i) => i.text).length,
            },
            archive: {
              total: archive.size(),
              added: found.refresh.added,
              refreshed: found.refresh.refreshed,
            },
            sources: items.map((i) => ({
              title: i.title,
              url: i.url,
              source: i.source,
              date: i.date,
            })),
          },
          event: {
            stage: 'done',
            title: 'Отдал ответ',
            detail: `весь запуск ${seconds(totalMs)}`,
            durationMs: totalMs,
          },
        })
      } catch (error) {
        // Неожиданная ошибка — тоже терминальное событие: запуск не может
        // остаться «выполняется» навсегда.
        log(`запуск ${run.id}: ${error.stack ?? error.message}`)
        if (runs.get(run.id) && !TERMINAL.has(run.status)) {
          fail({
            code: 'internal',
            title: 'Внутренняя ошибка агента',
            message: 'Внутренняя ошибка агента',
          })
        }
      } finally {
        // Сессия свободна при любом исходе: иначе один сбой запер бы диалог.
        if (sessionId) busy.delete(sessionId)
      }
    },
  }
}

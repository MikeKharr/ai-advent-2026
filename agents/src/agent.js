// Агент «аналитик новостей»: один запуск — одна цепочка стадий с событием
// на каждую (ADR 2026-09-10-1000, п. 4). Заголовки — глаголом совершенного
// вида, не длиннее 60 знаков; детали — одна строка, длинное — с новой
// строки, страница покажет его в раскрытии.
//
// Никогда не бросает: любая ошибка — терминальное событие и статус
// `failed`. Уронить запуск молча значит оставить страницу в «выполняется».

import { randomUUID } from 'node:crypto'
import {
  articlesThatFit,
  askRouter,
  effectiveBudget,
  effectiveContext,
  fetchLimits,
  fitToBudget,
  guardLinks,
  estimateTokens,
  requestTokens,
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
  parseSystem,
} from './params.js'
import { TERMINAL } from './runs.js'

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
      ? 'Запрос слишком большой для остатка суточного лимита. Уменьшите число статей.'
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
  // реплик в базе, и диалог перестал бы быть диалогом (ADR 2026-09-12-0930).
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
      const system = parseSystem(body.system)
      if (!system.ok) return { ok: false, message: system.message }
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
      /** Хвост диалога, ушедший модели. Заполняется после запроса пределов. */
      let transcript = []
      let context = { used: 0, effective: 0, requested: params.contextTokens, messages: 0 }
      /** Реплика пользователя пишется до вызова модели: вопрос был задан. */
      let asked = false
      const remember = (role, text, tokens, meta) => {
        if (!memory) return
        try {
          sessions.append({ sessionId, role, text, tokens, runId: run.id, meta })
        } catch (error) {
          // Диалог без записи хуже, чем диалог, но лучше, чем упавший запуск.
          log(`сессия ${sessionId}: запись не удалась: ${error.message}`)
        }
      }
      const emit = (fields) => runs.emit(run.id, fields)
      // С момента запроса к роутеру вызов считается оплаченным, пока роутер
      // не сказал обратного: неожиданная ошибка после ответа модели не должна
      // возвращать дню слот за деньги, которые уже потрачены.
      let modelAsked = false
      const fail = ({ code, message, status = null, paid = modelAsked, title }) => {
        // Ошибка видна в чате, но в контекст модели не идёт: это наш текст.
        if (asked) remember('agent', message, 0, { error: true, code })
        return runs.finish(run.id, {
          status: 'failed',
          error: { code, message, paidNothing: !paid },
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
          detail: `модель ${params.model}, статей до ${params.articles}`,
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

        // Инструмент: архив. Аргументы без текстов — тема и запрос в событие
        // не идут, только пределы отбора.
        const toolCallId = randomUUID()
        const toolArgs = {
          sphere,
          prompt: params.prompt,
          perSource: params.perSource,
          limit: params.articles,
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

        // Подгонка под модель. Предел провайдера меряется по всему запросу,
        // а не по текстам статей; берём меньшее из объявленного агентом и
        // того, что провайдер сообщил о своём остатке.
        const planStarted = now()
        const limits = await limitsOf()
        const budget = effectiveBudget(params.model, inputBudgetFor(params.model), limits)

        // Диалог берётся до статей: сначала память, потом подборка на
        // остаток. Действующий размер меньше заданного, если предел входа
        // модели не позволяет (ADR 2026-09-12-0930).
        const effective = effectiveContext(params.contextTokens, budget.tokens)
        if (memory && effective > 0) {
          const tail = sessions.tail(sessionId, effective)
          transcript = tail.messages
          context = {
            used: tail.tokens,
            effective,
            requested: params.contextTokens,
            messages: tail.messages.length,
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
          context = { used: 0, effective, requested: params.contextTokens, messages: 0 }
        }

        // Реплика пользователя записывается до вызова модели: вопрос задан,
        // и неудачный запуск не должен делать вид, что его не было.
        remember('user', params.prompt || sphere, estimateTokens(params.prompt || sphere))
        asked = true

        const items = fitToBudget(system, sphere, params, found.items, budget.tokens, transcript)
        const needed = requestTokens(system, sphere, params, items, transcript)
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
          durationMs: now() - planStarted,
        })
        if (needed > budget.tokens) {
          // Если не помещается даже одна статья, звать модель незачем:
          // она ответит отказом, а слот суточного предела будет потрачен.
          const reset = budget.quota?.resetAt
            ? ` Сброс: ${new Date(budget.quota.resetAt).toLocaleTimeString('ru-RU')}.`
            : ''
          return fail({
            code: 'budget_too_small',
            title: 'Не хватает предела модели',
            message:
              `У модели сейчас осталось ${budget.tokens} токенов на запрос — не хватает даже на одну статью.` +
              `${reset} Выберите другую модель или подождите.`,
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
            { system, taskClass: agent.taskClass, sphere, params, items, transcript },
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
        const totalTokens =
          (answer.usage.inputTokens ?? 0) + (answer.usage.outputTokens ?? 0)
        const summary = {
          model: answer.provider?.model ?? params.model,
          articlesUsed: items.length,
          articlesSelected: found.items.length,
          totalTokens,
          durationMs: totalMs,
          contextUsed: context.used,
          contextEffective: context.effective,
          truncated: answer.truncated,
          strippedLinks: guard.stripped.length,
        }
        // Ответ модели — в переписку: он же станет контекстом следующего
        // сообщения. Считаем его выходными токенами, а не заново.
        remember('agent', guard.text, answer.usage.outputTokens ?? 0, summary)

        runs.finish(run.id, {
          status: 'succeeded',
          result: {
            answer: guard.text,
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

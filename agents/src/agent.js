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
  fetchLimits,
  fitToBudget,
  guardLinks,
  requestTokens,
} from './llm.js'
import {
  budgetFor,
  inputBudgetFor,
  MODELS,
  PARAM_LIMITS,
  PROMPT_PRESETS,
  parseParams,
  parseSphere,
} from './params.js'

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
  fetchImpl = fetch,
  now = Date.now,
  log = console.error,
}) {
  const system = agent.systemPrompt
  const limitsOf = () => fetchLimits(env, agent.taskClass, { fetchImpl }).catch(() => null)

  return {
    id: agent.id,
    version: agent.version,

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
      return { ok: true, input: { sphere: sphere.sphere, params: parsed.params } }
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
          articlesFit: fresh.length > 0 ? articlesThatFit(system, fresh, budget.tokens) : null,
        }
      })
      return {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        purpose: agent.purpose,
        systemPrompt: system,
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
      const { sphere, params } = run.input
      const startedAt = now()
      const emit = (fields) => runs.emit(run.id, fields)
      // С момента запроса к роутеру вызов считается оплаченным, пока роутер
      // не сказал обратного: неожиданная ошибка после ответа модели не должна
      // возвращать дню слот за деньги, которые уже потрачены.
      let modelAsked = false
      const fail = ({ code, message, status = null, paid = modelAsked, title }) =>
        runs.finish(run.id, {
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
          },
        })

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
        const items = fitToBudget(system, sphere, params, found.items, budget.tokens)
        const needed = requestTokens(system, sphere, params, items)
        emit({
          stage: 'planning',
          title: 'Подогнал под модель',
          detail: `${items.length} из ${found.items.length} статей, ${needed} из ${budget.tokens} токенов`,
          data: {
            budgetTokens: budget.tokens,
            budgetSource: budget.source,
            requestTokens: needed,
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
            { system, taskClass: agent.taskClass, sphere, params, items },
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
        runs.finish(run.id, {
          status: 'succeeded',
          result: {
            answer: guard.text,
            model: answer.provider,
            usage: answer.usage,
            truncated: answer.truncated,
            durationMs: answer.durationMs,
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
        if (runs.get(run.id) && !['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          fail({
            code: 'internal',
            title: 'Внутренняя ошибка агента',
            message: 'Внутренняя ошибка агента',
          })
        }
      }
    },
  }
}

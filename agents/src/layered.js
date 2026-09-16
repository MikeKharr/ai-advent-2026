// Агент дня 11 — диалог со слоями памяти профиля (ADR 2026-09-15-2024,
// п. 8.2). Цепочка запуска: `hold` → `recall` (рабочая память дня 10) →
// `assemble` → вызов модели → `remember` → `replenish` → `finish`.
//
// Данных у агента нет: ни архива статей, ни сферы, ни белого списка ссылок.
// Предмет разговора задают слои памяти, и что из них уходит модели, решает
// политика (`context.js`) — этот модуль её только зовёт.
//
// Никогда не бросает: любая ошибка — терминальное событие и статус `failed`.

import { defaultPolicy } from './context.js'
import {
  askLayered,
  askSummary,
  buildSummaryRequest,
  effectiveBudget,
  effectiveContext,
  estimateTokens,
  fetchLimits,
  fitDialog,
  SUMMARY_CLASS,
  SUMMARY_PROVIDER,
} from './llm.js'
import { recall } from './memory.js'
import {
  inputBudgetFor,
  isProfileId,
  isSessionId,
  LAYERED_MAX_TOKENS,
  LAYERED_MODELS,
  PARAM_LIMITS,
  parseFactsTokens,
  parseParams,
  parseParentId,
  parseStrategy,
  parseSummarizeAt,
  parseSystem,
  parseWindow,
  TOPIC_FACT_CAP,
} from './params.js'
import { TERMINAL } from './runs.js'
import { createSessionLock, explainRouterError, paidNothing, seconds } from './shared.js'

/** Идентификатор записи реестра: по нему сервис находит агента дня 11. */
export const LAYERED_AGENT_ID = 'layered-agent'

/** Поля входа дня 10, которых у агента без архива не бывает (критерий 4). */
const FOREIGN_FIELDS = ['sphere', 'perSource', 'articles']

/**
 * Потолок исходника сводки — тот же, что в дне 10, но с потолком класса
 * вместо `MAX_OUTPUT_TOKENS`: ответ агента дня 11 не бывает длиннее 2048.
 */
function summarySourceCap(summarizeAt) {
  return summarizeAt + LAYERED_MAX_TOKENS + Math.ceil(PARAM_LIMITS.promptChars / 2)
}

export function createLayeredAgent({
  agent,
  runs,
  env,
  sessions = null,
  policy = defaultPolicy,
  fetchImpl = fetch,
  now = Date.now,
  log = console.error,
}) {
  const baseSystem = agent.systemPrompt
  const limitsOf = () => fetchLimits(env, agent.taskClass, { fetchImpl }).catch(() => null)
  // Свой замок на агента: диалоги дня 11 и дней 6–10 живут в одной базе, но
  // занятость сессии — свойство исполнителя, и общего состояния у двух
  // агентов нет.
  const lock = createSessionLock()

  return {
    id: agent.id,
    version: agent.version,
    tools: [...agent.tools],
    // Умолчания реестра нужны ручке настроек: она проверяет значения теми же
    // разборщиками и теми же умолчаниями, с которыми пойдёт запуск.
    defaults: { ...agent.defaults },

    isBusy: lock.isBusy,
    hold: lock.hold,

    /**
     * Вход запуска. Профиль и его диалог обязательны, и принадлежность
     * диалога профилю проверяется здесь, до единой записи в базу: иначе
     * `append` завёл бы сессию сам, и потолок в 20 диалогов обошёлся бы
     * чужим или выдуманным идентификатором (ADR, п. 3).
     */
    parseInput(body) {
      if (!body || typeof body !== 'object')
        return { ok: false, message: 'input должен быть объектом' }
      for (const field of FOREIGN_FIELDS) {
        if (body[field] !== undefined && body[field] !== null && body[field] !== '') {
          return { ok: false, message: `Поле ${field} этому агенту не передаётся` }
        }
      }
      if (sessions === null) return { ok: false, message: 'Память профилей недоступна' }
      const { profileId, sessionId } = body
      if (!isProfileId(profileId))
        return { ok: false, message: 'Поле profileId должно быть идентификатором профиля' }
      if (!isSessionId(sessionId))
        return { ok: false, message: 'Поле sessionId должно быть идентификатором диалога' }
      // `sessionProfile` отдаёт `undefined` у несуществующей сессии, поэтому
      // подделка не проходит той же проверкой, что и чужой диалог.
      if (sessions.sessionProfile(sessionId) !== profileId)
        return { ok: false, message: 'Диалог не найден в этом профиле' }

      const parsed = parseParams(body, {
        // Потолок ответа — потолок класса `layered_dialogue`, а не общий
        // потолок сервиса: 2049 отвергается здесь, а не роутером.
        maxOutputTokens: LAYERED_MAX_TOKENS,
        defaults: agent.defaults,
        // Список дня 11 — с моделями Kimi (ADR 2026-09-16-1038). Дни 6–10
        // зовут `parseParams` без него и остаются на `MODELS`.
        models: LAYERED_MODELS,
      })
      if (!parsed.ok) return { ok: false, message: parsed.message }
      if (parsed.params.prompt === '') return { ok: false, message: 'Напишите сообщение' }

      const system = parseSystem(body.system)
      if (!system.ok) return { ok: false, message: system.message }
      const summarizeAt = parseSummarizeAt(body.summarizeAt, parsed.params.contextTokens)
      if (!summarizeAt.ok) return { ok: false, message: summarizeAt.message }
      const strategy = parseStrategy(body.strategy)
      if (!strategy.ok) return { ok: false, message: strategy.message }
      const windowSize = parseWindow(body.window)
      if (!windowSize.ok) return { ok: false, message: windowSize.message }
      const factsTokens = parseFactsTokens(body.factsTokens)
      if (!factsTokens.ok) return { ok: false, message: factsTokens.message }
      const parentId = parseParentId(body.parentId)
      if (!parentId.ok) return { ok: false, message: parentId.message }
      if (parentId.value !== null && parentId.value !== 0) {
        const parent = sessions.message(sessionId, parentId.value)
        if (!parent || parent.role !== 'agent')
          return { ok: false, message: 'Родительское сообщение не найдено' }
      }
      if (this.isBusy(sessionId))
        return { ok: false, message: 'Дождитесь ответа на предыдущее сообщение' }

      return {
        ok: true,
        input: {
          profileId,
          sessionId,
          params: parsed.params,
          system: system.system,
          summarizeAt: summarizeAt.value,
          strategy: strategy.value,
          window: windowSize.value,
          factsTokens: factsTokens.value,
          parentId: parentId.value,
        },
      }
    },

    /**
     * Описание для реестра и окна настроек. `limits.maxTokens` — потолок
     * класса 2048, а не общий `MAX_OUTPUT_TOKENS` сервиса (4096): иначе окно
     * настроек обещало бы 4096, а сервис отвергал бы всё выше 2048
     * (ADR, п. 8.2, критерий 4). Полей сферы и статей здесь нет — их у
     * агента не бывает.
     */
    async describe() {
      const limits = await limitsOf()
      const models = LAYERED_MODELS.map((m) => {
        const budget = effectiveBudget(m.id, inputBudgetFor(m.id), limits)
        return {
          ...m,
          budgetTokens: budget.tokens,
          budgetSource: budget.source,
          quota: budget.quota,
          available: budget.available,
        }
      })
      return {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        purpose: agent.purpose,
        systemPrompt: baseSystem,
        taskClass: agent.taskClass,
        tools: [],
        models,
        // Готовых запросов о новостях у агента без новостей нет (ADR, п. 1).
        presets: [],
        defaults: agent.defaults,
        limits: {
          promptChars: PARAM_LIMITS.promptChars,
          systemChars: PARAM_LIMITS.systemChars,
          contextTokens: PARAM_LIMITS.contextTokens,
          stopSequences: PARAM_LIMITS.stopSequences,
          stopChars: PARAM_LIMITS.stopChars,
          maxTokens: LAYERED_MAX_TOKENS,
        },
      }
    },

    async execute(run) {
      const { profileId, sessionId, params } = run.input
      const strategy = run.input.strategy ?? null
      const windowSize = run.input.window ?? null
      const summarizeAt = run.input.summarizeAt ?? null
      const system = run.input.system ?? baseSystem
      const systemOverridden = run.input.system !== null && run.input.system !== undefined
      const startedAt = now()

      let asked = false
      let memoryFailed = false
      let summarySpent = 0
      let summaryPaid = false
      let modelAsked = false
      const tree = strategy !== null
      let nextParent =
        tree
          ? run.input.parentId === 0
            ? null
            : (run.input.parentId ?? sessions.head(sessionId))
          : null

      const emit = (fields) => runs.emit(run.id, fields)
      const remember = (role, text, tokens, meta) => {
        try {
          const id = sessions.append({
            sessionId,
            role,
            text,
            tokens,
            runId: run.id,
            meta,
            parentId: tree ? nextParent : null,
            // Удалённый диалог не воскресает записью: профиль могли стереть,
            // пока шёл запуск, и «удаление без следа» должно остаться правдой.
            onlyIfLive: true,
          })
          if (id !== null && tree) {
            nextParent = id
            sessions.setHead(sessionId, id)
          }
          if (id === null) memoryFailed = true
          return id
        } catch (error) {
          memoryFailed = true
          log(`сессия ${sessionId.slice(0, 8)}…: запись не удалась: ${error.message}`)
          return null
        }
      }
      const fail = ({ code, message, status = null, paid = modelAsked, title }) => {
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

      /**
       * Сжатие рабочей памяти при стратегии «сводка» — тот же вызов, что в
       * дне 10 (ADR 2026-09-11-1608): всегда Haiku, класс `summarize`, свой
       * постоянный промпт. Отказ запуск не валит.
       */
      const compress = async (previous, fresh) => {
        const cap = summarySourceCap(summarizeAt)
        const source = fitDialog(fresh, cap)
        const sourceTokens = (previous?.tokens ?? 0) + source.tokens
        const request = buildSummaryRequest(previous?.text ?? null, source.messages, summarizeAt)
        const requestSize = estimateTokens(request.system) + estimateTokens(request.input)
        const started = now()
        emit({
          stage: 'llm_call',
          title: 'Сжимаю историю',
          detail: `${sourceTokens} токенов исходника, сводка до ${request.answerTokens}`,
          data: {
            provider: SUMMARY_PROVIDER,
            taskClass: SUMMARY_CLASS,
            requestTokens: requestSize,
            answerTokens: request.answerTokens,
            sourceTokens,
            summarizeAt,
            droppedFromSource: source.dropped,
          },
        })
        let answer
        try {
          answer = await askSummary(request, env, { fetchImpl })
        } catch (error) {
          if (!paidNothing(error)) summaryPaid = true
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Историю не сжал',
            detail: `${explainRouterError(error)}\nсводка прежняя, реплики идут хвостом`,
            data: { code: error.code ?? null, status: error.status ?? null },
            durationMs: now() - started,
          })
          return null
        }
        summaryPaid = true
        const text = answer.text.trim()
        const tokens = answer.usage.outputTokens ?? estimateTokens(text)
        const callTokens = (answer.usage.inputTokens ?? requestSize) + tokens
        summarySpent = callTokens
        if (text === '') {
          try {
            sessions.addSummaryCost(sessionId, callTokens)
          } catch (error) {
            log(`сессия ${sessionId.slice(0, 8)}…: цена сводки не записана: ${error.message}`)
          }
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Историю не сжал',
            detail: 'модель вернула пустую сводку',
            data: { code: 'empty_summary' },
          })
          return null
        }
        let saved
        try {
          saved = sessions.saveSummary({
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
          memoryFailed = true
          log(`сессия ${sessionId.slice(0, 8)}…: сводка не записана: ${error.message}`)
          return null
        }
        if (!saved) {
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Историю не сжал',
            detail: 'переписку очистили во время сжатия — сводка не записана',
            data: { code: 'session_cleared' },
          })
          return null
        }
        const ratio = Math.round((tokens / sourceTokens) * 100) / 100
        emit({
          stage: 'planning',
          title: `Сжал историю: ${sourceTokens} → ${tokens} токенов`,
          detail: `порог ${summarizeAt}`,
          data: { sourceTokens, tokens, ratio, messages: source.messages.length },
        })
        return { text, tokens, sourceTokens, ratio, totalTokens: callTokens }
      }

      try {
        emit({
          stage: 'received',
          title: 'Получил запрос',
          detail: `модель ${params.model}, ответ до ${params.maxTokens}`,
          data: {
            model: params.model,
            maxTokens: params.maxTokens,
            temperature: params.temperature,
            promptChars: params.prompt.length,
            stopSequences: params.stopSequences.length,
            strategy,
            systemOverridden,
            systemChars: system.length,
          },
        })
        if (systemOverridden) {
          emit({
            stage: 'planning',
            title: 'Взял ваш системный промпт',
            detail: `${system.length} знаков вместо промпта из реестра`,
            data: { systemOverridden: true, systemChars: system.length },
          })
        }

        // Запуск в сессии профиля — действие в нём: срок всей памяти профиля
        // идёт от него (ADR, п. 2). Без этого профиль, в котором пишут каждый
        // день, ушёл бы по сроку вместе с живым диалогом.
        if (!sessions.touchProfile(profileId)) {
          return fail({
            code: 'unknown_profile',
            title: 'Профиль не найден',
            message: 'Профиль удалён или истёк — выберите другой на экране входа.',
          })
        }

        const limits = await limitsOf()
        const budget = effectiveBudget(params.model, inputBudgetFor(params.model), limits)
        const effective = effectiveContext(params.contextTokens, budget.tokens)
        const recalled = await recall({
          strategy,
          memory: true,
          sessions,
          sessionId,
          effective,
          requested: params.contextTokens,
          windowSize,
          summarizeAt,
          compress,
          emit,
          from: run.input.parentId === 0 ? null : (run.input.parentId ?? undefined),
        })
        const context = recalled.context

        // Слои профиля: правила и активная тема с её фактами.
        const state = sessions.sessionState(sessionId)
        const rules = sessions.rulesOf(profileId)
        const topic = state?.topicId
          ? {
              id: state.topicId,
              title: state.topicTitle,
              facts: sessions.topicFactsOf(state.topicId, TOPIC_FACT_CAP).map((f) => f.text),
            }
          : null

        // Единственный вызов политики сборки: порядок и состав блоков — её.
        const assembled = policy.assemble({
          rules,
          topic,
          summaryText: recalled.summaryText,
          factsText: recalled.factsText ?? null,
          transcript: recalled.transcript,
          prompt: params.prompt,
        })
        for (const warning of assembled.warnings) {
          emit({
            stage: 'warning',
            level: 'warn',
            title:
              warning.code === 'rules_trimmed'
                ? 'Правила не поместились в запрос'
                : 'Часть фактов темы не поместилась в запрос',
            detail: `${warning.dropped} старших записей сверх ${warning.capTokens} токенов не ушли модели`,
            data: { ...warning },
          })
        }
        emit({
          stage: 'planning',
          title: `Вспомнил профиль: ${assembled.stats.rules} правил, ${topic ? `тема «${topic.title}»` : 'темы нет'}`,
          detail:
            `правила ${assembled.stats.rulesTokens} токенов, факты темы ${assembled.stats.topicTokens} токенов; ` +
            `рабочая память ${context.used} токенов`,
          data: { ...assembled.stats, topicId: topic?.id ?? null, context },
        })

        const needed = estimateTokens(system) + estimateTokens(assembled.input)
        if (needed > budget.tokens) {
          return fail({
            code: 'budget_too_small',
            title: 'Не хватает предела модели',
            message:
              `Запрос занимает ${needed} токенов, а у модели сейчас есть ${budget.tokens}. ` +
              'Уменьшите размер контекста или выберите другую модель.',
          })
        }

        // Реплика пользователя — до вызова модели: вопрос задан, и неудачный
        // запуск не должен делать вид, что его не было.
        const askedId = remember('user', params.prompt, estimateTokens(params.prompt), null)
        if (askedId === null) {
          return fail({
            code: 'session_gone',
            title: 'Диалог не найден',
            message: 'Диалог удалён — начните новый.',
          })
        }
        asked = true

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
          answer = await askLayered(
            { system, taskClass: agent.taskClass, input: assembled.input, params },
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
        emit({
          stage: 'llm_result',
          title: 'Получил ответ',
          detail: `${answer.provider?.model ?? params.model}, ${seconds(llmMs)}, ${answer.usage.inputTokens ?? '?'} → ${answer.usage.outputTokens ?? '?'} токенов`,
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

        const totalMs = now() - startedAt
        const answerTokens =
          (answer.usage.inputTokens ?? needed) +
          (answer.usage.outputTokens ?? estimateTokens(answer.text))
        const summary = {
          model: answer.provider?.model ?? params.model,
          provider: params.model,
          profileId,
          topicId: topic?.id ?? null,
          rules: assembled.stats.rules,
          rulesTokens: assembled.stats.rulesTokens,
          topicFacts: assembled.stats.topicFacts,
          topicTokens: assembled.stats.topicTokens,
          inputTokens: answer.usage.inputTokens,
          outputTokens: answer.usage.outputTokens,
          totalTokens: answerTokens,
          durationMs: totalMs,
          budgetTokens: budget.tokens,
          contextUsed: context.used,
          contextEffective: context.effective,
          contextRequested: context.requested,
          contextMessages: context.messages,
          truncated: answer.truncated,
          systemOverridden,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          stopSequences: params.stopSequences.length,
          ...(strategy !== null ? { strategy } : {}),
          ...(summarizeAt !== null ? { summarizeAt } : {}),
        }
        const answerId = remember(
          'agent',
          answer.text,
          answer.usage.outputTokens ?? estimateTokens(answer.text),
          summary,
        )

        // Пополнение — после ответа и до `finish`: ответ уже входит в пару
        // «вопрос — ответ», и задержка честно видна на экране.
        const replenished = await policy.replenish({
          sessions,
          sessionId,
          profileId,
          answerId,
          pair: [
            { role: 'user', text: params.prompt, tokens: estimateTokens(params.prompt) },
            {
              role: 'agent',
              text: answer.text,
              tokens: answer.usage.outputTokens ?? estimateTokens(answer.text),
            },
          ],
          emit,
          env,
          fetchImpl,
          now,
          log,
        })
        if (replenished.paid) summaryPaid = true

        // Вопрос о новой теме — обычная реплика агента: она видна в логе,
        // входит в рабочую память, и следующий вызов пополнения знает, что
        // вопрос задан (ADR, п. 6.2).
        let proposal = null
        if (replenished.report?.proposal) {
          const { title } = replenished.report.proposal
          const where = replenished.report.topicTitle
            ? `продолжить в «${replenished.report.topicTitle}»`
            : 'продолжить без темы'
          const text = `Похоже, мы перешли к другому предмету — «${title}». Открыть новую тему или ${where}?`
          const id = remember('agent', text, estimateTokens(text), {
            topicProposal: { title, facts: replenished.report.proposal.facts },
          })
          proposal = { title, facts: replenished.report.proposal.facts, messageId: id }
        }

        const totalTokens = answerTokens + summarySpent + replenished.spent

        if (memoryFailed) {
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
            answer: answer.text,
            memoryFailed,
            summary,
            context,
            totalTokens,
            model: answer.provider,
            usage: answer.usage,
            truncated: answer.truncated,
            durationMs: answer.durationMs,
            systemOverridden,
            // Слои после пополнения — для монитора состояния памяти.
            layers: {
              topicId: replenished.report?.topicId ?? topic?.id ?? null,
              topicTitle: replenished.report?.topicTitle ?? topic?.title ?? null,
              factsWritten: replenished.report?.factsWritten ?? 0,
              rulesWritten: replenished.report?.rulesWritten ?? 0,
              parked: replenished.report?.factsParked ?? 0,
              switched: replenished.report?.switched ?? null,
              proposal,
            },
          },
          event: {
            stage: 'done',
            title: 'Отдал ответ',
            detail: `весь запуск ${seconds(totalMs)}`,
            durationMs: totalMs,
          },
        })
      } catch (error) {
        log(`запуск ${run.id}: ${error.stack ?? error.message}`)
        if (runs.get(run.id) && !TERMINAL.has(run.status)) {
          fail({
            code: 'internal',
            title: 'Внутренняя ошибка агента',
            message: 'Внутренняя ошибка агента',
          })
        }
      } finally {
        lock.release(sessionId)
      }
    },
  }
}

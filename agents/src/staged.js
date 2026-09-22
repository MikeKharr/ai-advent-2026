// Агент дня 13 — машина состояний запуска (ADR 2026-09-21-1747).
// Шесть этапов таблицей и цикл «ворота паузы → вход в этап → работа →
// выход»; у четырёх этапов есть вызов модели, у двух — правило в коде.
// Этап `verify` вдобавок держит круг проверки: отказ проверяющей модели
// возвращает запуск на `assemble` с замечаниями, пока круги не кончатся.
//
// День 11 (`layered.js`) не меняется ни строкой: его события сданы. Общая с
// ним часть — политика (`context.js`), память (`memory.js`) и хранилище;
// отличия агента дня 13 уходят в них опциями с умолчанием дня 11.
//
// Никогда не бросает: любая ошибка — терминальное событие и статус `failed`.

import { ASSEMBLE_CAPS, defaultPolicy, REPLENISH_CAPS } from './context.js'
import {
  askLayered,
  askSummary,
  askVerify,
  buildReplenishRequest,
  buildSummaryRequest,
  buildVerifyRequest,
  effectiveBudget,
  estimateTokens,
  fetchLimits,
  fitDialog,
  parseVerdict,
  promptSha8,
  safeTag,
  SUMMARY_CLASS,
  SUMMARY_PROVIDER,
  VERIFY_ANSWER_TOKENS,
  VERIFY_PROMPT,
  VERIFY_REMARKS_CHARS,
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
  parseReviewModel,
  parseReviewRounds,
  parseSettings,
  parseStrategy,
  parseSummarizeAt,
  parseSystem,
  parseWindow,
  REVIEW_ROUNDS,
  TOPIC_FACT_CAP,
} from './params.js'
import { TERMINAL } from './runs.js'
import { createSessionLock, explainRouterError, paidNothing, seconds } from './shared.js'

/** Идентификатор записи реестра: по нему сервис находит агента дня 13. */
export const STAGED_AGENT_ID = 'staged-agent'

/**
 * Агент дня 14 — та же машина с одним швом (ADR 2026-09-22-0827, п. 1).
 * Настройки у него общие с днём 13: тот же столбец `settings_staged`,
 * те же диапазоны. Последствие названо в записи — проверяющая модель,
 * выставленная в дне 14, действует и в дне 13 на том же профиле.
 */
export const INVARIANT_AGENT_ID = 'invariant-agent'

/**
 * Потолок `system + input` каждого вызова этого агента (решение владельца,
 * ADR 2026-09-21-1747, п. 5). Действующий потолок — меньшее из него и
 * предела выбранной модели: у Groq и ноутбука это их 4 300–5 200.
 */
export const STAGE_CONTEXT_TOKENS = 32_000

/**
 * Потолки сборки для этого агента: токенные подпотолки правил и темы сняты
 * (ADR, п. 5, 4а), потолки в строках остаются. Единственный токенный
 * потолок — `STAGE_CONTEXT_TOKENS`, и он настоящий.
 */
export const STAGED_ASSEMBLE_CAPS = {
  rulesTokens: STAGE_CONTEXT_TOKENS,
  topicFacts: ASSEMBLE_CAPS.topicFacts,
  topicTokens: STAGE_CONTEXT_TOKENS,
}

/** То же для вызова пополнения: вход целиком — 32 000, части не подрезаются. */
export const STAGED_REPLENISH_CAPS = {
  ...REPLENISH_CAPS,
  topicsTokens: STAGE_CONTEXT_TOKENS,
  topicTokens: STAGE_CONTEXT_TOKENS,
  rulesTokens: STAGE_CONTEXT_TOKENS,
  pendingTokens: STAGE_CONTEXT_TOKENS,
  inputTokens: STAGE_CONTEXT_TOKENS,
}

/** Удар индикатора работы раз в секунду (ADR, п. 8). */
const BEAT_MS = 1000

/** Поля входа дня 10, которых у агента без архива не бывает. */
const FOREIGN_FIELDS = ['sphere', 'perSource', 'articles']

/**
 * Шесть этапов запуска. `rule` — что делает этап без вызова модели; монитор
 * показывает его вместо промпта. `promptId` этапа с вызовом называет промпт,
 * текст которого отдаёт `describe()`.
 */
export const STAGES = [
  {
    id: 'intake',
    title: 'Приём',
    promptId: null,
    rule: 'профиль жив, диалог принадлежит профилю, сессия под замком; вызова модели нет',
  },
  {
    id: 'assemble',
    title: 'Сборка контекста',
    promptId: 'stage.summary',
    rule: `пределы модели, рабочая память по стратегии, правила и тема, потолок этапа ${STAGE_CONTEXT_TOKENS} токенов; вызов только при стратегии «сводка» и наступившем пороге`,
  },
  {
    id: 'answer',
    title: 'Вызов модели',
    promptId: 'stage.answer',
    rule: 'реплика посетителя в память один раз, затем вызов рабочей модели',
  },
  {
    id: 'verify',
    title: 'Проверка ответа',
    promptId: 'stage.verify',
    rule: 'правила кода, затем вердикт проверяющей модели; отказ возвращает на «Сборку»',
  },
  {
    id: 'replenish',
    title: 'Пополнение памяти',
    promptId: 'stage.replenish',
    rule: 'один вызов на три результата: решение о теме, факты, правила',
  },
  {
    id: 'deliver',
    title: 'Выдача',
    promptId: null,
    rule: 'строки в журнал этапов, ответ и событие «готово»; вызова модели нет',
  },
]

const INDEX_OF = Object.fromEntries(STAGES.map((stage, i) => [stage.id, i]))

/** Подрезка замечаний: сначала обезвреживание метки, потом жёсткий срез. */
export function safeRemarks(text) {
  return safeTag(String(text ?? ''), 'review').slice(0, VERIFY_REMARKS_CHARS)
}

export function createStagedAgent({
  agent,
  runs,
  env,
  sessions = null,
  stageLog = null,
  /**
   * Шов дня 14 (ADR 2026-09-22-0827, п. 1): объект из `invariants.js` или
   * `null`. У агента дня 13 он равен `null`, и каждое место ниже — `if (inv)`;
   * ни одного его промпта, события и числа это не меняет.
   */
  invariants: inv = null,
  policy = defaultPolicy,
  fetchImpl = fetch,
  now = Date.now,
  log = console.error,
}) {
  const baseSystem = agent.systemPrompt
  const limitsOf = () => fetchLimits(env, agent.taskClass, { fetchImpl }).catch(() => null)
  const lock = createSessionLock()
  const pauseTtlMs = env.PAUSE_TTL_MINUTES * 60_000

  return {
    id: agent.id,
    version: agent.version,
    tools: [...agent.tools],
    defaults: { ...agent.defaults },

    isBusy: lock.isBusy,
    hold: lock.hold,

    /**
     * Где живут настройки этого агента: свой столбец профиля, а не общий блок
     * дня 11 (решение владельца 2026-09-21, вариант «а»). Сервис читает это
     * поле, чтобы не знать имён агентов.
     */
    settingsStore: 'staged',

    /** Настройки профиля для дня 13: свои потолки и две настройки круга. */
    parseSettings(body) {
      return parseSettings(body, agent.defaults, LAYERED_MODELS, {
        review: true,
        contextMax: STAGE_CONTEXT_TOKENS,
        summarizeMax: STAGE_CONTEXT_TOKENS,
      })
    },

    /** Вход запуска — тот же, что у дня 11, плюс проверяющая модель и предел кругов. */
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
      if (sessions.sessionProfile(sessionId) !== profileId)
        return { ok: false, message: 'Диалог не найден в этом профиле' }

      const parsed = parseParams(body, {
        maxOutputTokens: LAYERED_MAX_TOKENS,
        defaults: agent.defaults,
        models: LAYERED_MODELS,
        contextMax: STAGE_CONTEXT_TOKENS,
      })
      if (!parsed.ok) return { ok: false, message: parsed.message }
      if (parsed.params.prompt === '') return { ok: false, message: 'Напишите сообщение' }

      const system = parseSystem(body.system)
      if (!system.ok) return { ok: false, message: system.message }
      const summarizeAt = parseSummarizeAt(
        body.summarizeAt,
        parsed.params.contextTokens,
        STAGE_CONTEXT_TOKENS,
      )
      if (!summarizeAt.ok) return { ok: false, message: summarizeAt.message }
      const strategy = parseStrategy(body.strategy)
      if (!strategy.ok) return { ok: false, message: strategy.message }
      const windowSize = parseWindow(body.window)
      if (!windowSize.ok) return { ok: false, message: windowSize.message }
      const factsTokens = parseFactsTokens(body.factsTokens)
      if (!factsTokens.ok) return { ok: false, message: factsTokens.message }
      const reviewModel = parseReviewModel(body.reviewModel, agent.defaults)
      if (!reviewModel.ok) return { ok: false, message: reviewModel.message }
      // Круги берутся только из входа запуска: день читает их из настроек
      // профиля и по тому же числу резервирует слоты лимитера (решение
      // владельца 2026-09-21). Умолчания реестра здесь нет — иначе запуск
      // сделал бы круги по одному числу, а слоты были бы заняты по другому.
      const reviewRounds = parseReviewRounds(body.reviewRounds)
      if (!reviewRounds.ok) return { ok: false, message: reviewRounds.message }
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
          reviewModel: reviewModel.value,
          reviewRounds: reviewRounds.value,
          parentId: parentId.value,
        },
      }
    },

    /**
     * Описание для реестра и окна настроек. Сверх дня 11 здесь этапы с их
     * промптами и предел кругов: страница берёт эти числа и тексты отсюда,
     * а не хранит их сама (ADR, п. 1 и 4).
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
      // Промпты этапов — те же константы, что уйдут в модель. У сжатия текст
      // зависит от порога: показывается с умолчанием контекста реестра.
      const prompts = {
        'stage.summary': buildSummaryRequest(null, [], agent.defaults.contextTokens).system,
        'stage.answer': baseSystem,
        'stage.verify': VERIFY_PROMPT,
        'stage.replenish': buildReplenishRequest({}).system,
      }
      // День 14 проверяет своим промптом: промпт дня 13 остаётся на месте и
      // со своим `sha8`, а окно «Об агенте» показывает тот текст, что уйдёт.
      if (inv) prompts['stage.verify'] = inv.prompts['stage.verify.invariants']
      // Промпт формулировщика к этапам не относится: его вызов идёт своим
      // каналом, мимо запуска, — но показать его «Об агенте» обязано.
      return {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        purpose: agent.purpose,
        systemPrompt: baseSystem,
        taskClass: agent.taskClass,
        tools: [],
        models,
        presets: [],
        defaults: agent.defaults,
        stages: STAGES.map((stage) => ({
          id: stage.id,
          title: stage.title,
          prompt: stage.promptId ? prompts[stage.promptId] : null,
          rule: stage.rule,
        })),
        // Инварианты профиля дня 14: их потолки и промпт формулировщика.
        // Страница не хранит эти числа сама — как и предел кругов.
        ...(inv
          ? {
              invariants: {
                cap: inv.cap,
                chars: inv.chars,
                draftChars: inv.draftChars,
                prefix: inv.prefix,
                prompt: inv.prompts['invariant.draft'],
              },
            }
          : {}),
        limits: {
          promptChars: PARAM_LIMITS.promptChars,
          systemChars: PARAM_LIMITS.systemChars,
          contextTokens: STAGE_CONTEXT_TOKENS,
          stageContextTokens: STAGE_CONTEXT_TOKENS,
          stopSequences: PARAM_LIMITS.stopSequences,
          stopChars: PARAM_LIMITS.stopChars,
          maxTokens: LAYERED_MAX_TOKENS,
          // Страница не хранит эти числа сама: предел кругов растёт в цене
          // запуска, и разойтись с сервисом ему нельзя.
          reviewRounds: { ...REVIEW_ROUNDS },
        },
      }
    },

    async execute(run) {
      const { profileId, sessionId, params, reviewModel, reviewRounds } = run.input
      const strategy = run.input.strategy ?? null
      const windowSize = run.input.window ?? null
      const summarizeAt = run.input.summarizeAt ?? null
      const system = run.input.system ?? baseSystem
      const systemOverridden = run.input.system !== null && run.input.system !== undefined
      const startedAt = now()

      // Состояние машины: что уже сделано, чтобы повторный вход в этап после
      // обрыва не делал этого второй раз (ADR, п. 1, «Вход идемпотентен»).
      const ctx = {
        round: 1,
        review: null,
        asked: false,
        answerId: null,
        answer: null,
        assembled: null,
        budget: null,
        context: null,
        topic: null,
        rules: [],
        needed: 0,
        marked: null,
        verdict: 'none',
        answerCalls: 0,
        memoryFailed: false,
        summarySpent: 0,
        summaryPaid: false,
        modelAsked: false,
        replenished: null,
        proposal: null,
        // Снимок инвариантов профиля на приёме и что с ними стало на выдаче
        // (ADR 2026-09-22-0827, п. 4). Без шва — пустой список и `unchecked`.
        invariants: [],
        invariantStatus: 'unchecked',
        withheld: null,
      }
      const tree = strategy !== null
      let nextParent = tree
        ? run.input.parentId === 0
          ? null
          : (run.input.parentId ?? sessions.head(sessionId))
        : null

      // Текущий этап и его промпт: их подмешивает `emit` в каждое событие,
      // чтобы монитор знал, на каком этапе и каким промптом сделан вызов.
      let current = { id: null, index: null, promptId: null, promptText: null }
      let lastCall = null
      const rows = []
      let pauses = 0

      const emit = (fields, options) => {
        // Этап подмешивается в каждое событие; заданный явно (ворота паузы)
        // остаётся своим.
        const data = { ...(fields.data ?? {}), state: fields.data?.state ?? current.id }
        if (fields.stage === 'llm_call' && current.promptId) {
          const promptTokens = estimateTokens(current.promptText ?? '')
          const requestTokens = Number.isFinite(data.requestTokens) ? data.requestTokens : 0
          data.promptId = current.promptId
          data.promptSha = promptSha8(current.promptText ?? '')
          data.promptTokens = promptTokens
          // Вход без промпта: столько стоит контекст этапа сам по себе.
          data.contextTokens = Math.max(0, requestTokens - promptTokens)
          lastCall = {
            promptId: data.promptId,
            promptSha: data.promptSha,
            promptTokens,
            contextTokens: data.contextTokens,
            // Потолок ответа этого вызова: при обрыве только он и известен
            // о выходе — верхняя граница того, что провайдер мог успеть
            // сгенерировать и выставить в счёт.
            maxOutputTokens: Number.isFinite(data.answerTokens) ? data.answerTokens : null,
            inputTokens: null,
            outputTokens: null,
          }
        }
        if (fields.stage === 'llm_result' && lastCall) {
          lastCall.inputTokens = fields.data?.usage?.inputTokens ?? null
          lastCall.outputTokens = fields.data?.usage?.outputTokens ?? null
        }
        return runs.emit(run.id, { ...fields, data }, options)
      }

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
            onlyIfLive: true,
          })
          if (id !== null && tree) {
            nextParent = id
            sessions.setHead(sessionId, id)
          }
          if (id === null) ctx.memoryFailed = true
          return id
        } catch (error) {
          ctx.memoryFailed = true
          log(`сессия ${sessionId.slice(0, 8)}…: запись не удалась: ${error.message}`)
          return null
        }
      }

      /** Строка журнала на проход этапа. Текстов в ней нет — только числа и коды. */
      const attempts = new Map()
      const logRow = ({ stage, index, enteredAt, outcome, verdict = '', errorCode = '' }) => {
        const attempt = (attempts.get(stage.id) ?? 0) + 1
        attempts.set(stage.id, attempt)
        const left = now()
        rows.push({
          run_id: run.id,
          session_id: sessionId,
          agent: agent.id,
          model: params.model,
          state: stage.id,
          state_index: index + 1,
          attempt,
          entered_at: new Date(enteredAt).toISOString(),
          left_at: new Date(left).toISOString(),
          duration_ms: left - enteredAt,
          outcome,
          pauses,
          llm_called: lastCall ? 'true' : 'false',
          prompt_id: lastCall?.promptId ?? '',
          prompt_sha8: lastCall?.promptSha ?? '',
          prompt_tokens: lastCall?.promptTokens ?? '',
          context_tokens: lastCall?.contextTokens ?? '',
          input_tokens: lastCall?.inputTokens ?? '',
          output_tokens: lastCall?.outputTokens ?? '',
          round: ctx.round,
          verdict,
          run_status: runs.get(run.id)?.status ?? 'running',
          error_code: errorCode,
        })
      }

      /** Дописать журнал: один раз на запуск, при любом исходе. */
      const flushLog = (status) => {
        if (!stageLog || rows.length === 0) return
        for (const row of rows) if (row.run_status === 'running') row.run_status = status
        stageLog.append(rows)
      }

      // Журнал дописывается после строки упавшего этапа, а не здесь: иначе
      // строка этапа, на котором запуск упал, в файл бы не попала.
      const fail = ({ code, message, status = null, paid = ctx.modelAsked, title }) => {
        if (ctx.asked) remember('agent', message, 0, { error: true, code })
        return runs.finish(run.id, {
          status: 'failed',
          error: { code, message, paidNothing: !(paid || ctx.summaryPaid) },
          event: {
            stage: 'error',
            level: 'error',
            title,
            detail: message,
            data: { code, status, state: current.id },
            durationMs: now() - startedAt,
          },
        })
      }

      /**
       * Вызов модели под обрывом паузы. Возвращает `{ interrupted: true }`,
       * если пауза оборвала `fetch` к роутеру: ответ выброшен, вход оплачен.
       */
      const callModel = async (fn) => {
        const controller = new AbortController()
        runs.setAbort(run.id, () => controller.abort())
        try {
          return { ok: true, answer: await fn(controller.signal) }
        } catch (error) {
          if (controller.signal.aborted && runs.get(run.id)?.paused) {
            return { ok: false, interrupted: true }
          }
          return { ok: false, error }
        } finally {
          runs.setAbort(run.id, null)
        }
      }

      // --- Этапы --------------------------------------------------------

      const intake = () => {
        if (!sessions.touchProfile(profileId)) {
          fail({
            code: 'unknown_profile',
            title: 'Профиль не найден',
            message: 'Профиль удалён или истёк — выберите другой на экране входа.',
          })
          return { failed: true }
        }
        // Снимок инвариантов профиля — одним запросом на приёме: что зафик-
        // сировано здесь, то и проверяется на выдаче (ADR 2026-09-22-0827,
        // п. 4). Пустой список стоит ноль токенов дальше по всем этапам.
        if (inv) {
          ctx.invariants = inv.snapshot(profileId)
          const tokens = inv.tokens(ctx.invariants)
          emit({
            stage: 'planning',
            title:
              ctx.invariants.length === 0
                ? 'Инварианты профиля: нет'
                : `Инварианты профиля: ${inv.numbers(ctx.invariants)} — ${ctx.invariants.length} из ${inv.cap}, ~${tokens} токенов`,
            detail:
              ctx.invariants.length === 0
                ? 'блока инвариантов не будет ни в одном запросе'
                : 'проверяются третьей строкой вердикта; на остальных этапах это иерархия промпта, а не проверка',
            data: {
              invariants: ctx.invariants.map((i) => i.num),
              cap: inv.cap,
              invariantTokens: tokens,
            },
          })
        }
        return { done: true }
      }

      /** Сжатие рабочей памяти — тот же вызов, что в дне 11, но под обрывом паузы. */
      const compress = async (previous, fresh) => {
        const cap = Math.min(
          STAGE_CONTEXT_TOKENS,
          summarizeAt + LAYERED_MAX_TOKENS + Math.ceil(PARAM_LIMITS.promptChars / 2),
        )
        const source = fitDialog(fresh, cap)
        const sourceTokens = (previous?.tokens ?? 0) + source.tokens
        const request = buildSummaryRequest(previous?.text ?? null, source.messages, summarizeAt)
        const requestSize = estimateTokens(request.system) + estimateTokens(request.input)
        current.promptId = 'stage.summary'
        current.promptText = request.system
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
        const called = await callModel((signal) => askSummary(request, env, { fetchImpl, signal }))
        if (called.interrupted) return { interrupted: true, inputTokens: requestSize }
        if (!called.ok) {
          if (!paidNothing(called.error)) ctx.summaryPaid = true
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Историю не сжал',
            detail: `${explainRouterError(called.error)}\nсводка прежняя, реплики идут хвостом`,
            data: { code: called.error.code ?? null, status: called.error.status ?? null },
            durationMs: now() - started,
          })
          return null
        }
        ctx.summaryPaid = true
        const answer = called.answer
        const text = answer.text.trim()
        const tokens = answer.usage.outputTokens ?? estimateTokens(text)
        const callTokens = (answer.usage.inputTokens ?? requestSize) + tokens
        ctx.summarySpent = callTokens
        emit({
          stage: 'llm_result',
          title: 'Сжал историю',
          detail: `${answer.provider?.model ?? SUMMARY_PROVIDER}, ${seconds(now() - started)}`,
          data: { provider: answer.provider, usage: answer.usage, truncated: answer.truncated },
          durationMs: now() - started,
        })
        if (text === '') {
          try {
            sessions.addSummaryCost(sessionId, callTokens)
          } catch (error) {
            log(`сессия ${sessionId.slice(0, 8)}…: цена сводки не записана: ${error.message}`)
          }
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
          ctx.memoryFailed = true
          log(`сессия ${sessionId.slice(0, 8)}…: сводка не записана: ${error.message}`)
          return null
        }
        if (!saved) return null
        const ratio = Math.round((tokens / sourceTokens) * 100) / 100
        emit({
          stage: 'planning',
          title: `Сжал историю: ${sourceTokens} → ${tokens} токенов`,
          detail: `порог ${summarizeAt}`,
          data: { sourceTokens, tokens, ratio, messages: source.messages.length },
        })
        return { text, tokens, sourceTokens, ratio, totalTokens: callTokens }
      }

      const assembleStage = async () => {
        const limits = await limitsOf()
        const budget = effectiveBudget(params.model, inputBudgetFor(params.model), limits)
        // Действующий потолок этапа — меньшее из 32 000 и предела модели.
        const cap = Math.min(STAGE_CONTEXT_TOKENS, budget.tokens)
        ctx.budget = { ...budget, cap }

        let interrupted = false
        const recalled = await recall({
          strategy,
          memory: true,
          sessions,
          sessionId,
          // Доля окна (`CONTEXT_SHARE`) к этому агенту не применяется: рабочая
          // память берёт остаток после промпта, правил, темы и запроса (ADR, п. 5).
          effective: Math.min(params.contextTokens, cap),
          requested: params.contextTokens,
          windowSize,
          summarizeAt,
          compress: async (previous, fresh) => {
            const done = await compress(previous, fresh)
            if (done?.interrupted) interrupted = true
            return done?.interrupted ? null : done
          },
          emit,
          from: run.input.parentId === 0 ? null : (run.input.parentId ?? undefined),
        })
        if (interrupted) return { interrupted: true }

        const state = sessions.sessionState(sessionId)
        ctx.rules = sessions.rulesOf(profileId)
        ctx.topic = state?.topicId
          ? {
              id: state.topicId,
              title: state.topicTitle,
              facts: sessions.topicFactsOf(state.topicId, TOPIC_FACT_CAP).map((f) => f.text),
            }
          : null

        const invariantsBlock =
          inv && ctx.invariants.length > 0 ? inv.block(ctx.invariants) : null
        const build = (transcript) =>
          policy.assemble({
            invariantsBlock,
            rules: ctx.rules,
            topic: ctx.topic,
            summaryText: recalled.summaryText,
            factsText: recalled.factsText ?? null,
            transcript,
            prompt: params.prompt,
            review: ctx.review,
            caps: STAGED_ASSEMBLE_CAPS,
          })
        const measure = (assembled) => estimateTokens(system) + estimateTokens(assembled.input)

        let transcript = recalled.transcript
        let assembled = build(transcript)
        let needed = measure(assembled)
        let droppedByCap = 0
        if (needed > cap) {
          // Под потолок режется рабочая память, а не замечания проверки:
          // иначе круг теряет смысл (ADR, п. 2).
          const base = measure(build([]))
          const fitted = fitDialog(transcript, Math.max(0, cap - base))
          droppedByCap = transcript.length - fitted.messages.length
          transcript = fitted.messages
          assembled = build(transcript)
          needed = measure(assembled)
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Рабочая память подрезана под потолок этапа',
            detail: `${droppedByCap} реплик не ушли модели; потолок ${cap} токенов`,
            data: { dropped: droppedByCap, capTokens: cap, review: ctx.review !== null },
          })
        }
        if (needed > cap) {
          fail({
            code: 'budget_too_small',
            title: 'Не хватает предела модели',
            message:
              `Запрос занимает ${needed} токенов, а потолок этапа сейчас ${cap} ` +
              `(модель даёт ${budget.tokens}). Уменьшите размер контекста или выберите другую модель.`,
          })
          return { failed: true }
        }

        ctx.assembled = assembled
        ctx.needed = needed
        ctx.context = {
          ...recalled.context,
          used: transcript.reduce((sum, m) => sum + m.tokens, 0),
          messages: transcript.length,
          dropped: (recalled.context.dropped ?? 0) + droppedByCap,
        }
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
          title: `Собрал запрос: ${assembled.stats.rules} правил, ${ctx.topic ? `тема «${ctx.topic.title}»` : 'темы нет'}`,
          detail:
            `правила ${assembled.stats.rulesTokens} токенов, факты темы ${assembled.stats.topicTokens} токенов; ` +
            `рабочая память ${ctx.context.used} токенов; весь запрос ${needed} при потолке ${cap}`,
          data: {
            ...assembled.stats,
            topicId: ctx.topic?.id ?? null,
            context: ctx.context,
            requestTokens: needed,
            capTokens: cap,
            round: ctx.round,
          },
        })
        return { done: true }
      }

      const answerStage = async () => {
        // Реплика посетителя записывается один раз на запуск: повторный вход
        // после обрыва её не удваивает (ADR, п. 1).
        if (!ctx.asked) {
          const askedId = remember('user', params.prompt, estimateTokens(params.prompt), null)
          if (askedId === null) {
            fail({
              code: 'session_gone',
              title: 'Диалог не найден',
              message: 'Диалог удалён — начните новый.',
            })
            return { failed: true }
          }
          ctx.asked = true
        }

        current.promptId = systemOverridden ? 'custom' : 'stage.answer'
        current.promptText = system
        const started = now()
        emit({
          stage: 'llm_call',
          title: 'Спросил модель',
          detail: `${params.model}, ${ctx.needed} токенов входа, ответ до ${params.maxTokens}`,
          data: {
            provider: params.model,
            taskClass: agent.taskClass,
            requestTokens: ctx.needed,
            answerTokens: params.maxTokens,
            temperature: params.temperature === 1 ? null : params.temperature,
            stopSequences: params.stopSequences.length,
            round: ctx.round,
          },
        })
        ctx.modelAsked = true
        const called = await callModel((signal) =>
          askLayered(
            { system, taskClass: agent.taskClass, input: ctx.assembled.input, params },
            env,
            { fetchImpl, signal },
          ),
        )
        if (called.interrupted) return { interrupted: true, inputTokens: ctx.needed }
        if (!called.ok) {
          const error = called.error
          log(`запуск ${run.id}: роутер: ${error.code ?? ''} ${error.message}`)
          fail({
            code: error.code ?? (error.status === 429 ? 'rate_limited' : 'router_error'),
            status: error.status ?? null,
            title: 'Модель не ответила',
            message: explainRouterError(error),
            paid: !paidNothing(error),
          })
          return { failed: true }
        }
        const answer = called.answer
        ctx.answer = answer
        ctx.answerCalls += 1
        const ms = now() - started
        emit({
          stage: 'llm_result',
          title: 'Получил ответ',
          detail: `${answer.provider?.model ?? params.model}, ${seconds(ms)}, ${answer.usage.inputTokens ?? '?'} → ${answer.usage.outputTokens ?? '?'} токенов`,
          data: {
            provider: answer.provider,
            usage: answer.usage,
            truncated: answer.truncated,
            providerDurationMs: answer.durationMs,
            round: ctx.round,
          },
          durationMs: ms,
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
        return { done: true }
      }

      /** Возврат на «Сборку» с замечаниями или пометка на последнем круге. */
      const verdictOutcome = (remarks, reason) => {
        const last = ctx.round >= reviewRounds
        if (last) {
          ctx.marked = { verdict: 'rejected', remarks, rounds: ctx.round, reason }
          return { verdict: 'rejected', marked: true }
        }
        ctx.review = remarks
        return { verdict: 'rejected', back: true }
      }

      const verifyStage = async () => {
        const text = (ctx.answer?.text ?? '').trim()

        // Статус инвариантов сбрасывается ПЕРВЫМ делом, а не при разборе
        // вердикта: из этого этапа есть три выхода до него — пустой ответ,
        // обрезанный ответ и запрос сверх предела проверяющей модели, — и на
        // них проверяющая модель ответа этого круга не видела вовсе. Пока
        // сброс стоял внутри разбора, такой ответ уносил пометку прошлого
        // круга, и карточка говорила «нарушений не нашла» о том, чего никто
        // не смотрел (находка reviewer к PR #200, остаток Б2). Ветка предела
        // здесь самая вероятная из трёх: запрос второго круга несёт `<review>`
        // и всегда больше первого, а блок инвариантов добавляет к нему до
        // 1060 токенов (ADR 2026-09-22-0827, «Последствия»).
        if (inv) ctx.invariantStatus = 'unchecked'

        // Правила кода — до вызова проверяющего: они дешевле и вернее.
        if (text === '') {
          const outcome = verdictOutcome(
            'Прошлый ответ пришёл пустым. Ответь на вопрос по существу.',
            'empty',
          )
          emit({
            stage: 'planning',
            title: outcome.back
              ? `Проверка: пустой ответ, круг ${ctx.round + 1} из ${reviewRounds}`
              : 'Проверка: пустой ответ, отдаю с пометкой',
            detail: 'вызова проверяющей модели не было: пустой ответ проверять нечем',
            data: { verdict: 'rejected', round: ctx.round, remarksChars: 0 },
          })
          return { done: true, ...outcome }
        }
        if (ctx.answer.truncated) {
          ctx.marked = { verdict: 'marked', remarks: '', rounds: ctx.round, reason: 'truncated' }
          emit({
            stage: 'planning',
            title: 'Проверка пропущена: ответ обрезан потолком токенов',
            detail: 'потолок ответа выбрали вы — повтор упёрся бы в него же; отдаю с пометкой',
            data: { verdict: 'marked', round: ctx.round, remarksChars: 0 },
          })
          return { done: true, verdict: 'marked' }
        }

        const verifyArgs = {
          rules: ctx.rules.map((rule) => `${rule.key} — ${rule.value}`),
          question: params.prompt,
          answer: text,
          truncated: ctx.answer.truncated,
        }
        // День 14 проверяет своим промптом и с блоком инвариантов; день 13 —
        // прежним, слово в слово (ADR 2026-09-22-0827, п. 5).
        const request = inv
          ? inv.verifyRequest({ ...verifyArgs, invariants: ctx.invariants })
          : buildVerifyRequest(verifyArgs)
        const size = estimateTokens(request.system) + estimateTokens(request.input)
        const limits = await limitsOf()
        const reviewBudget = effectiveBudget(reviewModel, inputBudgetFor(reviewModel), limits)
        if (size > reviewBudget.tokens) {
          // Проверяющая модель не тянет запрос (Groq, ноутбук): проверка
          // пропускается с пометкой, без вызова (ADR, п. 2).
          ctx.marked = { verdict: 'skipped', remarks: '', rounds: ctx.round, reason: 'budget' }
          emit({
            stage: 'planning',
            title: 'Проверка пропущена: предел проверяющей модели',
            detail: `запрос проверки ${size} токенов, у ${reviewModel} сейчас ${reviewBudget.tokens}; вызова не было`,
            data: {
              verdict: 'skipped',
              round: ctx.round,
              remarksChars: 0,
              requestTokens: size,
              budgetTokens: reviewBudget.tokens,
            },
          })
          return { done: true, verdict: 'skipped' }
        }

        current.promptId = inv ? 'stage.verify.invariants' : 'stage.verify'
        current.promptText = request.system
        const started = now()
        emit({
          stage: 'llm_call',
          title: 'Проверяю ответ',
          detail: `${reviewModel}, ${size} токенов входа, вердикт до ${VERIFY_ANSWER_TOKENS}`,
          data: {
            provider: reviewModel,
            taskClass: agent.taskClass,
            requestTokens: size,
            answerTokens: VERIFY_ANSWER_TOKENS,
            round: ctx.round,
            rounds: reviewRounds,
          },
        })
        const called = await callModel((signal) =>
          askVerify(request, env, {
            fetchImpl,
            signal,
            provider: reviewModel,
            taskClass: agent.taskClass,
          }),
        )
        if (called.interrupted) return { interrupted: true, inputTokens: size }
        if (!called.ok) {
          // Отказ проверяющей модели запуск не валит: ответ уже оплачен, и
          // мнения о нём просто нет.
          if (!paidNothing(called.error)) ctx.summaryPaid = true
          ctx.marked = { verdict: 'skipped', remarks: '', rounds: ctx.round, reason: 'error' }
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Проверка не состоялась',
            detail: `${explainRouterError(called.error)}\nответ отдаю с пометкой`,
            data: { code: called.error.code ?? null, status: called.error.status ?? null },
            durationMs: now() - started,
          })
          return { done: true, verdict: 'skipped' }
        }
        const ms = now() - started
        emit({
          stage: 'llm_result',
          title: 'Получил вердикт',
          detail: `${called.answer.provider?.model ?? reviewModel}, ${seconds(ms)}, ${called.answer.usage.inputTokens ?? '?'} → ${called.answer.usage.outputTokens ?? '?'} токенов`,
          data: {
            provider: called.answer.provider,
            usage: called.answer.usage,
            truncated: called.answer.truncated,
            round: ctx.round,
          },
          durationMs: ms,
        })

        const parsed = parseVerdict(called.answer.text)
        // Единственный модельный текст в событиях: замечания проверки. Метка
        // обезврежена, срез жёсткий — 300 знаков (ADR, «Последствия»).
        const remarks = safeRemarks(parsed.remarks)

        // Третья строка вердикта — единственная настоящая проверка дня 14
        // (ADR 2026-09-22-0827, п. 4 и 5). Разбирается до строки «вердикт»,
        // потому что названное нарушение сильнее её.
        if (inv && ctx.invariants.length > 0) {
          const judged = inv.parseVerdict(called.answer.text, ctx.invariants)
          // Статус ставится ПО ЭТОМУ кругу, а не копится: отдаётся ответ
          // последнего круга, и пометка обязана говорить о вердикте, который
          // судил именно его. Прежняя редакция накапливала «соблюдены» с
          // первого круга, и ответ круга, о котором вердикт промолчал, уходил
          // с чужой пометкой — прямо против гарантии «непроверенный ответ
          // помечен как непроверенный» (находка reviewer к PR #200; доля
          // вердиктов с третьей строкой у K2.6 не замерена).
          ctx.invariantStatus = judged.held ? 'held' : 'unchecked'
          if (judged.violated.length > 0) {
            const broken = ctx.invariants.filter((i) => judged.violated.includes(i.num))
            const named = broken
              .map((i) => `Нарушен инвариант профиля ${inv.render(i)}`)
              .join('\n')
            if (parsed.verdict === 'accepted') {
              emit({
                stage: 'planning',
                title: 'Проверка: «принято» вместе с названным нарушением — считаю нарушением',
                detail: `${inv.numbers(broken)}: инвариант сильнее строки вердикта`,
                data: { verdict: 'violated', round: ctx.round, invariants: judged.violated },
              })
            }
            const last = ctx.round >= reviewRounds
            if (last) {
              // Последний круг: ответ не отдаётся вовсе (решение владельца 2).
              ctx.withheld = {
                invariants: judged.violated,
                texts: broken.map((i) => i.text),
                remarks,
                round: ctx.round,
                rounds: reviewRounds,
              }
              emit({
                stage: 'planning',
                title: `Проверка: нарушен ${inv.numbers(broken)} на круге ${ctx.round} из ${reviewRounds} — ответ не отдан`,
                detail: remarks,
                data: {
                  verdict: 'violated',
                  round: ctx.round,
                  invariants: judged.violated,
                  remarksChars: remarks.length,
                },
              })
              return { done: true, verdict: 'violated', withheld: true }
            }
            // Не последний круг: модель видит дословно, что нарушила.
            ctx.review = safeRemarks(`${named}. ${remarks}`)
            emit({
              stage: 'planning',
              title: `Проверка: нарушен ${inv.numbers(broken)}, круг ${ctx.round + 1} из ${reviewRounds}`,
              detail: remarks,
              data: {
                verdict: 'violated',
                round: ctx.round,
                invariants: judged.violated,
                remarksChars: remarks.length,
              },
            })
            return { done: true, verdict: 'violated', back: true }
          }
        }

        if (parsed.verdict === null) {
          ctx.marked = { verdict: 'unparsed', remarks, rounds: ctx.round, reason: 'unparsed' }
          emit({
            stage: 'planning',
            title: 'Проверка: вердикт не разобран — считаю принятым, с пометкой',
            detail: remarks,
            data: { verdict: 'unparsed', round: ctx.round, remarksChars: remarks.length },
          })
          return { done: true, verdict: 'unparsed' }
        }
        if (parsed.verdict === 'accepted') {
          emit({
            stage: 'planning',
            title: 'Проверка: принято',
            detail: remarks,
            data: { verdict: 'accepted', round: ctx.round, remarksChars: remarks.length },
          })
          return { done: true, verdict: 'accepted' }
        }
        const outcome = verdictOutcome(remarks, 'rejected')
        emit({
          stage: 'planning',
          title: outcome.back
            ? `Проверка: отклонено, круг ${ctx.round + 1} из ${reviewRounds}`
            : 'Проверка: отклонено на последнем круге — отдаю с пометкой',
          detail: remarks,
          data: { verdict: 'rejected', round: ctx.round, remarksChars: remarks.length },
        })
        return { done: true, ...outcome }
      }

      /** Ответ в рабочую память: пишется принятый или последний, не отклонённый. */
      const keepAnswer = () => {
        const answer = ctx.answer
        const summary = {
          model: answer.provider?.model ?? params.model,
          provider: params.model,
          profileId,
          topicId: ctx.topic?.id ?? null,
          rules: ctx.assembled.stats.rules,
          rulesTokens: ctx.assembled.stats.rulesTokens,
          topicFacts: ctx.assembled.stats.topicFacts,
          topicTokens: ctx.assembled.stats.topicTokens,
          inputTokens: answer.usage.inputTokens,
          outputTokens: answer.usage.outputTokens,
          totalTokens:
            (answer.usage.inputTokens ?? ctx.needed) +
            (answer.usage.outputTokens ?? estimateTokens(answer.text)),
          durationMs: now() - startedAt,
          budgetTokens: ctx.budget.tokens,
          capTokens: ctx.budget.cap,
          contextUsed: ctx.context.used,
          contextEffective: ctx.context.effective,
          contextRequested: ctx.context.requested,
          contextMessages: ctx.context.messages,
          truncated: answer.truncated,
          systemOverridden,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          stopSequences: params.stopSequences.length,
          reviewModel,
          reviewRounds,
          rounds: ctx.round,
          // Сколько проходов этапов запуск сделал к этой минуте: считая
          // текущую «Проверку», чья строка журнала пишется следом. На
          // «Выдаче» число уточняется правкой этой же сводки — там оно
          // окончательное, а карточка ответа живёт 30 часов и собирать его
          // из событий и CSV с другими сроками жизни ей нечем.
          stagesPassed: rows.length + 1,
          // Пометка проверки — у сообщения, а не в событии: карточка ответа
          // показывает её и после перезагрузки страницы.
          review: ctx.marked
            ? { ...ctx.marked }
            : { verdict: ctx.verdict, remarks: '', rounds: ctx.round },
          // Пометка инвариантов — у сообщения, как и пометка проверки:
          // карточка ответа показывает её и после перезагрузки (п. 4, этап 6).
          ...(inv
            ? {
                invariants: {
                  checked: ctx.invariants.map((i) => i.num),
                  status: ctx.invariantStatus,
                },
              }
            : {}),
          ...(strategy !== null ? { strategy } : {}),
          ...(summarizeAt !== null ? { summarizeAt } : {}),
        }
        ctx.summary = summary
        ctx.answerId = remember(
          'agent',
          answer.text,
          answer.usage.outputTokens ?? estimateTokens(answer.text),
          summary,
        )
      }

      const replenishStage = async () => {
        // Ответ не отдан — пополнять память нечем: оплаченного ответа не
        // существует ни для переписки, ни для правил. Пропуск обеспечен
        // порядком этапов, а не намерением: вердикт ставится на четвёртом
        // этапе, пополнение идёт пятым (ADR 2026-09-22-0827, п. 4 и 5).
        if (ctx.withheld) {
          emit({
            stage: 'planning',
            title: 'Пополнение памяти пропущено: ответ не отдан',
            detail: 'вызова не было; ни фактов, ни правил из этого ответа не записано',
            data: { outcome: 'skipped', round: ctx.round },
          })
          return { done: true, skipped: true }
        }
        const answer = ctx.answer
        const controller = new AbortController()
        runs.setAbort(run.id, () => controller.abort())
        // Обрыв судится по брошенному вызову, а не по состоянию сигнала
        // после возврата: пауза, пришедшая уже после полученного ответа,
        // `fetch` не рвёт, и выбрасывать оплаченное пополнение вместе с
        // записанными фактами и правилами было бы вторым вызовом за то же
        // (находка ревьюера, PR #183).
        let abortedCall = false
        const ask = async (request, callEnv, options) => {
          try {
            return await askSummary(request, callEnv, options)
          } catch (error) {
            if (controller.signal.aborted) abortedCall = true
            throw error
          }
        }
        let replenished
        try {
          replenished = await policy.replenish({
            sessions,
            sessionId,
            profileId,
            answerId: ctx.answerId,
            pair: [
              { role: 'user', text: params.prompt, tokens: estimateTokens(params.prompt) },
              {
                role: 'agent',
                text: answer.text,
                tokens: answer.usage.outputTokens ?? estimateTokens(answer.text),
              },
            ],
            emit: (fields) => {
              if (fields.stage === 'llm_call') {
                current.promptId = 'stage.replenish'
                current.promptText = buildReplenishRequest({}).system
              }
              return emit(fields)
            },
            ask,
            env,
            fetchImpl,
            now,
            log,
            caps: STAGED_REPLENISH_CAPS,
            // Блок инвариантов в запросе пополнения — граница тому, что
            // модель запишет правилом (ADR 2026-09-22-0827, п. 4, этап 5).
            invariantsBlock:
              inv && ctx.invariants.length > 0 ? inv.recordBlock(ctx.invariants) : null,
            signal: controller.signal,
          })
        } finally {
          runs.setAbort(run.id, null)
        }
        if (abortedCall && runs.get(run.id)?.paused) return { interrupted: true }
        if (replenished.paid) ctx.summaryPaid = true
        ctx.replenished = replenished

        if (replenished.report?.proposal) {
          const { title } = replenished.report.proposal
          const where = replenished.report.topicTitle
            ? `продолжить в «${replenished.report.topicTitle}»`
            : 'продолжить без темы'
          const text = `Похоже, мы перешли к другому предмету — «${title}». Открыть новую тему или ${where}?`
          const id = remember('agent', text, estimateTokens(text), {
            topicProposal: { title, facts: replenished.report.proposal.facts },
          })
          ctx.proposal = { title, facts: replenished.report.proposal.facts, messageId: id }
        }
        return { done: true }
      }

      const deliverStage = () => {
        const answer = ctx.answer
        const totalMs = now() - startedAt
        const answerTokens =
          (answer.usage.inputTokens ?? ctx.needed) +
          (answer.usage.outputTokens ?? estimateTokens(answer.text))
        const totalTokens = answerTokens + ctx.summarySpent + (ctx.replenished?.spent ?? 0)

        // След для посетителя, когда ответ не отдан (ADR 2026-09-22-0827,
        // п. 5): номер, текст, круг и замечания. Сам ответ не показывается
        // нигде — ни в переписке, ни в результате, ни в событии.
        if (ctx.withheld) {
          const named = ctx.withheld.invariants
            .map((num, i) => `${inv.numbers([num])} «${ctx.withheld.texts[i]}»`)
            .join(', ')
          const text =
            `Ответ не отдан: нарушает инвариант профиля ${named} ` +
            `(круг ${ctx.withheld.round} из ${ctx.withheld.rounds}).` +
            (ctx.withheld.remarks ? `\nЗамечания проверки: ${ctx.withheld.remarks}` : '')
          remember('agent', text, 0, {
            withheld: {
              invariants: ctx.withheld.invariants,
              round: ctx.withheld.round,
              rounds: ctx.withheld.rounds,
            },
          })
        }

        if (ctx.memoryFailed) {
          emit({
            stage: 'warning',
            level: 'warn',
            title: 'Не записал разговор',
            detail: ctx.withheld
              ? 'объяснение показано, но в переписку не попало'
              : 'ответ показан, но в переписку не попал — после перезагрузки его не будет',
            data: { memory: 'failed' },
          })
        }
        logRow({
          stage: STAGES[INDEX_OF.deliver],
          index: INDEX_OF.deliver,
          enteredAt: deliverEnteredAt,
          outcome: 'done',
        })
        // Окончательное число пройденных этапов — у сообщения: строк журнала
        // ровно столько же, и карточка ответа не собирает его сама.
        const stagesPassed = rows.length
        if (ctx.answerId !== null && ctx.summary) {
          ctx.summary.stagesPassed = stagesPassed
          try {
            sessions.updateMessageMeta({
              sessionId,
              messageId: ctx.answerId,
              meta: ctx.summary,
            })
          } catch (error) {
            log(`сессия ${sessionId.slice(0, 8)}…: сводка ответа не уточнена: ${error.message}`)
          }
        }
        flushLog('succeeded')
        runs.finish(run.id, {
          status: 'succeeded',
          result: {
            // Ответ с названным нарушением не отдаётся: его нет ни здесь, ни
            // в переписке, ни в событиях (решение владельца 2).
            answer: ctx.withheld ? null : answer.text,
            ...(ctx.withheld
              ? {
                  withheld: {
                    invariants: ctx.withheld.invariants,
                    texts: ctx.withheld.texts,
                    remarks: ctx.withheld.remarks,
                    round: ctx.withheld.round,
                    rounds: ctx.withheld.rounds,
                  },
                }
              : {}),
            memoryFailed: ctx.memoryFailed,
            summary: ctx.summary,
            context: ctx.context,
            totalTokens,
            model: answer.provider,
            usage: answer.usage,
            truncated: answer.truncated,
            durationMs: answer.durationMs,
            systemOverridden,
            // Сколько кругов запуск потратил: день резервирует `reviewRounds`
            // слотов лимитера ДО запуска одним синхронным шагом (I-4) и по
            // этому числу возвращает лишние — по `end` и только если `end`
            // дошёл. При обрыве потока слоты остаются занятыми: это цена
            // правила, а не дефект (ADR 2026-09-21-1747, п. 5).
            rounds: ctx.answerCalls,
            stagesPassed,
            reviewRounds,
            reviewModel,
            marked: ctx.marked !== null,
            review: ctx.marked ?? { verdict: ctx.verdict, remarks: '', rounds: ctx.round },
            layers: {
              topicId: ctx.replenished?.report?.topicId ?? ctx.topic?.id ?? null,
              topicTitle: ctx.replenished?.report?.topicTitle ?? ctx.topic?.title ?? null,
              factsWritten: ctx.replenished?.report?.factsWritten ?? 0,
              rulesWritten: ctx.replenished?.report?.rulesWritten ?? 0,
              parked: ctx.replenished?.report?.factsParked ?? 0,
              switched: ctx.replenished?.report?.switched ?? null,
              proposal: ctx.proposal,
            },
          },
          event: {
            stage: 'done',
            title: ctx.withheld ? 'Ответ не отдан: нарушен инвариант профиля' : 'Отдал ответ',
            detail: `весь запуск ${seconds(totalMs)}`,
            data: {
              state: 'deliver',
              rounds: ctx.answerCalls,
              marked: ctx.marked !== null,
              ...(ctx.withheld ? { withheld: ctx.withheld.invariants } : {}),
            },
            durationMs: totalMs,
          },
        })
      }

      let deliverEnteredAt = startedAt

      // --- Цикл машины ---------------------------------------------------

      let beat = null
      try {
        current = { id: null, index: null, promptId: null, promptText: null }
        emit({
          stage: 'received',
          title: 'Получил запрос',
          detail: `модель ${params.model}, проверяет ${reviewModel}, кругов до ${reviewRounds}`,
          data: {
            model: params.model,
            reviewModel,
            reviewRounds,
            maxTokens: params.maxTokens,
            temperature: params.temperature,
            promptChars: params.prompt.length,
            stopSequences: params.stopSequences.length,
            strategy,
            systemOverridden,
            systemChars: system.length,
            stages: STAGES.length,
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

        // Индикатор работы: удар раз в секунду, пока запуск идёт и не на
        // паузе. Не хранится и в журнал не попадает (ADR, п. 8).
        beat = setInterval(() => {
          const live = runs.get(run.id)
          if (!live || TERMINAL.has(live.status) || live.paused) return
          try {
            emit(
              {
                stage: 'beat',
                title: 'Работаю',
                data: { elapsedMs: now() - startedAt },
              },
              { store: false },
            )
          } catch {
            // Гонка с завершением запуска: удар после `finish` просто не нужен.
          }
        }, BEAT_MS)
        beat.unref?.()

        let index = 0
        while (index < STAGES.length) {
          // Ворота паузы — перед каждым этапом, включая повторный вход после
          // обрыва вызова (ADR, п. 3).
          const live = runs.get(run.id)
          // Отмена проверяется до решения ждать: её могли попросить, пока
          // запуск разматывал прерванный вызов, и ворот тогда ещё не было
          // (находка гейта, PR #183).
          if (live?.cancelRequested || live?.paused) {
            let outcome = 'cancel'
            if (!live.cancelRequested) {
              pauses += 1
              emit({
                stage: 'paused',
                title: 'Пауза',
                detail: `запуск стоит на этапе «${STAGES[index].title}»`,
                data: {
                  state: STAGES[index].id,
                  index: index + 1,
                  of: STAGES.length,
                  round: ctx.round,
                  interruptedCall: live.interruptedCall,
                },
              })
              outcome = await runs.waitResume(run.id, pauseTtlMs)
            }
            if (outcome !== 'resume') {
              // Запуск мог быть завершён не этим циклом: тогда ни писать
              // реплику, ни завершать второй раз нельзя — остаётся снять
              // замок в `finally` и дописать журнал тем статусом, который у
              // запуска уже стоит.
              const current = runs.get(run.id)
              if (!current || TERMINAL.has(current.status)) {
                lastCall = null
                flushLog(current?.status ?? 'cancelled')
                return
              }
              const message =
                outcome === 'expired'
                  ? `Запуск отменён: пауза дольше ${env.PAUSE_TTL_MINUTES} минут`
                  : 'Запуск отменён: диалог очищен'
              // Реплика отмены пишется и тогда, когда вопрос записать не успели:
              // посетитель видит на экране своё сообщение и обязан узнать, что
              // ответа не будет (ADR, п. 3, критерий 6).
              if (outcome === 'expired') remember('agent', message, 0, { cancelled: true })
              // Строка отмены — про ожидание, а не про вызов: `lastCall` от
              // прерванного этапа уже записан своей строкой, и второй раз
              // тот же оплаченный вызов в журнале появляться не должен
              // (находка ревьюера, PR #183).
              lastCall = null
              logRow({
                stage: STAGES[index],
                index,
                enteredAt: now(),
                outcome: 'paused',
                errorCode: outcome,
              })
              flushLog('cancelled')
              runs.finish(run.id, {
                status: 'cancelled',
                result: null,
                error: null,
                event: {
                  stage: 'done',
                  title: message,
                  detail: `запуск стоял на этапе «${STAGES[index].title}»`,
                  data: { state: STAGES[index].id, reason: outcome },
                  durationMs: now() - startedAt,
                },
              })
              return
            }
            const resumed = runs.get(run.id)
            emit({
              stage: 'resumed',
              title: resumed.interruptedCall ? 'Продолжаю: вызов повторяется' : 'Продолжаю',
              detail: `этап «${STAGES[index].title}»`,
              data: {
                state: STAGES[index].id,
                index: index + 1,
                of: STAGES.length,
                round: ctx.round,
                interruptedCall: resumed.interruptedCall,
              },
            })
            resumed.interruptedCall = false
          }

          const stage = STAGES[index]
          const enteredAt = now()
          lastCall = null
          current = { id: stage.id, index, promptId: null, promptText: null }
          runs.setState(run.id, { state: stage.id, index, round: ctx.round })
          emit({
            stage: 'state',
            title: `Этап ${index + 1} из ${STAGES.length}: ${stage.title}`,
            detail: stage.promptId ? '' : `без вызова модели: ${stage.rule}`,
            data: {
              state: stage.id,
              index: index + 1,
              of: STAGES.length,
              round: ctx.round,
              promptId: stage.promptId,
              promptTokens: null,
            },
          })
          if (stage.id === 'deliver') deliverEnteredAt = enteredAt

          let outcome
          if (stage.id === 'intake') outcome = intake()
          else if (stage.id === 'assemble') outcome = await assembleStage()
          else if (stage.id === 'answer') outcome = await answerStage()
          else if (stage.id === 'verify') outcome = await verifyStage()
          else if (stage.id === 'replenish') outcome = await replenishStage()
          else {
            deliverStage()
            return
          }

          if (outcome.failed) {
            logRow({ stage, index, enteredAt, outcome: 'failed' })
            flushLog('failed')
            return
          }
          if (outcome.interrupted) {
            const livePaused = runs.get(run.id)
            if (livePaused) livePaused.interruptedCall = true
            // Оценка входа: своя, по `estimateTokens`, — числа провайдера при
            // обрыве не приходит вовсе. Если этап её не назвал (пополнение
            // строит запрос внутри политики), берём её же из события вызова:
            // «вход ? токенов» не говорит посетителю ничего.
            const paidInput =
              outcome.inputTokens ??
              (lastCall ? lastCall.promptTokens + lastCall.contextTokens : null)
            // Цена обрыва — честная верхняя оценка (решение владельца
            // 2026-09-21): провайдер тарифицирует и уже сгенерированный
            // выход, а числа его при обрыве не возвращает вовсе. Поэтому
            // называем вход оценкой и верхнюю границу выхода — потолок
            // ответа этого вызова, — и прямо говорим, что это оценка
            // приложения, а не счёт.
            const maxOutput = lastCall?.maxOutputTokens ?? null
            emit({
              stage: 'warning',
              level: 'warn',
              title: 'Вызов прерван',
              detail:
                `вход ${paidInput ?? '?'} токенов оплачен; выход — не больше ${maxOutput ?? '?'} токенов, ` +
                'сколько модель успела сгенерировать до обрыва, оплачено тоже, а ответ выброшен. ' +
                'Оба числа — оценка приложения, а не счёт поставщика: при обрыве провайдер своих чисел не возвращает.',
              data: {
                state: stage.id,
                inputTokens: paidInput,
                maxOutputTokens: maxOutput,
                estimated: true,
                round: ctx.round,
              },
            })
            logRow({ stage, index, enteredAt, outcome: 'interrupted' })
            // Этап входится заново: ворота наверху цикла держат запуск, пока
            // стоит пауза. Повторный вызов стоит слота лимитера дня, как новое
            // сообщение (ADR, п. 3).
            continue
          }
          if (stage.id === 'verify') {
            ctx.verdict = outcome.verdict
            // Отклонённый ответ в рабочую память не идёт: в переписке
            // остаётся принятый или последний. Неотданный — тем более:
            // оплаченный ответ с названным нарушением не пишется никуда.
            if (!outcome.back && !outcome.withheld) keepAnswer()
            logRow({ stage, index, enteredAt, outcome: 'done', verdict: outcome.verdict })
            if (outcome.back) {
              ctx.round += 1
              ctx.answer = null
              index = INDEX_OF.assemble
              continue
            }
            index += 1
            continue
          }
          logRow({ stage, index, enteredAt, outcome: outcome.skipped ? 'skipped' : 'done' })
          index += 1
        }
      } catch (error) {
        log(`запуск ${run.id}: ${error.stack ?? error.message}`)
        const live = runs.get(run.id)
        if (live && !TERMINAL.has(live.status)) {
          fail({
            code: 'internal',
            title: 'Внутренняя ошибка агента',
            message: 'Внутренняя ошибка агента',
          })
          flushLog('failed')
        }
      } finally {
        if (beat) clearInterval(beat)
        lock.release(sessionId)
      }
    },
  }
}

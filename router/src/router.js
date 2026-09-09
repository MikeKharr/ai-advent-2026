// Ядро маршрутизации (ADR 2026-09-08-1748). Три механизма и только три:
// возможность → отказ, политика → порядок, здоровье → пропуск. Ошибка
// первого — отказ, второго — фолбэк не более одного раза, третьего — пропуск.

import { createHash } from 'node:crypto'
import { ADAPTERS } from './adapters/index.js'
import { capabilityFit, orderedCandidates, PROFILE_DEFAULTS, THINKING_TOKENS } from './config.js'
import { createHealth } from './health.js'

const MAX_CALLS = 2
const DATA_RANK = { public: 0, internal: 1, personal: 2 }
const CACHE_KEY_VERSION = '1'
// Причины `error.cause.code`, которые означают «до провайдера не достучаться»,
// а не «провайдер ответил плохо». Только они идут в отрицательный кэш.
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

export function createRouter({
  config,
  registry,
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
  env = process.env,
  adapters = ADAPTERS,
}) {
  const health = createHealth({ now })
  const stats = new Map()

  const bump = (p, field) => {
    const k = `${p.id}#${p.revision}`
    if (!stats.has(k)) stats.set(k, { attempts: 0, ok: 0, failed: 0, skipped: 0 })
    stats.get(k)[field] += 1
  }

  function resolveClass(name) {
    // Неизвестный класс — это other, а не исключение.
    return config.classes[name] ? name : 'other'
  }

  function resolveThinking(cls, requested) {
    if (requested === undefined || requested === cls.thinking) return { level: cls.thinking }
    if (cls.locked) return { error: `класс закреплён за уровнем ${cls.thinking}` }
    if (!(requested in THINKING_TOKENS))
      return { error: `неизвестный уровень размышлений ${requested}` }
    return { level: requested }
  }

  async function route(req) {
    const taskClass = resolveClass(req.taskClass)
    const cls = config.classes[taskClass]
    const reasons = []
    const refuse = (code, message, why) => {
      log({ event: 'refuse', taskClass, code, message, reasons: why })
      return { ok: false, code, message, reasons: why, attempts: [] }
    }

    // Уровень размышлений — только из реестра классов. Override — лишь для
    // незакрытых классов; для закрытых это отказ, не тихое понижение.
    const th = resolveThinking(cls, req.thinking)
    if (th.error)
      return refuse('refused', `класс ${taskClass}: ${th.error}`, [
        {
          provider: null,
          stage: 'capability',
          reason: `запрошен уровень ${req.thinking}`,
        },
      ])
    const thinking = th.level

    // Класс данных из запроса может только сужать круг провайдеров
    // (public → internal → personal), но не расширять его.
    const dataClass = req.dataClass ?? cls.dataClass
    if (DATA_RANK[dataClass] === undefined || DATA_RANK[dataClass] < DATA_RANK[cls.dataClass])
      return refuse(
        'refused',
        `класс данных ${dataClass} шире, чем ${cls.dataClass} у класса ${taskClass}`,
        [],
      )

    const schema = req.schema ?? null
    // Явная схема в запросе — это требование возможности json_schema.
    const extraRequires = [...(req.requires ?? []), ...(schema ? ['json_schema'] : [])]
    const requires = [...(cls.requires ?? []), ...extraRequires]
    const strict = schema !== null || requires.includes('json_schema')
    // Класс со схемой без схемы — граница, а не тихий свободный текст.
    if (strict && schema === null)
      return refuse('refused', `класс ${taskClass} требует schema в запросе`, [])

    // Потолок ответа: по умолчанию из реестра классов, вызывающий может
    // сдвинуть его в пределах объявленного классом максимума.
    const answerTokens = cls.answerTokens
    let requestedAnswerTokens = answerTokens
    if (req.answerTokens !== undefined) {
      const max = cls.maxAnswerTokens ?? answerTokens
      if (!Number.isInteger(req.answerTokens) || req.answerTokens < 1 || req.answerTokens > max)
        return refuse('refused', `answerTokens: целое от 1 до ${max} для класса ${taskClass}`, [])
      requestedAnswerTokens = req.answerTokens
    }

    const inputTokens = estimateTokens(req.input) + estimateTokens(req.system ?? '')
    const providers = registry.list()
    // Явный выбор вызывающего (день 5: пользователь выбирает модель до
    // запуска). Политика тогда не решает — но возможность, класс данных и
    // здоровье проверяются как обычно, и фолбэка нет: ответ обязан прийти
    // от той модели, которую выбрали, либо не прийти вовсе.
    const explicit = req.provider ?? null
    let candidates
    if (explicit) {
      candidates = providers.filter(
        (p) => p.id === explicit || `${p.id}#${p.revision}` === explicit,
      )
      if (candidates.length === 0)
        return refuse('no_provider', `провайдер ${explicit} не найден в реестре`, [])
      const allowed = orderedCandidates(cls, providers).some((p) => p.id === candidates[0].id)
      if (!allowed)
        return refuse(
          'refused',
          `провайдер ${explicit} вне ярусов класса ${taskClass}: ${cls.tiers.join(',')}`,
          [
            {
              provider: explicit,
              stage: 'policy',
              reason: `ярус ${candidates[0].tier} не разрешён классу`,
            },
          ],
        )
    } else {
      candidates = orderedCandidates(cls, providers)
    }
    if (candidates.length === 0)
      return refuse(
        'no_provider',
        `для класса ${taskClass} нет ни одного провайдера в ярусах ${cls.tiers.join(',')}`,
        [],
      )

    // 1. Возможность: статичная, несоответствие — отказ.
    const capable = []
    for (const p of candidates) {
      const fit = capabilityFit(p, cls, thinking, dataClass, inputTokens, extraRequires)
      if (fit.ok) capable.push(p)
      else
        reasons.push({
          provider: `${p.id}#${p.revision}`,
          stage: 'capability',
          reason: fit.reason,
        })
    }
    if (capable.length === 0)
      return refuse(
        'refused',
        `ни один провайдер класса ${taskClass} не удовлетворяет требованиям`,
        reasons,
      )

    // Потолок вызывающего — на весь route(), не на каждую попытку.
    const budgetUntil = req.budgetMs ? now() + req.budgetMs : null

    // 2–3. Политика задала порядок; здоровье пропускает; не больше двух вызовов.
    const attempts = []
    let fallback = null
    let calls = 0
    const maxCalls = explicit ? 1 : MAX_CALLS
    for (const p of capable) {
      if (calls >= maxCalls) break
      const skip = health.unavailableReason(p)
      if (skip) {
        reasons.push({
          provider: `${p.id}#${p.revision}`,
          stage: 'health',
          reason: skip,
        })
        bump(p, 'skipped')
        log({
          event: 'skip',
          taskClass,
          provider: `${p.id}#${p.revision}`,
          thinking,
          reason: skip,
        })
        continue
      }
      const quota = health.quotaOf(p)
      if (
        quota?.remainingTokens !== null &&
        quota !== null &&
        inputTokens > quota.remainingTokens
      ) {
        const when = quota.resetAt ? new Date(quota.resetAt).toISOString() : 'неизвестно когда'
        reasons.push({
          provider: `${p.id}#${p.revision}`,
          stage: 'health',
          reason: `остаток квоты ${quota.remainingTokens} токенов меньше входа ${inputTokens}, сброс ${when}`,
        })
        bump(p, 'skipped')
        continue
      }
      if (budgetUntil !== null && budgetUntil - now() <= 0) {
        reasons.push({
          provider: `${p.id}#${p.revision}`,
          stage: 'call',
          reason: 'потолок budgetMs исчерпан до вызова',
        })
        break
      }
      calls += 1
      if (calls === 2)
        fallback = {
          from: attempts.at(-1).provider,
          reason: attempts.at(-1).reason,
        }
      const attempt = await tryProvider(p, {
        cls,
        req,
        answerTokens: requestedAnswerTokens,
        thinking,
        inputTokens,
        schema,
        strict,
        requires,
        budgetUntil,
      })
      attempts.push(attempt)
      bump(p, 'attempts')
      log({
        event: 'call',
        taskClass,
        provider: attempt.provider,
        thinking,
        outcome: attempt.outcome,
        reason: attempt.reason,
        durationMs: attempt.durationMs,
      })
      if (attempt.outcome === 'ok') {
        bump(p, 'ok')
        return {
          ok: true,
          text: attempt.text,
          json: attempt.json,
          provider: {
            id: p.id,
            revision: p.revision,
            kind: p.kind,
            model: p.model,
            tier: p.tier,
          },
          thinking,
          truncated: attempt.truncated,
          durationMs: attempt.durationMs,
          usage: attempt.usage,
          metrics: attempt.metrics,
          attempts,
          fallback,
          cacheKey: cacheKey({
            taskClass,
            p,
            thinking,
            promptVersion: req.promptVersion,
            input: req.input,
          }),
        }
      }
      // Прерывание по потолку вызывающего — не неудача провайдера и в метриках.
      if (attempt.outcome !== 'aborted') bump(p, 'failed')
      reasons.push({
        provider: attempt.provider,
        stage: 'call',
        reason: attempt.reason,
      })
      // Прерывание по потолку вызывающего — второго не зовём: времени нет.
      // Обрезанный и неразобранный ответ схемного класса — тоже: ответ был,
      // но негодный; второй вызов с тем же лимитом даст то же (ADR §7).
      if (attempt.outcome === 'aborted' || attempt.outcome === 'truncated') break
    }
    // Свой потолок вызывающего — отдельный код: это не инцидент провайдера.
    const aborted = attempts.at(-1)?.outcome === 'aborted'
    const result = aborted
      ? refuse('aborted', `потолок вызывающего ${req.budgetMs} мс истёк`, reasons)
      : refuse('all_failed', `все провайдеры класса ${taskClass} недоступны или отказали`, reasons)
    result.attempts = attempts
    result.thinking = thinking
    return result
  }

  async function tryProvider(
    p,
    { req, answerTokens, thinking, inputTokens, schema, strict, requires, budgetUntil },
  ) {
    const providerId = `${p.id}#${p.revision}`
    const maxOutputTokens = answerTokens + THINKING_TOKENS[thinking]
    const deadline = deadlineMs(p, { inputTokens, answerTokens, thinking })
    const started = now()
    const done = (outcome, reason, extra = {}) => ({
      provider: providerId,
      outcome,
      reason,
      durationMs: now() - started,
      usage: extra.usage ?? null,
      // Оценка входа нужна учёту и тогда, когда провайдер usage не вернул:
      // неудачный вызов тоже принял вход.
      estimatedInputTokens: inputTokens,
      ...extra,
    })

    // Два сигнала: дедлайн вызова — в предохранитель; потолок вызывающего
    // (budgetMs) только прерывает и в предохранитель не идёт (ADR, «Таймауты»).
    const ctrl = new AbortController()
    const timers = [setTimeout(() => ctrl.abort('deadline'), deadline)]
    if (budgetUntil !== null)
      timers.push(setTimeout(() => ctrl.abort('budget'), Math.max(0, budgetUntil - now())))

    health.acquire(p)
    try {
      const result = await adapters[p.kind].call(
        {
          provider: p,
          model: p.model,
          prompt: req.input,
          system: req.system,
          schema,
          stop: req.stop ?? [],
          tools: requires.filter((r) => r === 'web_search'),
          thinking: { level: thinking, value: p.thinking[thinking] },
          answerTokens,
          maxOutputTokens,
          temperature: req.temperature,
          signal: ctrl.signal,
        },
        { fetchImpl, env, now },
      )
      health.noteQuota(p, result.quota)
      const text = (result.text ?? '').trim()
      if (text.length === 0) {
        health.failure(p)
        return done('empty', 'пустой ответ при 200', { usage: result.usage })
      }
      const truncated = result.stopReason === 'length'
      let json = null
      if (strict) {
        // Для класса со схемой неудача — только если объект не разбирается;
        // обрезанный, но разобравшийся ответ — успех с truncated (ADR §7).
        try {
          json = JSON.parse(text)
        } catch {
          health.failure(p)
          return done(
            truncated ? 'truncated' : 'invalid_json',
            truncated
              ? 'ответ обрезан по лимиту токенов, объект не разбирается'
              : 'ответ не разбирается как JSON',
            { usage: result.usage },
          )
        }
      }
      health.success(p)
      return done('ok', null, {
        text,
        json,
        truncated,
        usage: result.usage,
        metrics: result.metrics,
      })
    } catch (error) {
      // Квота приходит и с 413, и с 429 — там она особенно нужна.
      health.noteQuota(p, error.quota)
      if (ctrl.signal.aborted && ctrl.signal.reason === 'budget')
        return done('aborted', `потолок вызывающего ${req.budgetMs} мс истёк`)
      if (error.status === 429) {
        health.busy(p, error.retryAfterMs)
        return done('busy', `429, занят${error.retryAfterMs ? ` на ${error.retryAfterMs} мс` : ''}`)
      }
      if (isUnreachable(error)) {
        health.unreachable(p)
        return done('unreachable', `недоступен: ${error.cause?.code ?? error.message}`)
      }
      if (ctrl.signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') {
        health.failure(p)
        return done('timeout', `дедлайн ${deadline} мс истёк`)
      }
      // 4xx кроме 429 — ошибка вызывающего (кривая схема, параметры), а не
      // поломка провайдера: в предохранитель не идёт, общий ресурс не гасит.
      if (error.status >= 400 && error.status < 500) return done('rejected', error.message)
      health.failure(p)
      return done('error', error.message)
    } finally {
      for (const t of timers) clearTimeout(t)
      health.release(p)
    }
  }

  /**
   * Во что запрос может обойтись в худшем случае — до вызова: вход плюс
   * потолок выхода, умноженные на число возможных вызовов, и та же величина
   * в деньгах по самой дорогой ставке **среди способных** провайдеров.
   * Возможных — значит способных: у класса с единственным кандидатом
   * фолбэка не бывает, и резервировать за два вызова нельзя, иначе лимит
   * приложения уполовинится. Считать по самому дорогому провайдеру вообще
   * тоже нельзя: запрос к грошовому классификатору упирался бы в цену
   * фронтир-модели, которая его никогда не обслужит.
   */
  function estimateRequest(req) {
    const cls = config.classes[resolveClass(req.taskClass)]
    const level = resolveThinking(cls, req.thinking).level ?? cls.thinking
    const inputTokens = estimateTokens(req.input) + estimateTokens(req.system ?? '')
    const answerTokens = Math.min(
      req.answerTokens ?? cls.answerTokens,
      cls.maxAnswerTokens ?? cls.answerTokens,
    )
    const outputTokens = answerTokens + THINKING_TOKENS[level]
    const dataClass = req.dataClass ?? cls.dataClass
    const extraRequires = [...(req.requires ?? []), ...(req.schema ? ['json_schema'] : [])]
    // При явном выборе способный кандидат ровно один — по нему и считаем,
    // иначе запрос к дешёвой модели резервируется по ставке дорогой.
    const pool = req.provider
      ? registry
          .list()
          .filter((p) => p.id === req.provider || `${p.id}#${p.revision}` === req.provider)
      : registry.list()
    const capable = orderedCandidates(cls, pool).filter(
      (p) => capabilityFit(p, cls, level, dataClass, inputTokens, extraRequires).ok,
    )
    const calls = req.provider ? 1 : Math.min(MAX_CALLS, Math.max(1, capable.length))
    const worst = Math.max(
      0,
      ...capable.map(
        (p) =>
          (inputTokens / 1e6) * (p.price?.inputPerMTok ?? 0) +
          (outputTokens / 1e6) * (p.price?.outputPerMTok ?? 0),
      ),
    )
    return { tokens: (inputTokens + outputTokens) * calls, costUsd: worst * calls }
  }

  /**
   * Что приложение может знать о моделях до запроса: статический предел
   * на запрос и последний известный остаток квоты. Нужно, чтобы приложение
   * подгоняло размер запроса, а не узнавало о пределе отказом.
   */
  function providerLimits(taskClass) {
    const cls = config.classes[resolveClass(taskClass)]
    // Приложению показываем только те модели, которые класс действительно
    // может использовать: классификатор в списке моделей для ответа
    // пользователю — это приглашение выбрать заведомый отказ.
    const capable = orderedCandidates(cls, registry.list()).filter(
      (p) => capabilityFit(p, cls, cls.thinking, cls.dataClass, 0).ok,
    )
    return capable.map((p) => {
      const quota = health.quotaOf(p)
      return {
        id: p.id,
        revision: p.revision,
        model: p.model,
        tier: p.tier,
        maxRequestTokens: p.maxRequestTokens ?? p.contextWindow,
        contextWindow: p.contextWindow,
        quota: quota
          ? {
              limitTokens: quota.limitTokens,
              remainingTokens: quota.remainingTokens,
              resetAt: quota.resetAt ? new Date(quota.resetAt).toISOString() : null,
              stale: quota.expired,
            }
          : null,
        available: health.unavailableReason(p) === null,
      }
    })
  }

  return {
    route,
    resolveClass,
    estimateRequest,
    providerLimits,
    providers: () => registry.list(),
    health,
    /** Счётчики по провайдерам и снимок здоровья — для /v1/metrics. */
    metrics() {
      const out = {}
      for (const p of registry.list()) {
        const k = `${p.id}#${p.revision}`
        out[k] = {
          ...(stats.get(k) ?? { attempts: 0, ok: 0, failed: 0, skipped: 0 }),
          health: health.snapshot(p),
        }
      }
      return out
    },
  }
}

function isUnreachable(error) {
  return UNREACHABLE.has(error.cause?.code) || UNREACHABLE.has(error.code)
}

/**
 * Оценка токенов входа без обращения к провайдеру: ~4 символа на токен для
 * латиницы и ~2 для остального — кириллица токенизируется примерно вдвое плотнее.
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let ascii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++
  return Math.ceil(ascii / 4 + (s.length - ascii) / 2)
}

/** Дедлайн по формуле раздела «Таймауты» ADR; профиль задаёт параметры. */
export function deadlineMs(p, { inputTokens, answerTokens, thinking }) {
  const prof = { ...PROFILE_DEFAULTS[p.profile], ...(p.timeouts ?? {}) }
  const outTokens = answerTokens + THINKING_TOKENS[thinking]
  const raw =
    prof.margin *
    (prof.loadMs +
      (inputTokens / prof.promptEvalTps) * 1000 +
      (outTokens / prof.genTpsFloor) * 1000)
  const floor = thinking === 'none' ? prof.minMs : prof.minMs * 2.5
  return Math.ceil(Math.max(raw, floor))
}

// Разделитель — «|», а не «:»: имена моделей Ollama содержат двоеточие (qwen3.8:27b).
export function cacheKey({ taskClass, p, thinking, promptVersion = '1', input }) {
  const hash = createHash('sha256')
    .update(String(input ?? ''))
    .digest('hex')
    .slice(0, 16)
  return [
    taskClass,
    `${p.id}#${p.revision}`,
    p.model,
    thinking,
    promptVersion,
    CACHE_KEY_VERSION,
    hash,
  ].join('|')
}

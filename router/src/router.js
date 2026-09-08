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

    const requires = [...(cls.requires ?? []), ...(req.requires ?? [])]
    const schema = req.schema ?? null
    const strict = schema !== null || requires.includes('json_schema')
    // Класс со схемой без схемы — граница, а не тихий свободный текст.
    if (strict && schema === null)
      return refuse('refused', `класс ${taskClass} требует schema в запросе`, [])

    const inputTokens = estimateTokens(req.input) + estimateTokens(req.system ?? '')
    const providers = registry.list()
    const candidates = orderedCandidates(cls, providers)
    if (candidates.length === 0)
      return refuse(
        'no_provider',
        `для класса ${taskClass} нет ни одного провайдера в ярусах ${cls.tiers.join(',')}`,
        [],
      )

    // 1. Возможность: статичная, несоответствие — отказ.
    const capable = []
    for (const p of candidates) {
      const fit = capabilityFit(p, cls, thinking, dataClass, inputTokens, req.requires ?? [])
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
    for (const p of capable) {
      if (calls >= MAX_CALLS) break
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
      bump(p, 'failed')
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
    const result = refuse(
      'all_failed',
      `все провайдеры класса ${taskClass} недоступны или отказали`,
      reasons,
    )
    result.attempts = attempts
    result.thinking = thinking
    return result
  }

  async function tryProvider(
    p,
    { cls, req, thinking, inputTokens, schema, strict, requires, budgetUntil },
  ) {
    const providerId = `${p.id}#${p.revision}`
    const answerTokens = cls.answerTokens
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
          tools: requires.filter((r) => r === 'web_search'),
          thinking: { level: thinking, value: p.thinking[thinking] },
          answerTokens,
          maxOutputTokens,
          temperature: req.temperature,
          signal: ctrl.signal,
        },
        { fetchImpl, env },
      )
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
      health.failure(p)
      return done('error', error.message)
    } finally {
      for (const t of timers) clearTimeout(t)
      health.release(p)
    }
  }

  /** Оценка стоимости запроса в токенах до вызова: вход плюс потолок выхода. */
  function estimateRequestTokens(req) {
    const cls = config.classes[resolveClass(req.taskClass)]
    const level = resolveThinking(cls, req.thinking).level ?? cls.thinking
    return (
      estimateTokens(req.input) +
      estimateTokens(req.system ?? '') +
      cls.answerTokens +
      THINKING_TOKENS[level]
    )
  }

  return {
    route,
    resolveClass,
    estimateRequestTokens,
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

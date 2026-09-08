// Ядро маршрутизации (ADR 2026-09-08-1748). Три механизма и только три:
// возможность → отказ, политика → порядок, здоровье → пропуск. Ошибка
// первого — отказ, второго — фолбэк не более одного раза, третьего — пропуск.

import { createHash } from 'node:crypto'
import { ADAPTERS } from './adapters/index.js'
import { capabilityFit, orderedCandidates, PROFILE_DEFAULTS, THINKING_TOKENS } from './config.js'
import { createHealth } from './health.js'

const MAX_CALLS = 2
const CACHE_KEY_VERSION = '1'
// Разделитель — «|», а не «:»: имена моделей Ollama содержат двоеточие (qwen3.8:27b).
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

  async function route(req) {
    const taskClass = resolveClass(req.taskClass)
    const cls = config.classes[taskClass]
    const reasons = []

    // Уровень размышлений — только из реестра классов. Override — лишь для
    // незакрытых классов; для закрытых это отказ, не тихое понижение.
    let thinking = cls.thinking
    if (req.thinking !== undefined && req.thinking !== cls.thinking) {
      if (cls.locked) {
        return refuse('refused', `класс ${taskClass} закреплён за уровнем ${cls.thinking}`, [
          { provider: null, stage: 'capability', reason: `запрошен уровень ${req.thinking}` },
        ])
      }
      thinking = req.thinking
    }
    if (!(thinking in THINKING_TOKENS))
      return refuse('refused', `неизвестный уровень размышлений ${thinking}`, [])

    const dataClass = req.dataClass ?? cls.dataClass
    const inputTokens = estimateTokens(req.input) + estimateTokens(req.system ?? '')
    const schema = req.schema ?? null
    const strict = schema !== null || (cls.requires ?? []).includes('json_schema')

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
        reasons.push({ provider: `${p.id}#${p.revision}`, stage: 'capability', reason: fit.reason })
    }
    if (capable.length === 0)
      return refuse(
        'refused',
        `ни один провайдер класса ${taskClass} не удовлетворяет требованиям`,
        reasons,
      )

    // 2–3. Политика задала порядок; здоровье пропускает; не больше двух вызовов.
    const attempts = []
    let fallback = null
    let calls = 0
    for (const p of capable) {
      if (calls >= MAX_CALLS) break
      const skip = health.unavailableReason(p)
      if (skip) {
        reasons.push({ provider: `${p.id}#${p.revision}`, stage: 'health', reason: skip })
        bump(p, 'skipped')
        log({ event: 'skip', taskClass, provider: `${p.id}#${p.revision}`, thinking, reason: skip })
        continue
      }
      calls += 1
      if (calls === 2) fallback = { from: attempts.at(-1).provider, reason: attempts.at(-1).reason }
      const attempt = await tryProvider(p, {
        cls,
        taskClass,
        req,
        thinking,
        inputTokens,
        schema,
        strict,
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
          provider: { id: p.id, revision: p.revision, kind: p.kind, model: p.model, tier: p.tier },
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
      reasons.push({ provider: attempt.provider, stage: 'call', reason: attempt.reason })
      // Обрезание в схемном классе — не повод звать второго: ответ был, но негодный.
      if (attempt.outcome === 'truncated' && strict) break
    }
    const result = refuse(
      'all_failed',
      `все провайдеры класса ${taskClass} недоступны или отказали`,
      reasons,
    )
    result.attempts = attempts
    return result

    function refuse(code, message, why) {
      log({ event: 'refuse', taskClass, thinking, code, message, reasons: why })
      return { ok: false, code, message, reasons: why, attempts: [] }
    }
  }

  async function tryProvider(p, { cls, taskClass, req, thinking, inputTokens, schema, strict }) {
    const providerId = `${p.id}#${p.revision}`
    const answerTokens = cls.answerTokens
    const maxOutputTokens = answerTokens + THINKING_TOKENS[thinking]
    const deadline = deadlineMs(p, { inputTokens, answerTokens, thinking, budgetMs: req.budgetMs })
    const started = now()
    const done = (outcome, reason, extra = {}) => ({
      provider: providerId,
      outcome,
      reason,
      durationMs: now() - started,
      usage: extra.usage ?? null,
      ...extra,
    })

    health.acquire(p)
    try {
      const adapter = adapters[p.kind]
      const result = await adapter.call(
        {
          provider: p,
          model: p.model,
          prompt: req.input,
          system: req.system,
          schema,
          thinking: { level: thinking, value: p.thinking[thinking] },
          answerTokens,
          maxOutputTokens,
          temperature: req.temperature,
          signal: AbortSignal.timeout(deadline),
        },
        { fetchImpl, env },
      )
      const text = (result.text ?? '').trim()
      if (text.length === 0) {
        health.failure(p)
        return done('empty', 'пустой ответ при 200', { usage: result.usage })
      }
      const truncated = result.stopReason === 'length'
      if (truncated && strict) {
        health.failure(p)
        return done('truncated', 'ответ обрезан по лимиту токенов, схема не выполнена', {
          usage: result.usage,
        })
      }
      let json = null
      if (schema) {
        try {
          json = JSON.parse(text)
        } catch {
          health.failure(p)
          return done('invalid_json', 'ответ не разбирается как JSON', { usage: result.usage })
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
      if (error.status === 429) {
        health.busy(p, error.retryAfterMs)
        return done('busy', `429, занят${error.retryAfterMs ? ` на ${error.retryAfterMs} мс` : ''}`)
      }
      if (isUnreachable(error)) {
        health.unreachable(p)
        return done('unreachable', `недоступен: ${error.cause?.code ?? error.message}`)
      }
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        health.failure(p)
        return done('timeout', `дедлайн ${deadline} мс истёк`)
      }
      health.failure(p)
      return done('error', error.message)
    } finally {
      health.release(p)
    }
  }

  return {
    route,
    resolveClass,
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

/** Оценка токенов входа без обращения к провайдеру: ~4 символа на токен. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4)
}

/** Дедлайн по формуле раздела «Таймауты» ADR; профиль задаёт параметры. */
export function deadlineMs(p, { inputTokens, answerTokens, thinking, budgetMs }) {
  const prof = { ...PROFILE_DEFAULTS[p.profile], ...(p.timing ?? {}) }
  const outTokens = answerTokens + THINKING_TOKENS[thinking]
  const raw =
    prof.margin *
    (prof.loadMs +
      (inputTokens / prof.promptEvalTps) * 1000 +
      (outTokens / prof.genTpsFloor) * 1000)
  const floor = thinking === 'none' ? prof.minMs : prof.minMs * 2.5
  const ms = Math.ceil(Math.max(raw, floor))
  return budgetMs ? Math.min(ms, budgetMs) : ms
}

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

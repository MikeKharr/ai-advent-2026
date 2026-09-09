/**
 * Остаток квоты из заголовков ответа. Провайдеры сообщают его на каждом
 * ответе, включая отказы, и это единственный честный источник: собственный
 * счётчик роутера не знает о запросах, сделанных мимо него.
 *
 * Форматы разные: Anthropic отдаёт метку времени сброса, Groq —
 * длительность вида «577ms», «38.407s», «2m52.8s».
 */

const DURATION = /(\d+(?:\.\d+)?)(ms|s|m|h)/g
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

export function parseReset(raw, now) {
  if (!raw) return null
  const asDate = Date.parse(raw)
  if (Number.isFinite(asDate)) return asDate
  let total = 0
  let matched = false
  for (const [, value, unit] of raw.matchAll(DURATION)) {
    total += Number(value) * UNIT_MS[unit]
    matched = true
  }
  return matched ? now + Math.round(total) : null
}

const num = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Достаёт квоту входных токенов. `headers` — объект с методом `get`.
 * Возвращает null, если провайдер о квоте не сообщает (Ollama).
 */
export function readQuota(headers, kind, now = Date.now()) {
  const get = (name) => headers?.get?.(name) ?? null
  const names =
    kind === 'anthropic'
      ? {
          limit: 'anthropic-ratelimit-input-tokens-limit',
          remaining: 'anthropic-ratelimit-input-tokens-remaining',
          reset: 'anthropic-ratelimit-input-tokens-reset',
        }
      : {
          limit: 'x-ratelimit-limit-tokens',
          remaining: 'x-ratelimit-remaining-tokens',
          reset: 'x-ratelimit-reset-tokens',
        }

  const limitTokens = num(get(names.limit))
  const remainingTokens = num(get(names.remaining))
  if (limitTokens === null && remainingTokens === null) return null
  return {
    limitTokens,
    remainingTokens,
    resetAt: parseReset(get(names.reset), now),
    at: now,
  }
}

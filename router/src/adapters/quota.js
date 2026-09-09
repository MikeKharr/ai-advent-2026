/**
 * Остаток квоты из заголовков ответа. Провайдеры сообщают его на каждом
 * ответе, включая отказы, и это единственный честный источник: собственный
 * счётчик роутера не знает о запросах, сделанных мимо него.
 *
 * Форматы разные: Anthropic отдаёт метку времени сброса, Groq —
 * длительность вида «577ms», «38.407s», «2m52.8s».
 */

/** Форма длительности целиком: только числа с известными единицами. */
const DURATION_SHAPE = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/i
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/**
 * Потолок на окно сброса. Окна провайдеров минутные; час — заведомо
 * достаточный предел, за которым значение можно считать мусором.
 * Без потолка «999999999s» означал бы, что квота не протухнет никогда.
 */
export const MAX_WINDOW_MS = 3_600_000

export function parseReset(raw, now) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null

  // Длительность разбирается первой: «60» — это шестьдесят чего-то, а не
  // 1960 год, но Date.parse охотно прочтёт его как год и отправит сброс
  // в прошлое. Тогда квота всегда выглядит полной, и проверка выключается.
  if (DURATION_SHAPE.test(text)) {
    let total = 0
    for (const [, value, unit] of text.matchAll(DURATION_PART))
      total += Number(value) * UNIT_MS[unit.toLowerCase()]
    return now + Math.min(Math.round(total), MAX_WINDOW_MS)
  }

  // На метку времени похоже только то, где есть её разделители.
  if (!/[-T:]/.test(text)) return null
  const asDate = Date.parse(text)
  return Number.isFinite(asDate) ? asDate : null
}

/**
 * Число из заголовка. Отрицательный остаток провайдеры отдают именно при
 * исчерпании, поэтому он равен нулю, а не «неизвестно»: спутать эти два
 * состояния значит пойти звать заведомо исчерпанного провайдера.
 */
const num = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return n < 0 ? 0 : n
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

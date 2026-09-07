// Разбор окружения на границе: значения приходят из файла на сервере,
// поэтому проверяются, а не приводятся к типу молча.

const NUMBERS = {
  MAX_SEARCH_USES: 4,
  MAX_OUTPUT_TOKENS: 2048,
  MAX_DAILY_CALLS: 50,
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
  CACHE_TTL_HOURS: 6,
  PORT: 8080,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = { ANTHROPIC_MODEL: source.ANTHROPIC_MODEL || 'claude-haiku-4-5' }

  const key = source.ANTHROPIC_API_KEY ?? ''
  if (!key) errors.push('ANTHROPIC_API_KEY не задан')
  env.ANTHROPIC_API_KEY = key

  for (const [name, fallback] of Object.entries(NUMBERS)) {
    const raw = source[name]
    if (raw === undefined || raw === '') {
      env[name] = fallback
      continue
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${name}: ожидалось положительное число, получено ${JSON.stringify(raw)}`)
      env[name] = fallback
      continue
    }
    env[name] = value
  }

  return { env, errors }
}

/** Сфера от пользователя: длина и управляющие символы отсекаются до всего остального. */
export function parseSphere(value) {
  if (typeof value !== 'string') return { ok: false, message: 'Поле sphere должно быть строкой' }
  const sphere = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (sphere.length === 0) return { ok: false, message: 'Укажите сферу' }
  if (sphere.length > 60) return { ok: false, message: 'Слишком длинно: не больше 60 символов' }
  return { ok: true, sphere }
}

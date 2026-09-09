// Разбор окружения дня на границе. Ключей к моделям и к роутеру у дня нет:
// он ходит только к сервису агентов (ADR 2026-09-10-1000). Здесь же —
// настройки cookie сессии диалога (ADR 2026-09-12-0930).

const NUMBERS = {
  MAX_DAILY_CALLS: 50,
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
  // Создание запуска, состояние и переписка — быстрые вызовы; поток событий
  // живёт без таймаута, пока агент его не закроет.
  AGENT_TIMEOUT_MS: 10_000,
  // Срок жизни cookie: столько же, сколько агент хранит переписку без новых
  // сообщений. Обновляется на каждом обращении.
  SESSION_TTL_HOURS: 30,
  PORT: 8080,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    AGENT_URL: source.AGENT_URL || 'http://agents:8082',
    AGENT_ID: source.AGENT_ID || 'news-analyst',
    // Публичный префикс дня: cookie не должна утекать на соседние дни того
    // же домена. Локально день работает на корне, поэтому значение задаётся.
    COOKIE_PATH: source.COOKIE_PATH || '/day7/',
    // Secure выключается только для локального запуска по http.
    COOKIE_SECURE: source.COOKIE_SECURE !== 'false',
  }

  const key = source.AGENT_KEY ?? ''
  if (!key) errors.push('AGENT_KEY не задан')
  env.AGENT_KEY = key

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

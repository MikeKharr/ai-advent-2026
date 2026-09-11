// Разбор окружения дня на границе. Ключей к моделям и к роутеру у дня нет:
// он предъявляет сервису агентов свой ключ, а всё остальное — у агента
// (ADR 2026-09-09-0854, п. 5).

const NUMBERS = {
  MAX_DAILY_CALLS: 50,
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
  // Создание запуска и состояние — быстрые вызовы; поток событий живёт
  // без таймаута, пока агент его не закроет.
  AGENT_TIMEOUT_MS: 10_000,
  PORT: 8080,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    AGENT_URL: source.AGENT_URL || 'http://agents:8082',
    AGENT_ID: source.AGENT_ID || 'news-analyst',
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

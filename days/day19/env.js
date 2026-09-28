// Разбор окружения дня на границе. Ключей к моделям и к роутеру у дня нет: он
// ходит только к сервису агентов (ADR 2026-09-09-0854) и предъявляет ему
// AGENT_KEY. Ключ живёт в этом процессе; страница его не знает, не получает и
// не показывает (I-1).
//
// Модель в цепочке дня 19 не участвует (ADR 2026-09-28-0736, п. 8): порядок
// шагов задаёт код, расход модели — ноль. Поэтому суточного денежного
// счётчика у дня нет; окна на адрес остаются — они защищают чужие API, к
// которым ходят серверы MCP с нашего единственного адреса.

const NUMBERS = {
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
  // Быстрые вызовы к сервису агентов. Поток событий идёт без таймаута, пока
  // агент его не закроет.
  AGENT_TIMEOUT_MS: 10_000,
  PORT: 8080,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    AGENT_URL: source.AGENT_URL || 'http://agents:8082',
    AGENT_ID: source.AGENT_ID || 'pipeline-agent',
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

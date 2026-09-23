// Разбор окружения службы MCP на границе (ADR 2026-09-23-1227, п. 4).
// `MCP_KEY` обязателен: без него проверка входа сравнивала бы пустые строки,
// и публичный эндпоинт гонял бы наш адрес по чужим API от имени анонимов.

const NUMBERS = {
  RATE_LIMIT_PER_MIN: 10,
  RATE_LIMIT_PER_HOUR: 100,
  PORT: 8083,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {}

  const key = source.MCP_KEY ?? ''
  if (!key) errors.push('MCP_KEY не задан')
  env.MCP_KEY = key

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

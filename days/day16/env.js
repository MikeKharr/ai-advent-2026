// Разбор окружения дня на границе. У дня 16 нет ни ключей к моделям, ни ключа
// роутера: он предъявляет службе MCP её собственный ключ `MCP_KEY`
// (ADR 2026-09-23-1227, п. 4) и больше никуда не ходит.

const NUMBERS = {
  // Денег день не тратит: у службы MCP нет платных вызовов, поэтому суточного
  // денежного счётчика (дни 6–15) здесь нет — есть только окна на адрес.
  // Они защищают не бюджет, а чужие API, к которым ходят инструменты службы,
  // и наш адрес, с которого они туда ходят (ADR 2026-09-23-1227, «Последствия»).
  RATE_LIMIT_PER_MIN: 20,
  RATE_LIMIT_PER_HOUR: 120,
  // Столько же, сколько названо на странице словами «истекли 20 с»: число и
  // текст обязаны совпадать, иначе страница врёт о причине отказа.
  MCP_TIMEOUT_MS: 20_000,
  PORT: 8080,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    // Тот же адрес, что зашит в Caddyfile как цель маршрута /mcp: служба
    // видит POST /mcp, без завершающего слэша (deploy/Caddyfile, блок «служба MCP»).
    MCP_URL: source.MCP_URL || 'http://mcp:8083/mcp',
  }

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

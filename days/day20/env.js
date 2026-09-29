// Разбор окружения дня на границе. Ключей к моделям и к роутеру у дня нет: он
// ходит только к сервису агентов (ADR 2026-09-09-0854) и предъявляет ему
// AGENT_KEY. Ключ живёт в этом процессе; страница его не знает, не получает и
// не показывает (I-1).
//
// Порядок вызовов у дня 20 выбирает модель, поэтому запуск стоит денег: у дня
// есть суточный потолок вызовов сверх окон на адрес.

const NUMBERS = {
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
  // Запуск дня 20 зовёт модель через роутер — здесь потолок охраняет деньги
  // (ADR 2026-09-28-0736, п. 9).
  MAX_DAILY_CALLS: 50,
  // Быстрые вызовы к сервису агентов. Поток событий идёт без таймаута, пока
  // агент его не закроет.
  AGENT_TIMEOUT_MS: 10_000,
  // Срок жизни cookie сессии. Тот же, что у дня 7 и у хранилища сервиса
  // (ADR 2026-09-09-1906): переписка живёт 30 часов без сообщений.
  SESSION_TTL_HOURS: 30,
  PORT: 8080,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    AGENT_URL: source.AGENT_URL || 'http://agents:8082',
    AGENT_ID: source.AGENT_ID || 'mcp-agent',
    // Умолчание уже верно для прода: cookie уходит только на адреса дня.
    // Поэтому в deploy/day20.env переменной нет — как у дней 9–15.
    COOKIE_PATH: source.COOKIE_PATH || '/day20/',
    // `Secure` снимается только явным 'false' — для локального http.
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

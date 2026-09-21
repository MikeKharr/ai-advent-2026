// Разбор окружения дня на границе. Ключей к моделям и к роутеру у дня нет:
// он ходит только к сервису агентов (ADR 2026-09-09-0854). Здесь же —
// настройки двух cookie дня 13: профиль (30 дней) и диалог (30 часов),
// ADR 2026-09-15-2024, п. 2; день 13 наследует их у дня 11
// (ADR 2026-09-21-1747, п. 9) со своими именами.

const NUMBERS = {
  MAX_DAILY_CALLS: 50,
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
  // Записи профиля идут под своим окном: создание, выбор, настройки,
  // удаление и ответ о теме модель не зовут, но это публичные ручки,
  // меняющие общую память (ADR 2026-09-15-2024, п. 8.3).
  RATE_LIMIT_WRITES_PER_HOUR: 60,
  // Создание запуска, состояние и переписка — быстрые вызовы; поток событий
  // живёт без таймаута, пока агент его не закроет.
  AGENT_TIMEOUT_MS: 10_000,
  // Срок жизни cookie диалога: столько же, сколько агент хранит переписку
  // без новых сообщений. Обновляется на каждом обращении.
  SESSION_TTL_HOURS: 30,
  // Срок жизни cookie профиля: столько же, сколько агент хранит память
  // профиля без действий в нём.
  PROFILE_TTL_DAYS: 30,
  PORT: 8080,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    AGENT_URL: source.AGENT_URL || 'http://agents:8082',
    AGENT_ID: source.AGENT_ID || 'staged-agent',
    // Публичный префикс дня: cookie не должна утекать на соседние дни того
    // же домена. Локально день работает на корне, поэтому значение задаётся.
    COOKIE_PATH: source.COOKIE_PATH || '/day13/',
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

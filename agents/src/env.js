// Разбор окружения сервиса агентов на границе. Ключ сервиса и ключ
// приложения у роутера обязательны: без первого проверка авторизации
// сравнивала бы пустые строки, без второго роутер отвечал бы 401 на всё.

const NUMBERS = {
  // Потолок пользовательского max_tokens. Поднят до 4096 под умолчание дня 8
  // в 3000: умолчание, совпадающее с пределом, не оставляет запаса.
  MAX_OUTPUT_TOKENS: 4096,
  WINDOW_SIZE: 1000, // сколько статей держим в окне архива
  REFRESH_MIN_MINUTES: 15, // не чаще, чем раз в столько минут, опрашиваем ленты
  MAX_AGE_DAYS: 180, // дольше этого чужие тексты в архиве не хранятся
  // Ноутбук отвечает минутами: двадцать секунд на загрузку модели плюс
  // около восьми токенов в секунду. Облачные модели в этот потолок
  // укладываются с огромным запасом.
  ROUTER_TIMEOUT_MS: 240_000,
  RUN_TTL_MINUTES: 10, // готовый запуск живёт в памяти столько
  // Диалог без активности живёт столько часов, потом удаляется целиком
  // (решение владельца 2026-09-12, ADR 2026-09-09-1906).
  SESSION_TTL_HOURS: 30,
  PORT: 8082,
}

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    ROUTER_URL: source.ROUTER_URL || 'http://router:8081',
    STORE_FILE: source.STORE_FILE || '/data/store.json',
    SESSIONS_FILE: source.SESSIONS_FILE || '/data/sessions.db',
  }

  for (const name of ['AGENT_KEY', 'ROUTER_APP_KEY']) {
    const value = source[name] ?? ''
    if (!value) errors.push(`${name} не задан`)
    env[name] = value
  }

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

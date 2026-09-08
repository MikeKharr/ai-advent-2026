// Разбор окружения и параметров запроса на границе. Ключей к моделям здесь
// нет: день ходит в роутер по своему ключу приложения (ADR 2026-09-08-1748).

const NUMBERS = {
  MAX_OUTPUT_TOKENS: 2048, // потолок для пользовательского max_tokens
  MAX_DAILY_CALLS: 50,
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
  WINDOW_SIZE: 1000, // сколько статей держим в окне
  REFRESH_MIN_MINUTES: 15, // не чаще, чем раз в столько минут, опрашиваем ленты
  MAX_AGE_DAYS: 180, // дольше этого чужие тексты в архиве не хранятся
  ROUTER_TIMEOUT_MS: 90_000,
  PORT: 8080,
}

/**
 * Модели, которые пользователь выбирает до запуска. Значение — идентификатор
 * провайдера в роутере; список моделей задаёт роутер, здесь только то
 * подмножество, которое день предлагает выбрать.
 */
export const MODELS = [
  { id: 'anthropic-haiku', label: 'Claude Haiku 4.5', note: 'Anthropic' },
  { id: 'groq-gpt-oss-20b', label: 'GPT-OSS 20B', note: 'Groq' },
  { id: 'groq-qwen3.6-27b', label: 'Qwen3.6 27B', note: 'Groq' },
]

export function parseEnv(source = process.env) {
  const errors = []
  const env = {
    ROUTER_URL: source.ROUTER_URL || 'http://router:8081',
    STORE_FILE: source.STORE_FILE || '/data/store.json',
  }

  const key = source.ROUTER_APP_KEY ?? ''
  if (!key) errors.push('ROUTER_APP_KEY не задан')
  env.ROUTER_APP_KEY = key

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
  if (sphere.length === 0) return { ok: false, message: 'Укажите тему' }
  if (sphere.length > 60) return { ok: false, message: 'Слишком длинно: не больше 60 символов' }
  return { ok: true, sphere }
}

/** Управляющие символы, кроме перевода строки: он значим в prompt и stop. */
function cleanText(value) {
  if (value === undefined || value === null) return { ok: true, text: '' }
  if (typeof value !== 'string') return { ok: false }
  return {
    ok: true,
    text: value
      .replace(/\r\n/g, '\n')
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
      .trim(),
  }
}

export const PARAM_DEFAULTS = {
  maxTokens: 600,
  perSource: 5,
  articles: 30,
  model: MODELS[0].id,
  prompt: '',
}

export const PARAM_LIMITS = {
  promptChars: 2000,
  stopSequences: 4,
  stopChars: 40,
  perSource: 15,
  articles: 60,
}

function parseBoundedInt(value, min, max) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined }
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false }
  return { ok: true, value: n }
}

/**
 * Параметры запроса: запрос к модели, выбор модели, потолок токенов,
 * стоп-последовательности, сколько статей отбирать и сколько с источника.
 */
export function parseParams(source, env) {
  const prompt = cleanText(source.prompt)
  if (!prompt.ok) return { ok: false, message: 'Поле prompt должно быть строкой' }
  if (prompt.text.length > PARAM_LIMITS.promptChars) {
    return { ok: false, message: `Запрос длиннее ${PARAM_LIMITS.promptChars} символов` }
  }

  const model = source.model ?? PARAM_DEFAULTS.model
  if (!MODELS.some((m) => m.id === model)) {
    return { ok: false, message: 'Неизвестная модель' }
  }

  const maxTokens = parseBoundedInt(source.maxTokens, 1, env.MAX_OUTPUT_TOKENS)
  if (!maxTokens.ok) {
    return { ok: false, message: `Лимит токенов: целое от 1 до ${env.MAX_OUTPUT_TOKENS}` }
  }

  const perSource = parseBoundedInt(source.perSource, 1, PARAM_LIMITS.perSource)
  if (!perSource.ok) {
    return { ok: false, message: `Статей с источника: целое от 1 до ${PARAM_LIMITS.perSource}` }
  }

  const articles = parseBoundedInt(source.articles, 1, PARAM_LIMITS.articles)
  if (!articles.ok) {
    return { ok: false, message: `Статей в подборке: целое от 1 до ${PARAM_LIMITS.articles}` }
  }

  const raw = source.stopSequences
  const list = raw === undefined || raw === null || raw === '' ? [] : raw
  if (!Array.isArray(list)) return { ok: false, message: 'stopSequences должен быть массивом' }
  if (list.length > PARAM_LIMITS.stopSequences) {
    return {
      ok: false,
      message: `Стоп-последовательностей не больше ${PARAM_LIMITS.stopSequences}`,
    }
  }
  const stopSequences = []
  for (const entry of list) {
    const cleaned = cleanText(entry)
    if (!cleaned.ok) return { ok: false, message: 'Стоп-последовательность должна быть строкой' }
    if (cleaned.text.length === 0) continue
    if (cleaned.text.length > PARAM_LIMITS.stopChars) {
      return { ok: false, message: `Стоп-последовательность длиннее ${PARAM_LIMITS.stopChars}` }
    }
    stopSequences.push(cleaned.text)
  }

  return {
    ok: true,
    params: {
      prompt: prompt.text,
      model,
      maxTokens: maxTokens.value ?? PARAM_DEFAULTS.maxTokens,
      perSource: perSource.value ?? PARAM_DEFAULTS.perSource,
      articles: articles.value ?? PARAM_DEFAULTS.articles,
      stopSequences,
    },
  }
}

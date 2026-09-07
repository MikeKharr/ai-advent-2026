// Разбор окружения и параметров запроса на границе: значения приходят
// из файла на сервере и из формы пользователя, поэтому проверяются,
// а не приводятся к типу молча.

const NUMBERS = {
  MAX_OUTPUT_TOKENS: 2048, // потолок для пользовательского max_tokens
  MAX_DAILY_CALLS: 50,
  RATE_LIMIT_PER_MIN: 5,
  RATE_LIMIT_PER_HOUR: 30,
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

/** Управляющие символы, кроме перевода строки: он значим в format и stop. */
function cleanText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .trim()
}

export const PARAM_DEFAULTS = {
  maxTokens: 200,
  perSource: 30,
}

const PARAM_LIMITS = {
  format: 500,
  stop: 400,
  stopSequences: 4,
  stopSequenceLength: 100,
  perSource: 50,
}

/**
 * Параметры обработки запроса из формы. Ошибка любого поля — отказ целиком:
 * молчаливая замена на дефолт скрыла бы от пользователя, что его параметр
 * не применился, а смысл дня 2 — именно видеть эффект параметров.
 */
export function parseParams(source, env) {
  const format = cleanText(source.format)
  if (format.length > PARAM_LIMITS.format) {
    return { ok: false, message: `Формат ответа: не больше ${PARAM_LIMITS.format} символов` }
  }

  const stop = cleanText(source.stop)
  if (stop.length > PARAM_LIMITS.stop) {
    return { ok: false, message: `Условие останова: не больше ${PARAM_LIMITS.stop} символов` }
  }
  const stopSequences = stop
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (stopSequences.length > PARAM_LIMITS.stopSequences) {
    return {
      ok: false,
      message: `Стоп-последовательностей не больше ${PARAM_LIMITS.stopSequences} (по одной на строку)`,
    }
  }
  if (stopSequences.some((s) => s.length > PARAM_LIMITS.stopSequenceLength)) {
    return {
      ok: false,
      message: `Стоп-последовательность: не больше ${PARAM_LIMITS.stopSequenceLength} символов`,
    }
  }

  const maxTokens = parseBoundedInt(source.maxTokens, 1, env.MAX_OUTPUT_TOKENS)
  if (!maxTokens.ok) {
    return { ok: false, message: `Лимит токенов: целое от 1 до ${env.MAX_OUTPUT_TOKENS}` }
  }

  const perSource = parseBoundedInt(source.perSource, 1, PARAM_LIMITS.perSource)
  if (!perSource.ok) {
    return { ok: false, message: `Статей с источника: целое от 1 до ${PARAM_LIMITS.perSource}` }
  }

  return {
    ok: true,
    params: {
      format,
      stopSequences,
      maxTokens: maxTokens.value ?? PARAM_DEFAULTS.maxTokens,
      perSource: perSource.value ?? PARAM_DEFAULTS.perSource,
    },
  }
}

/** Пустое значение — «возьми дефолт», мусор — ошибка, а не молчаливый дефолт. */
function parseBoundedInt(raw, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: true }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return { ok: false }
  return { ok: true, value }
}

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
  // Тип проверяется, а не приводится: String() на объекте без toString
  // бросает, а «[object Object]» — молчаливый мусор вместо отказа.
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
  maxTokens: 200,
  perSource: 30,
  // Значение по умолчанию у Messages API — 1. Совпадение с ним позволяет
  // не отправлять параметр вовсе (см. anthropic.js) и работать на моделях,
  // которые сэмплинг не принимают.
  temperature: 1,
}

const PARAM_LIMITS = {
  format: 500,
  stop: 400,
  stopSequences: 4,
  stopSequenceLength: 100,
  perSource: 50,
}

/** Шаг ползунка температуры. Значения между шагами — ошибка, а не округление. */
const TEMPERATURE_STEP = 0.1

/**
 * Параметры обработки запроса из формы. Ошибка любого поля — отказ целиком:
 * молчаливая замена на дефолт скрыла бы от пользователя, что его параметр
 * не применился, а смысл дней 2–3 — именно видеть эффект параметров.
 */
export function parseParams(source, env) {
  const formatParsed = cleanText(source.format)
  if (!formatParsed.ok) return { ok: false, message: 'Формат ответа должен быть строкой' }
  const format = formatParsed.text
  if (format.length > PARAM_LIMITS.format) {
    return { ok: false, message: `Формат ответа: не больше ${PARAM_LIMITS.format} символов` }
  }

  const stopParsed = cleanText(source.stop)
  if (!stopParsed.ok) return { ok: false, message: 'Условие останова должно быть строкой' }
  const stop = stopParsed.text
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

  const temperature = parseTemperature(source.temperature)
  if (!temperature.ok) {
    return { ok: false, message: 'Температура: число от 0 до 1 с шагом 0.1' }
  }

  return {
    ok: true,
    params: {
      format,
      stopSequences,
      maxTokens: maxTokens.value ?? PARAM_DEFAULTS.maxTokens,
      perSource: perSource.value ?? PARAM_DEFAULTS.perSource,
      temperature: temperature.value ?? PARAM_DEFAULTS.temperature,
    },
  }
}

/**
 * Температура: 0–1 с шагом 0.1 (диапазон Messages API). Проверяется в десятых,
 * потому что 0.1 в двоичной дроби не представима точно: 0.3 приходит с формы
 * как 0.30000000000000004, и сравнение с шагом напрямую его отвергло бы.
 */
function parseTemperature(raw) {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false }
  if (String(raw).trim() === '') return { ok: true }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) return { ok: false }
  // Допуск покрывает только погрешность двоичной дроби (~1e-17), но не даёт
  // молча округлить осмысленно другое значение вроде 0.0999991.
  const tenths = Math.round(value / TEMPERATURE_STEP)
  if (Math.abs(value - tenths * TEMPERATURE_STEP) > 1e-9) return { ok: false }
  return { ok: true, value: tenths / 10 }
}

/** Пустое значение — «возьми дефолт», мусор и чужой тип — ошибка, а не молчаливый дефолт. */
function parseBoundedInt(raw, min, max) {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false }
  if (String(raw).trim() === '') return { ok: true }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return { ok: false }
  return { ok: true, value }
}

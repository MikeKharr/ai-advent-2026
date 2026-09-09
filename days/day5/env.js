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
  // Ноутбук отвечает минутами: двадцать секунд на загрузку модели плюс
  // около восьми токенов в секунду. Облачные модели в этот потолок
  // укладываются с огромным запасом.
  ROUTER_TIMEOUT_MS: 240_000,
  PORT: 8080,
}

/**
 * Модели, которые пользователь выбирает до запуска. Значение — идентификатор
 * провайдера в роутере; список моделей задаёт роутер, здесь только то
 * подмножество, которое день предлагает выбрать.
 */
export const MODELS = [
  {
    id: 'anthropic-haiku',
    label: 'Claude Haiku 4.5',
    note: 'Anthropic',
    maxChars: 120_000,
    maxInputTokens: 40_000,
  },
  // У Groq на тарифе on_demand предел — входные токены в минуту: 8000
  // у gpt-oss, 7000 у qwen. Запрос сверху получает 413, а не обрезается.
  // Значения ниже — с запасом под пределы роутера (6000 и 5000) и меряются
  // по всему запросу, а не по одним текстам статей.
  {
    id: 'groq-gpt-oss-20b',
    label: 'GPT-OSS 20B',
    note: 'Groq',
    maxChars: 18_000,
    maxInputTokens: 5200,
  },
  {
    id: 'groq-qwen3.6-27b',
    label: 'Qwen3.6 27B',
    note: 'Groq',
    maxChars: 15_000,
    maxInputTokens: 4300,
  },
  // Ноутбук владельца через частную сеть Tailscale. Стоит последним и не
  // выбран по умолчанию: он медленный (около восьми токенов в секунду плюс
  // двадцать секунд на загрузку модели) и доступен, только пока ноутбук
  // в сети и свободен.
  {
    id: 'mac-qwen3',
    label: 'Qwen3.8 27B',
    note: 'ноутбук',
    maxChars: 16_000,
    maxInputTokens: 4500,
    slow: true,
  },
]

/**
 * Готовые запросы — от простого к сложному. Порядок значим: он показывает,
 * как растёт цена запроса и требовательность к подборке. Последние два
 * на маленькой модели или короткой подборке выполнимы плохо, и это видно
 * по ответу — в том и смысл, что сравнивать модели есть на чём.
 */
export const PROMPT_PRESETS = [
  {
    id: 'headlines',
    title: 'Заголовки',
    hint: 'Самое простое: перечислить, без разбора',
    text: 'Перечисли главные события списком, по одной строке на событие.',
  },
  {
    id: 'digest',
    title: 'Дайджест со ссылками',
    hint: 'Добавляет пересказ и ссылку к каждому пункту',
    text:
      'Сделай дайджест из пяти пунктов. В каждом: заголовок, одно предложение ' +
      'сути и ссылка из списка материалов.',
  },
  {
    id: 'rounds',
    title: 'Таблица раундов',
    hint: 'Требует извлечь числа и не выдумывать пропуски',
    text:
      'Собери таблицу раундов: компания, сумма, стадия, инвесторы, дата, ссылка. ' +
      'Бери только то, что прямо написано в материалах. Если поля нет — поставь ' +
      'прочерк, не догадывайся.',
  },
  {
    id: 'regions',
    title: 'Сравнение регионов',
    hint: 'Просит сгруппировать и признать нехватку данных',
    text:
      'Сравни, что происходит в США, Европе, Индии и Китае. По каждому региону — ' +
      'два-три наблюдения со ссылками на конкретные материалы. Отдельно отметь ' +
      'регионы, по которым материалов слишком мало для выводов.',
  },
  {
    id: 'trends',
    title: 'Тренды с доказательствами',
    hint: 'Нужны подтверждения, оговорки и признание пробелов',
    text:
      'Выдели три тренда недели. Для каждого приведи: формулировку в одну строку, ' +
      'два-три подтверждающих материала со ссылками, и контрпример, если он есть ' +
      'в подборке. В конце перечисли, чего в материалах не хватает, чтобы ' +
      'утверждать увереннее.',
  },
  {
    id: 'memo',
    title: 'Записка инвестору',
    hint: 'Структура из нескольких блоков и явный блок незнания',
    text:
      'Составь короткую записку для инвестора по этим материалам. Четыре блока: ' +
      '1) что изменилось за период; 2) кто в выигрыше и кто в проигрыше, с опорой ' +
      'на конкретные материалы; 3) на что смотреть дальше и почему; 4) «чего мы ' +
      'не знаем» — вопросы, на которые подборка ответа не даёт. Каждое утверждение ' +
      'подкрепляй ссылкой из списка. Домыслов и общих слов не добавляй.',
  },
  {
    id: 'audit',
    title: 'Разбор с уровнем уверенности',
    hint: 'Самое сложное: методология, группировка, самооценка',
    text:
      'Проведи разбор подборки по шагам. Сначала перечисли, какие материалы ты ' +
      'используешь и почему именно их. Затем сгруппируй их по темам и для каждой ' +
      'темы дай вывод с уровнем уверенности (высокий, средний, низкий) и ' +
      'обоснованием уровня. Затем отдельно перечисли утверждения, которые по этим ' +
      'материалам проверить нельзя, и укажи, какие источники для этого понадобились ' +
      'бы. В конце — одна строка: стоит ли доверять этому разбору при принятии ' +
      'решения и почему.',
  },
]

/** Умолчание названо явно: список упорядочен для показа, а не для выбора. */
export const DEFAULT_MODEL = 'anthropic-haiku'

const model = (id) => MODELS.find((m) => m.id === id) ?? MODELS[0]

/** Бюджет символов на тексты статей для выбранной модели. */
export function budgetFor(modelId) {
  return model(modelId).maxChars
}

/** Предел всего запроса в токенах — тем же счётом, что у роутера. */
export function inputBudgetFor(modelId) {
  return model(modelId).maxInputTokens
}

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

/** Шаг ползунка температуры. Значения между шагами — ошибка, а не округление. */
const TEMPERATURE_STEP = 0.1

/**
 * Температура: 0–1 с шагом 0.1. Проверяется в десятых, потому что 0.1
 * в двоичной дроби не представима точно: 0.3 приходит с формы как
 * 0.30000000000000004, и сравнение с шагом напрямую его отвергло бы.
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

export const PARAM_DEFAULTS = {
  maxTokens: 600,
  // Совпадение с умолчанием провайдера позволяет не отправлять параметр
  // вовсе: часть моделей несдвинутый сэмплинг не принимает.
  temperature: 1,
  perSource: 5,
  articles: 30,
  model: DEFAULT_MODEL,
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

  const temperature = parseTemperature(source.temperature)
  if (!temperature.ok) {
    return { ok: false, message: 'Температура: число от 0 до 1 с шагом 0.1' }
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
      temperature: temperature.value ?? PARAM_DEFAULTS.temperature,
      stopSequences,
    },
  }
}

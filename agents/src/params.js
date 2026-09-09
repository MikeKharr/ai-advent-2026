// Разбор входа запуска на границе сервиса: тема, запрос, модель, параметры.
// Список моделей и готовые запросы — здесь же: это то, что агент предлагает
// выбрать, а не то, что задаёт пользователь.

/**
 * Модели, которые пользователь выбирает до запуска. Значение — идентификатор
 * провайдера в роутере; список моделей задаёт роутер, здесь только то
 * подмножество, которое агент предлагает выбрать.
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
 * как растёт цена запроса и требовательность к подборке.
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

const model = (id) => MODELS.find((m) => m.id === id) ?? MODELS[0]

/** Бюджет символов на тексты статей для выбранной модели. */
export function budgetFor(modelId) {
  return model(modelId).maxChars
}

/** Предел всего запроса в токенах — тем же счётом, что у роутера. */
export function inputBudgetFor(modelId) {
  return model(modelId).maxInputTokens
}

export const PARAM_LIMITS = {
  sphereChars: 60,
  promptChars: 2000,
  // Свой системный промпт целиком уходит во вход модели и считается в её
  // пределе, поэтому потолок здесь — защита не от длины текста, а от расхода.
  systemChars: 4000,
  // Сколько токенов диалога пользователь может попросить взять в контекст.
  // Действующий размер меньше, если предел входа модели не позволяет
  // (ADR 2026-09-12-0930).
  contextTokens: 8000,
  stopSequences: 4,
  stopChars: 40,
  perSource: 15,
  articles: 60,
}

/**
 * Идентификатор сессии приходит из cookie дня. Проверяется по форме, а не
 * по содержимому: угадать чужой — то же, что угадать номер запуска.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/**
 * Тема от пользователя. С дня 8 поле необязательно: релевантность считается
 * по репликам разговора (ADR 2026-09-13-0930). Дни 6 и 7 продолжают его
 * присылать, поэтому проверка остаётся прежней.
 */
export function parseSphere(value) {
  if (value === undefined || value === null || value === '') return { ok: true, sphere: '' }
  if (typeof value !== 'string') return { ok: false, message: 'Поле sphere должно быть строкой' }
  const sphere = value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim()
  if (sphere.length === 0) return { ok: true, sphere: '' }
  if (sphere.length > PARAM_LIMITS.sphereChars) {
    return { ok: false, message: `Слишком длинно: не больше ${PARAM_LIMITS.sphereChars} символов` }
  }
  return { ok: true, sphere }
}

/**
 * Свой системный промпт вместо промпта из реестра. Правка живёт в браузере
 * пользователя и приходит с каждым запуском: реестр на сервере она не меняет
 * и чужие запуски не затрагивает (решение владельца 2026-09-11).
 *
 * `null` означает «промпт из реестра». Пустая строка — ошибка, а не молчаливый
 * откат к исходному: агент без системного промпта ведёт себя иначе, и человек
 * должен об этом узнать, а не гадать.
 */
export function parseSystem(value) {
  if (value === undefined || value === null) return { ok: true, system: null }
  if (typeof value !== 'string') return { ok: false, message: 'Поле system должно быть строкой' }
  const cleaned = cleanText(value)
  if (!cleaned.ok) return { ok: false, message: 'Поле system должно быть строкой' }
  if (cleaned.text.length === 0) {
    return { ok: false, message: 'Системный промпт не может быть пустым' }
  }
  if (cleaned.text.length > PARAM_LIMITS.systemChars) {
    return { ok: false, message: `Системный промпт длиннее ${PARAM_LIMITS.systemChars} символов` }
  }
  return { ok: true, system: cleaned.text }
}

/** Управляющие символы, кроме перевода строки: он значим в prompt и stop. */
function cleanText(value) {
  if (value === undefined || value === null) return { ok: true, text: '' }
  if (typeof value !== 'string') return { ok: false }
  return {
    ok: true,
    text: value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim(),
  }
}

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
  const tenths = Math.round(value / TEMPERATURE_STEP)
  if (Math.abs(value - tenths * TEMPERATURE_STEP) > 1e-9) return { ok: false }
  return { ok: true, value: tenths / 10 }
}

function parseBoundedInt(value, min, max) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined }
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false }
  return { ok: true, value: n }
}

/**
 * Параметры запуска: запрос к модели, выбор модели, потолок токенов,
 * стоп-последовательности, сколько статей отбирать и сколько с источника.
 * Умолчания — из реестра агента: это его настройка, а не сервиса.
 */
export function parseParams(source, { maxOutputTokens, defaults }) {
  const prompt = cleanText(source.prompt)
  if (!prompt.ok) return { ok: false, message: 'Поле prompt должно быть строкой' }
  if (prompt.text.length > PARAM_LIMITS.promptChars) {
    return { ok: false, message: `Запрос длиннее ${PARAM_LIMITS.promptChars} символов` }
  }

  const model = source.model ?? defaults.model
  if (!MODELS.some((m) => m.id === model)) return { ok: false, message: 'Неизвестная модель' }

  const maxTokens = parseBoundedInt(source.maxTokens, 1, maxOutputTokens)
  if (!maxTokens.ok) {
    return { ok: false, message: `Лимит токенов: целое от 1 до ${maxOutputTokens}` }
  }

  const perSource = parseBoundedInt(source.perSource, 1, PARAM_LIMITS.perSource)
  if (!perSource.ok) {
    return { ok: false, message: `Статей с источника: целое от 1 до ${PARAM_LIMITS.perSource}` }
  }

  const articles = parseBoundedInt(source.articles, 1, PARAM_LIMITS.articles)
  if (!articles.ok) {
    return { ok: false, message: `Статей в подборке: целое от 1 до ${PARAM_LIMITS.articles}` }
  }

  // Ноль — законное значение: «отвечай без памяти о разговоре».
  const contextTokens = parseBoundedInt(source.contextTokens, 0, PARAM_LIMITS.contextTokens)
  if (!contextTokens.ok) {
    return { ok: false, message: `Размер контекста: целое от 0 до ${PARAM_LIMITS.contextTokens}` }
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
      maxTokens: maxTokens.value ?? defaults.maxTokens,
      perSource: perSource.value ?? defaults.perSource,
      // Число статей необязательно: без него подборку набирает агент под
      // предел входа модели (ADR 2026-09-13-0930).
      articles: articles.value ?? defaults.articles ?? null,
      contextTokens: contextTokens.value ?? defaults.contextTokens ?? 3000,
      temperature: temperature.value ?? defaults.temperature,
      stopSequences,
    },
  }
}

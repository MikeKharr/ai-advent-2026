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
 * Модели Kimi — только для агента дня 11 (ADR 2026-09-16-1038). Дни 6–10
 * держат прежний список `MODELS`: сданные дни не меняются, и п. 8 ADR
 * 2026-09-15-1448 для них в силе.
 *
 * `maxInputTokens` 32 000 у всех четырёх — чуть ниже статического
 * `maxRequestTokens` 32 768 роутера, чтобы отказ приходил от сервиса
 * словами «уменьшите контекст», а не отказом роутера. Окно контекста
 * моделей к делу не относится: роутер отказывает раньше. `maxChars` —
 * по отношению Haiku (3 знака на токен); для агента дня 11 поле инертно,
 * оно есть ради одинаковой формы записей каталога.
 *
 * Пометка в `note` у трёх записей — про неотключаемые рассуждения: на
 * уровне `none` класса адаптер всё равно прибавляет к потолку ответа
 * 1024 токена на рассуждения, и они оплачиваются по ставке выхода.
 * `slow` не ставится: скорость Kimi не измерена.
 */
export const KIMI_MODELS = [
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    note: 'Kimi · рассуждения не выключаются',
    maxChars: 96_000,
    maxInputTokens: 32_000,
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    note: 'Kimi',
    maxChars: 96_000,
    maxInputTokens: 32_000,
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    note: 'Kimi · рассуждения не выключаются',
    maxChars: 96_000,
    maxInputTokens: 32_000,
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    label: 'Kimi K2.7 Code Highspeed',
    note: 'Kimi · рассуждения не выключаются',
    maxChars: 96_000,
    maxInputTokens: 32_000,
  },
]

/**
 * Что предлагает выбрать агент дня 11. Haiku остаётся первой и умолчанием:
 * умолчанием агента Kimi быть не должен, и реестр по-прежнему сверяет
 * `defaults.model` с `MODELS`.
 */
export const LAYERED_MODELS = [...MODELS, ...KIMI_MODELS]

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

// Поиск идёт по всему каталогу, а не по одному `MODELS`: неизвестный `id`
// здесь молча отдаёт `MODELS[0]`, и без записей Kimi `inputBudgetFor('kimi-k3')`
// вернул бы предел Haiku — окно настроек показало бы «33K», а бюджет запуска
// считался бы по чужой записи. Кто какой список предлагает выбрать — дело
// разборщиков ниже, а не этого поиска.
const model = (id) => LAYERED_MODELS.find((m) => m.id === id) ?? MODELS[0]

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
  // (ADR 2026-09-09-1906).
  contextTokens: 8000,
  stopSequences: 4,
  stopChars: 40,
  perSource: 15,
  articles: 60,
}

/**
 * Размер контекста, когда его не задали ни запуск, ни реестр. Одно число на
 * запуск и на настройки профиля: порог сводки сверяется с ним же, и разойтись
 * они не могут (умолчание дня 8, ADR 2026-09-09-1906).
 */
export const DEFAULT_CONTEXT_TOKENS = 3000

/**
 * Порог сводки N (ADR 2026-09-11-1608): когда реплики после последней
 * сводки набирают N токенов, агент сжимает их вместе с ней в новую сводку.
 * Отдельно от PARAM_LIMITS: те отдаются дням 6–8 в описании агента, и их
 * ответ не меняется.
 */
export const SUMMARIZE_LIMITS = { min: 500, max: 8000 }

/**
 * Порог сводки из входа запуска. Без поля — null, и агент ведёт себя как
 * в днях 7–8. Порог не больше окна контекста: иначе свежие реплики
 * вытеснялись бы окном раньше, чем их успели бы сжать.
 */
export function parseSummarizeAt(value, contextTokens, max = SUMMARIZE_LIMITS.max) {
  const parsed = parseBoundedInt(value, SUMMARIZE_LIMITS.min, max)
  if (!parsed.ok) {
    return {
      ok: false,
      message: `Порог сводки: целое от ${SUMMARIZE_LIMITS.min} до ${max}`,
    }
  }
  if (parsed.value === undefined) return { ok: true, value: null }
  if (parsed.value > contextTokens) {
    return { ok: false, message: `Порог сводки не больше размера контекста (${contextTokens})` }
  }
  return { ok: true, value: parsed.value }
}

/**
 * Стратегии управления контекстом дня 10 (ADR 2026-09-14-0447, п. 1).
 * Без поля `strategy` поведение прежнее (дни 6–9), поэтому список не
 * содержит «пусто».
 */
export const STRATEGIES = ['summary', 'window', 'facts', 'branches']

/** Скользящее окно: сколько последних реплик пути уходит модели. */
export const WINDOW_LIMITS = { min: 1, max: 40, default: 10 }

/**
 * Лимит блока фактов в токенах (ADR 2026-09-14-0447, п. 1). Он же —
 * потолок ответа вызова фактов: больше лимита модель не напишет.
 */
export const FACTS_LIMITS = { min: 200, max: 2000, default: 600 }

/**
 * Стратегия из входа запуска. Без поля — null, и агент ведёт себя как в
 * днях 6–9 (критерий приёмки 1).
 */
export function parseStrategy(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  if (!STRATEGIES.includes(value)) {
    return { ok: false, message: `Стратегия: одна из ${STRATEGIES.join(', ')}` }
  }
  return { ok: true, value }
}

/**
 * M — число последних реплик пути для стратегии `window`. Порога в токенах
 * при ней нет: «без ограничения по токенам» из задания (ADR, п. 6).
 */
export function parseWindow(value) {
  const parsed = parseBoundedInt(value, WINDOW_LIMITS.min, WINDOW_LIMITS.max)
  if (!parsed.ok) {
    return {
      ok: false,
      message: `Реплик в окне: целое от ${WINDOW_LIMITS.min} до ${WINDOW_LIMITS.max}`,
    }
  }
  return { ok: true, value: parsed.value ?? WINDOW_LIMITS.default }
}

/**
 * Лимит фактов в токенах для стратегии `facts`. Ограничение именно в
 * токенах, а не в числе строк: потолок выхода вызова считается в них же.
 */
export function parseFactsTokens(value) {
  const parsed = parseBoundedInt(value, FACTS_LIMITS.min, FACTS_LIMITS.max)
  if (!parsed.ok) {
    return {
      ok: false,
      message: `Лимит фактов: целое от ${FACTS_LIMITS.min} до ${FACTS_LIMITS.max}`,
    }
  }
  return { ok: true, value: parsed.value ?? FACTS_LIMITS.default }
}

/**
 * Родитель нового сообщения в дереве (стратегия `branches`). Ноль — корень,
 * без поля — голова ветки. Принадлежность сессии и роль проверяет агент:
 * здесь только форма.
 */
export function parseParentId(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return { ok: false, message: 'Поле parentId должно быть числом' }
  return { ok: true, value: n }
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
 * Идентификатор профиля — такой же UUID сервера, что и у сессии, и
 * проверяется так же: по форме. Угадать чужой — то же, что угадать номер
 * запуска; профиль и без того открыт всем (ADR 2026-09-15-2024, п. 2).
 */
export function isProfileId(value) {
  return isSessionId(value)
}

/** Имя профиля — метка, не ключ: 1–40 знаков после чистки (ADR, п. 2). */
export const PROFILE_NAME_CHARS = 40

export function parseProfileName(value) {
  if (typeof value !== 'string') return { ok: false, message: 'Поле name должно быть строкой' }
  const name = value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim()
  if (name.length === 0) return { ok: false, message: 'Имя профиля не может быть пустым' }
  if (name.length > PROFILE_NAME_CHARS) {
    return { ok: false, message: `Имя профиля длиннее ${PROFILE_NAME_CHARS} символов` }
  }
  return { ok: true, name }
}

/**
 * Потолок ответа агента дня 11 — потолок его класса роутера
 * `layered_dialogue`, а не общий `MAX_OUTPUT_TOKENS` сервиса (4096):
 * иначе окно настроек обещало бы 4096, а роутер отвергал бы всё выше 2048
 * (ADR 2026-09-15-2024, п. 8.1 и 8.2).
 */
export const LAYERED_MAX_TOKENS = 2048

/**
 * Потолок фактов одной темы (ADR 2026-09-15-2024, п. 6.1) — временное рабочее
 * значение решения владельца 8. Одно число на хранилище, запуск и ручку
 * монитора: тремя копиями они разошлись бы молча.
 */
export const TOPIC_FACT_CAP = 60

/**
 * Круг проверки ответа (ADR 2026-09-21-1747, п. 2): сколько раз запуск может
 * пройти «Сборку → Вызов → Проверку». Умолчание 2 — цикл виден без настройки;
 * 1 читается как «цикла нет»: один ответ, одна проверка, возврата нет.
 */
export const REVIEW_ROUNDS = { min: 1, max: 3, default: 2 }

/**
 * Предел кругов. Умолчания здесь нет намеренно (решение владельца
 * 2026-09-21): единственный источник истины — настройки профиля, их читает
 * день и по ним же резервирует слоты лимитера. Молчаливое умолчание на
 * стороне агента означало бы второе число: день зарезервировал бы слоты под
 * одно, а запуск сделал бы круги по другому. Отсутствующее значение — явный
 * отказ, как и негодное.
 */
export function parseReviewRounds(value) {
  const parsed = parseBoundedInt(value, REVIEW_ROUNDS.min, REVIEW_ROUNDS.max)
  if (!parsed.ok || parsed.value === undefined) {
    return {
      ok: false,
      message: `Кругов проверки: целое от ${REVIEW_ROUNDS.min} до ${REVIEW_ROUNDS.max}`,
    }
  }
  return { ok: true, value: parsed.value }
}

/**
 * Проверяющая модель. Список тот же, что у рабочей модели дня 13
 * (`LAYERED_MODELS`): выбор, годный для ответа, годен и для проверки, а
 * чужой идентификатор провайдера роутеру не уходит вовсе.
 */
export function parseReviewModel(value, defaults = {}) {
  const id = value === undefined || value === null || value === '' ? defaults.reviewModel : value
  if (!LAYERED_MODELS.some((m) => m.id === id)) {
    return { ok: false, message: 'Неизвестная проверяющая модель' }
  }
  return { ok: true, value: id }
}

/**
 * Настройки агента за профилем — закрытый список ключей («Уточнения», 6).
 * Проверяются теми же разборщиками, что вход запуска: значение, годное в
 * настройках, обязано быть годным и в запуске, иначе панель сохраняла бы
 * то, чем нельзя воспользоваться. Неизвестный ключ — ошибка, а не молчание:
 * настройки хранятся целиком заново, и «пропавшее» поле заметить нечем.
 */
const SETTING_KEYS = [
  'strategy',
  'model',
  'contextTokens',
  'summarizeAt',
  'window',
  'factsTokens',
  'temperature',
  'maxTokens',
  'stopSequences',
  'system',
  // Настройки дня 13. Дни 6–11 их не присылают, а разбор идёт только с
  // `options.review`: у агента без круга проверки этих ключей не бывает.
  'reviewModel',
  'reviewRounds',
]

/**
 * `options` — отличия агента дня 13 (ADR 2026-09-21-1747, п. 5): свой потолок
 * контекста и порога сводки и две настройки круга проверки. Без них разбор
 * тот же, что у дня 11, и `PARAM_LIMITS` дней 6–11 не меняется.
 */
export function parseSettings(source, defaults = {}, models = MODELS, options = {}) {
  const contextMax = options.contextMax ?? PARAM_LIMITS.contextTokens
  const summarizeMax = options.summarizeMax ?? SUMMARIZE_LIMITS.max
  const review = options.review === true
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, message: 'Настройки должны быть объектом' }
  }
  for (const key of Object.keys(source)) {
    if (!SETTING_KEYS.includes(key)) return { ok: false, message: `Неизвестная настройка: ${key}` }
    if (!review && (key === 'reviewModel' || key === 'reviewRounds')) {
      return { ok: false, message: `Неизвестная настройка: ${key}` }
    }
  }

  const settings = {}
  const has = (key) => source[key] !== undefined && source[key] !== null && source[key] !== ''

  const strategy = parseStrategy(source.strategy)
  if (!strategy.ok) return strategy
  if (strategy.value !== null) settings.strategy = strategy.value

  if (has('model')) {
    if (!models.some((m) => m.id === source.model)) {
      return { ok: false, message: 'Неизвестная модель' }
    }
    settings.model = source.model
  }

  const contextTokens = parseBoundedInt(source.contextTokens, 0, contextMax)
  if (!contextTokens.ok) {
    return { ok: false, message: `Размер контекста: целое от 0 до ${contextMax}` }
  }
  if (contextTokens.value !== undefined) settings.contextTokens = contextTokens.value

  // Порог сводки сверяется с тем размером контекста, который получится после
  // записи: пара «порог больше контекста» не должна попасть в базу и всплыть
  // отказом на первом же запуске. Умолчание спрашивается у реестра того
  // агента, чьи настройки правятся, — тем же порядком, что `parseParams`:
  // иначе запуск пошёл бы с контекстом реестра, а настройки сверялись бы с
  // другим числом, и порог «влез бы» там, где в запуске он больше окна.
  const summarizeAt = parseSummarizeAt(
    source.summarizeAt,
    contextTokens.value ?? defaults.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    summarizeMax,
  )
  if (!summarizeAt.ok) return summarizeAt
  if (summarizeAt.value !== null) settings.summarizeAt = summarizeAt.value

  if (has('window')) {
    const window = parseWindow(source.window)
    if (!window.ok) return window
    settings.window = window.value
  }

  if (has('factsTokens')) {
    const facts = parseFactsTokens(source.factsTokens)
    if (!facts.ok) return facts
    settings.factsTokens = facts.value
  }

  const temperature = parseTemperature(source.temperature)
  if (!temperature.ok) return { ok: false, message: 'Температура: число от 0 до 1 с шагом 0.1' }
  if (temperature.value !== undefined) settings.temperature = temperature.value

  const maxTokens = parseBoundedInt(source.maxTokens, 1, LAYERED_MAX_TOKENS)
  if (!maxTokens.ok) {
    return { ok: false, message: `Лимит токенов: целое от 1 до ${LAYERED_MAX_TOKENS}` }
  }
  if (maxTokens.value !== undefined) settings.maxTokens = maxTokens.value

  const stop = parseStopSequences(source.stopSequences)
  if (!stop.ok) return stop
  if (stop.value.length > 0) settings.stopSequences = stop.value

  if (has('system')) {
    const system = parseSystem(source.system)
    if (!system.ok) return system
    settings.system = system.system
  }

  if (review) {
    if (has('reviewModel')) {
      const reviewModel = parseReviewModel(source.reviewModel, defaults)
      if (!reviewModel.ok) return reviewModel
      settings.reviewModel = reviewModel.value
    }
    if (has('reviewRounds')) {
      const rounds = parseReviewRounds(source.reviewRounds)
      if (!rounds.ok) return rounds
      settings.reviewRounds = rounds.value
    }
  }

  return { ok: true, settings }
}

/**
 * Тема от пользователя. С дня 8 поле необязательно: релевантность считается
 * по репликам разговора (ADR 2026-09-09-2134). Дни 6 и 7 продолжают его
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

/**
 * Стоп-последовательности: не больше четырёх, каждая — строка до 40 знаков.
 * Один разборщик на запуск и на настройки профиля: значение, годное в
 * настройках, обязано быть годным и в запуске.
 */
function parseStopSequences(raw) {
  const list = raw === undefined || raw === null || raw === '' ? [] : raw
  if (!Array.isArray(list)) return { ok: false, message: 'stopSequences должен быть массивом' }
  if (list.length > PARAM_LIMITS.stopSequences) {
    return { ok: false, message: `Стоп-последовательностей не больше ${PARAM_LIMITS.stopSequences}` }
  }
  const value = []
  for (const entry of list) {
    const cleaned = cleanText(entry)
    if (!cleaned.ok) return { ok: false, message: 'Стоп-последовательность должна быть строкой' }
    if (cleaned.text.length === 0) continue
    if (cleaned.text.length > PARAM_LIMITS.stopChars) {
      return { ok: false, message: `Стоп-последовательность длиннее ${PARAM_LIMITS.stopChars}` }
    }
    value.push(cleaned.text)
  }
  return { ok: true, value }
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
 *
 * `models` — список, по которому проверяется выбор. Умолчание `MODELS`:
 * день 11 передаёт `LAYERED_MODELS` сам, а дни 6–10 остаются с прежним
 * закрытым списком, не меняясь ни строкой (ADR 2026-09-16-1038).
 */
export function parseParams(
  source,
  { maxOutputTokens, defaults, models = MODELS, contextMax = PARAM_LIMITS.contextTokens },
) {
  const prompt = cleanText(source.prompt)
  if (!prompt.ok) return { ok: false, message: 'Поле prompt должно быть строкой' }
  if (prompt.text.length > PARAM_LIMITS.promptChars) {
    return { ok: false, message: `Запрос длиннее ${PARAM_LIMITS.promptChars} символов` }
  }

  const model = source.model ?? defaults.model
  if (!models.some((m) => m.id === model)) return { ok: false, message: 'Неизвестная модель' }

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
  const contextTokens = parseBoundedInt(source.contextTokens, 0, contextMax)
  if (!contextTokens.ok) {
    return { ok: false, message: `Размер контекста: целое от 0 до ${contextMax}` }
  }

  const temperature = parseTemperature(source.temperature)
  if (!temperature.ok) {
    return { ok: false, message: 'Температура: число от 0 до 1 с шагом 0.1' }
  }

  const stop = parseStopSequences(source.stopSequences)
  if (!stop.ok) return stop
  const stopSequences = stop.value

  return {
    ok: true,
    params: {
      prompt: prompt.text,
      model,
      maxTokens: maxTokens.value ?? defaults.maxTokens,
      perSource: perSource.value ?? defaults.perSource,
      // Число статей необязательно: без него подборку набирает агент под
      // предел входа модели (ADR 2026-09-09-2134).
      articles: articles.value ?? defaults.articles ?? null,
      contextTokens: contextTokens.value ?? defaults.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
      temperature: temperature.value ?? defaults.temperature,
      stopSequences,
    },
  }
}

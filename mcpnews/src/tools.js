// Два инструмента единицы `mcpnews` (ADR 2026-09-28-0736, п. 3). Ключей не
// требует ни один. Ни один аргумент не является URL, хостом или путём: хост
// зашит здесь, аргументы проверены в `args.js` до вызова.

import { createHash } from 'node:crypto'
import { ArgError, integer, parser, plainString } from './args.js'
import { getJson } from './net.js'

/** Хост — константа модуля. Аргументом он не приходит никогда. */
const ALGOLIA = 'https://hn.algolia.com/api/v1/search'
/** Ссылка на обсуждение собирается нами из зашитого хоста, а не из ответа. */
const HN_ITEM = 'https://news.ycombinator.com/item?id='

/** Предел выжимки — ADR, п. 3: до 2000 знаков. */
export const SUMMARY_LIMIT = 2000

const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)

/**
 * Ссылка из ответа поставщика — недоверенные данные. Наружу она уходит
 * только http(s) и только целой: иное значение обращается в `null`, и место
 * ссылки занимает собранное нами обсуждение на HN.
 */
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
}

/**
 * Поиск по Hacker News Algolia. Фильтр свежести обязателен: без него первый
 * же результат приходит из 2018 года (прогон архитектора, запись
 * `2026-09-28-0737`). `numericFilters` уходит В URL-КОДИРОВКЕ — сырой `>`
 * даёт 400 (тот же прогон), поэтому `encodeURIComponent` здесь не косметика.
 */
async function newsSearch({ query, days, limit }, { fetchImpl, now }) {
  const since = Math.floor(now() / 1000) - days * 24 * 60 * 60
  const url =
    `${ALGOLIA}?query=${encodeURIComponent(query)}` +
    `&tags=story&hitsPerPage=${limit}` +
    `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`

  const data = await getJson(url, { fetchImpl })
  const hits = Array.isArray(data?.hits) ? data.hits : []
  const items = hits.slice(0, limit).map((hit) => {
    const id = cut(String(hit?.objectID ?? ''), 32)
    return {
      title: cut(hit?.title ?? hit?.story_title, 300),
      url: safeUrl(hit?.url) ?? (id ? `${HN_ITEM}${encodeURIComponent(id)}` : null),
      points: number(hit?.points) ?? 0,
      comments: number(hit?.num_comments) ?? 0,
      author: cut(hit?.author, 80),
      createdAt: cut(hit?.created_at, 40),
    }
  })
  // Пункт без заголовка показывать нечего — он выпадает здесь, а не у клиента.
  const kept = items.filter((item) => item.title)
  return { query, days, found: kept.length, items: kept }
}

/**
 * Детерминированная выжимка — БЕЗ модели (ADR, п. 3). Никакой сети, никакого
 * ключа, никакой случайности: те же входные данные дают тот же текст и тот же
 * `sha256`. Это и есть предмет показа дня 19: цепочку ведёт код, и сверка
 * `sha256` выжимки с `sha256` прочитанного из хранилища что-то значит только
 * потому, что выжимка воспроизводима.
 */
function newsSummarize({ items }) {
  const ranked = items
    .map((item, index) => ({ ...item, index }))
    // Очки по убыванию; при равных — исходный порядок. Порядок сортировки
    // задан целиком, без опоры на устойчивость реализации.
    .sort((a, b) => b.points - a.points || a.index - b.index)

  const lines = ranked.map((item, position) => {
    const parts = [`${position + 1}. ${item.title}`, `${item.points} очков`]
    if (item.url) parts.push(item.url)
    return parts.join(' — ')
  })

  const full = lines.join('\n')
  const clipped = full.length > SUMMARY_LIMIT
  const text = clipped ? full.slice(0, SUMMARY_LIMIT) : full

  return {
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    count: ranked.length,
    clipped,
  }
}

/** Пункт для выжимки: те же поля, что отдаёт `news.search`, и их пределы. */
function parseItem(raw, position) {
  const what = `items[${position}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArgError(`${what}: ожидался объект`)
  }
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 300) : ''
  if (!title) throw new ArgError(`${what}.title: пустое значение`)
  return {
    title,
    // Ссылка сюда приходит от вызывающего — проверяется тем же `safeUrl`.
    url: safeUrl(raw.url),
    points: Number.isFinite(Number(raw.points)) ? Math.trunc(Number(raw.points)) : 0,
  }
}

/**
 * Определения инструментов. Порядок фиксирован: `tools/list` обязан быть
 * детерминирован, иначе тест на него ничего не значит.
 */
export function buildTools({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  return [
    {
      name: 'news.search',
      title: 'Свежие новости Hacker News',
      description:
        'Истории Hacker News по запросу за последние N дней (Algolia, без ключа). Аргумент — слова запроса, не адрес.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 80, description: 'Слова запроса: сфера или тема. Не адрес.' },
          days: { type: 'integer', minimum: 1, maximum: 30, default: 7, description: 'Окно свежести в днях.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Сколько историй вернуть.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      parse: parser((args) => ({
        query: plainString(args.query, { max: 80, what: 'query' }),
        days: integer(args.days, { min: 1, max: 30, fallback: 7, what: 'days' }),
        limit: integer(args.limit, { min: 1, max: 20, fallback: 5, what: 'limit' }),
      })),
      run: (value) => newsSearch(value, { fetchImpl, now }),
    },
    {
      name: 'news.summarize',
      title: 'Выжимка без модели',
      description:
        'Детерминированная выжимка списка новостей: заголовки по убыванию очков, до 2000 знаков, sha256 текста. Модель не вызывается, сети не требует.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: 20,
            description: 'Пункты в форме ответа news.search: title, url, points.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', maxLength: 300 },
                url: { type: 'string' },
                points: { type: 'integer' },
              },
              required: ['title'],
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      parse: parser((args) => {
        if (!Array.isArray(args.items)) {
          throw new ArgError('items: ожидался массив')
        }
        if (args.items.length === 0) {
          throw new ArgError('items: пустой список')
        }
        if (args.items.length > 20) {
          throw new ArgError('items: больше 20 пунктов')
        }
        return { items: args.items.map(parseItem) }
      }),
      run: (value) => newsSummarize(value),
    },
  ]
}

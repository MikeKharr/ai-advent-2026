// Инструменты: аргумент никогда не адрес, хост зашит, фильтр свежести уходит
// в URL-кодировке, выжимка детерминирована и модели не зовёт.

import assert from 'node:assert/strict'
import test from 'node:test'
import { call, NOW_MS, recorder, startService, toolPayload } from './helpers.js'

const HITS = {
  hits: [
    { objectID: '1', title: 'Fintech A подняла раунд', url: 'https://example.com/a', points: 40, num_comments: 3, author: 'u1', created_at: '2026-09-27T10:00:00Z' },
    { objectID: '2', title: 'Fintech B вышла на рынок', url: 'https://example.com/b', points: 120, num_comments: 9, author: 'u2', created_at: '2026-09-26T10:00:00Z' },
  ],
}

test('адрес в аргументе отвергается: инструмент не запускается и наружу не ходит', async (t) => {
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'news.search', { query: 'http://169.254.169.254/latest' })).json()
  // Красная ветвь: убрать проверку `ADDRESS_LIKE` в `args.js` — аргумент
  // проходит, инструмент исполняется, и `urls` перестаёт быть пустым.
  assert.equal(body.result.isError, true)
  assert.deepEqual(urls, [], 'запроса наружу быть не должно')
})

test('отказ инструмента приходит через isError, а не через error протокола', async (t) => {
  const { fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'news.search', { query: 'fintech', days: 999 })).json()
  assert.equal(body.error, undefined, 'негодный аргумент не рвёт протокол')
  assert.equal(body.result.isError, true)
  assert.match(JSON.parse(body.result.content[0].text).error, /days/)
})

test('запрос уходит на зашитый хост с URL-кодированным numericFilters', async (t) => {
  const { urls, fetchImpl } = recorder([HITS])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  await call(service.base, 'news.search', { query: 'fintech startup', days: 7, limit: 5 })

  assert.equal(urls.length, 1)
  const url = new URL(urls[0])
  assert.equal(url.origin, 'https://hn.algolia.com')
  assert.equal(url.pathname, '/api/v1/search')
  // Сырой `>` в адресе даёт 400 (прогон архитектора, 2026-09-28-0737).
  // Красная ветвь: снять `encodeURIComponent` вокруг `created_at_i>...` —
  // в сыром адресе появится `>`, и это утверждение краснеет.
  assert.equal(urls[0].includes('>'), false, 'сырой > в адресе даёт 400 у поставщика')
  const since = Math.floor(NOW_MS / 1000) - 7 * 24 * 60 * 60
  assert.equal(url.searchParams.get('numericFilters'), `created_at_i>${since}`)
  assert.equal(url.searchParams.get('tags'), 'story')
})

test('ссылка не http(s) из ответа поставщика заменяется обсуждением на HN', async (t) => {
  const { fetchImpl } = recorder([
    { hits: [{ objectID: '42', title: 'Тема', url: 'javascript:alert(1)', points: 5, created_at: '2026-09-27T10:00:00Z' }] },
  ])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'news.search', { query: 'fintech' })).json())
  assert.equal(payload.items[0].url, 'https://news.ycombinator.com/item?id=42')
})

test('пункт без заголовка не показывается', async (t) => {
  const { fetchImpl } = recorder([{ hits: [{ objectID: '9', title: null, points: 1 }] }])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'news.search', { query: 'fintech' })).json())
  assert.deepEqual(payload.items, [])
  assert.equal(payload.found, 0)
})

test('отказ поставщика — isError с нашим текстом, без текста поставщика', async (t) => {
  const fetchImpl = async () => new Response('внутренности поставщика', { status: 503 })
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'news.search', { query: 'fintech' })).json()
  assert.equal(body.result.isError, true)
  const text = body.result.content[0].text
  assert.match(text, /503/)
  assert.equal(text.includes('внутренности поставщика'), false)
})

test('выжимка детерминирована: тот же вход — тот же текст и тот же sha256', async (t) => {
  const { fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const items = [
    { title: 'Третья', points: 1 },
    { title: 'Первая', points: 100, url: 'https://example.com/1' },
    { title: 'Вторая', points: 50 },
  ]
  const a = toolPayload((await call(service.base, 'news.summarize', { items })).json())
  const b = toolPayload((await call(service.base, 'news.summarize', { items })).json())

  assert.deepEqual(a, b)
  // Порядок задан очками по убыванию — красная ветвь: поменять знак
  // сравнения в сортировке, и первой строкой станет «Третья».
  assert.match(a.text.split('\n')[0], /^1\. Первая — 100 очков — https:\/\/example\.com\/1$/)
  assert.match(a.text.split('\n')[1], /^2\. Вторая — 50 очков$/)
  assert.equal(a.count, 3)
  assert.equal(a.clipped, false)
  assert.match(a.sha256, /^[0-9a-f]{64}$/)
})

test('выжимка не ходит в сеть и не зовёт модель', async (t) => {
  // Пустой список ответов: любой поход наружу бросит «лишний запрос наружу».
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'news.summarize', { items: [{ title: 'Тема', points: 3 }] })).json()
  assert.equal(body.result.isError, undefined)
  assert.deepEqual(urls, [])
})

test('выжимка режется по 2000 знаков и признаётся в этом', async (t) => {
  const { fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const items = Array.from({ length: 20 }, (_, i) => ({ title: 'з'.repeat(300), points: 20 - i }))
  const payload = toolPayload((await call(service.base, 'news.summarize', { items })).json())
  assert.equal(payload.text.length, 2000)
  assert.equal(payload.clipped, true)
})

test('sha256 выжимки считается от отданного текста, а не от исходного', async (t) => {
  const { fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const items = Array.from({ length: 20 }, (_, i) => ({ title: 'з'.repeat(300), points: 20 - i }))
  const payload = toolPayload((await call(service.base, 'news.summarize', { items })).json())
  const { createHash } = await import('node:crypto')
  // Ровно это сверяет день 19 после `file.read`: считать хеш от необрезанного
  // текста значило бы вернуть хеш того, чего никто не получал.
  assert.equal(payload.sha256, createHash('sha256').update(payload.text, 'utf8').digest('hex'))
})

test('пустой список пунктов — отказ инструмента, а не пустая выжимка', async (t) => {
  const { fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'news.summarize', { items: [] })).json()
  assert.equal(body.result.isError, true)
})

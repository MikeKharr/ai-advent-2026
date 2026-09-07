import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderCandidates, sanitizePicks } from '../anthropic.js'
import { createCache, sphereKey } from '../cache.js'
import { buildDigest, pickCandidates } from '../digest.js'
import { parseEnv, parseSphere } from '../env.js'
import { collectItems } from '../feeds.js'
import { createLimiter } from '../limits.js'

const ENV = {
  ANTHROPIC_API_KEY: 'test',
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  MAX_OUTPUT_TOKENS: 1024,
  MAX_DAILY_CALLS: 3,
  RATE_LIMIT_PER_MIN: 2,
  RATE_LIMIT_PER_HOUR: 5,
}

const NOW = Date.parse('2026-09-07T12:00:00Z')

function feedXml(entries) {
  const items = entries
    .map(
      (e) => `<item><title>${e.title}</title><link>${e.url}</link>
        <pubDate>${new Date(e.at).toUTCString()}</pubDate><description>${e.summary ?? ''}</description></item>`,
    )
    .join('')
  return `<rss><channel>${items}</channel></rss>`
}

/** fetch, отвечающий заранее заданными лентами и ответом модели. */
function fakeFetch({ feeds = {}, model = null, onModelCall = () => {} } = {}) {
  return async (url, options) => {
    if (typeof url === 'string' && url.includes('api.anthropic.com')) {
      onModelCall(JSON.parse(options.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify(model) }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      }
    }
    const body = feeds[url]
    if (body === undefined) return { ok: false, status: 404, body: null }
    return {
      ok: true,
      status: 200,
      body: { getReader: () => readerFor(body) },
    }
  }
}

function readerFor(text) {
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return {
    async read() {
      if (sent) return { done: true, value: undefined }
      sent = true
      return { done: false, value: bytes }
    },
    async cancel() {},
  }
}

const FEED_A = { source: 'A', region: 'США', url: 'https://a.test/feed' }
const FEED_B = { source: 'B', region: 'Европа', url: 'https://b.test/feed' }

test('отбрасывает материалы старше недели', async () => {
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Свежая', url: 'https://a.test/1', at: NOW - 2 * 86400000 },
        { title: 'Старая', url: 'https://a.test/2', at: NOW - 30 * 86400000 },
      ]),
    },
  })
  const { items } = await collectItems({ now: NOW, fetchImpl, feeds: [FEED_A] })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Свежая')
})

test('отказ ленты не роняет сборку, а попадает в note', async () => {
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    model: { picks: [{ n: 1, why: 'подходит' }], note: '' },
  })
  const digest = await buildDigest('fintech', {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A, FEED_B] },
  })
  assert.equal(digest.news.length, 1)
  assert.match(digest.note, /Недоступны ленты: B/)
})

test('карточка собирается из ленты, а не из ответа модели', async () => {
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Настоящий заголовок', url: 'https://a.test/real', at: NOW - 3600000 },
      ]),
    },
    // Модель пытается подсунуть свои поля — они игнорируются.
    model: {
      picks: [{ n: 1, why: 'причина', url: 'https://evil.test/fake', title: 'Подделка' }],
      note: '',
    },
  })
  const digest = await buildDigest('fintech', {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
  })
  assert.equal(digest.news[0].url, 'https://a.test/real')
  assert.equal(digest.news[0].title, 'Настоящий заголовок')
  assert.equal(digest.news[0].why, 'причина')
})

test('номера вне списка отбрасываются, остаётся не больше трёх', () => {
  const picks = sanitizePicks(
    [
      { n: 0 },
      { n: 99 },
      { n: 2, why: 'a' },
      { n: 2, why: 'дубль' },
      { n: 1, why: 'b' },
      { n: 3, why: 'c' },
      { n: 4, why: 'd' },
    ],
    5,
  )
  assert.deepEqual(
    picks.map((p) => p.n),
    [2, 1, 3],
  )
})

test('в список для модели ссылки не попадают', () => {
  const text = renderCandidates([
    {
      title: 'Заголовок',
      url: 'https://secret.test/x',
      date: '2026-09-07T00:00:00.000Z',
      summary: 'кратко',
      source: 'A',
    },
  ])
  assert.ok(!text.includes('secret.test'))
  assert.match(text, /1\. \[2026-09-07\] \[A\] Заголовок/)
})

test('пустая выдача — честное состояние, а не ошибка', async () => {
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Что-то', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    model: { picks: [], note: 'по этой сфере ничего нет' },
  })
  const digest = await buildDigest('квантовые вычисления', {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
  })
  assert.equal(digest.news.length, 0)
  assert.match(digest.note, /не нашлось|ничего нет/)
})

test('суточный лимит проверяется до вызова API', async () => {
  let modelCalls = 0
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    model: { picks: [], note: '' },
    onModelCall: () => {
      modelCalls += 1
    },
  })
  const env = { ...ENV, MAX_DAILY_CALLS: 1, RATE_LIMIT_PER_MIN: 10 }
  const limiter = createLimiter(env)
  const cache = createCache()
  const deps = { fetchImpl, now: NOW, feeds: [FEED_A] }

  await buildDigest('a', { cache, limiter, env, ip: '1.1.1.1', deps })
  await assert.rejects(
    () => buildDigest('b', { cache, limiter, env, ip: '1.1.1.1', deps }),
    /Суточный лимит/,
  )
  assert.equal(modelCalls, 1, 'после отказа лимита API вызываться не должен')
})

test('повтор той же сферы берётся из кэша, без вызова API', async () => {
  let modelCalls = 0
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    model: { picks: [{ n: 1, why: 'ок' }], note: '' },
    onModelCall: () => {
      modelCalls += 1
    },
  })
  const cache = createCache()
  const limiter = createLimiter(ENV)
  const deps = { fetchImpl, now: NOW, feeds: [FEED_A] }

  await buildDigest('Fintech', { cache, limiter, env: ENV, ip: '1.1.1.1', deps })
  const second = await buildDigest('  fintech ', { cache, limiter, env: ENV, ip: '1.1.1.1', deps })
  assert.equal(modelCalls, 1)
  assert.equal(second.cached, true)
})

test('ключ кэша не зависит от регистра и пробелов', () => {
  const day = new Date('2026-09-07T00:00:00Z')
  assert.equal(sphereKey('  FinTech  ', day), sphereKey('fintech', day))
})

test('окружение разбирается, ошибки собираются, а не глотаются', () => {
  const { env, errors } = parseEnv({ MAX_DAILY_CALLS: 'много', PORT: '9090' })
  assert.equal(env.PORT, 9090)
  assert.equal(env.MAX_DAILY_CALLS, 50)
  assert.ok(errors.some((e) => e.includes('ANTHROPIC_API_KEY')))
  assert.ok(errors.some((e) => e.includes('MAX_DAILY_CALLS')))
})

test('сфера валидируется на границе', () => {
  assert.equal(parseSphere('  fintech  ').sphere, 'fintech')
  assert.equal(parseSphere('').ok, false)
  assert.equal(parseSphere('x'.repeat(61)).ok, false)
  assert.equal(parseSphere(42).ok, false)
})

test('кандидаты берутся по кругу источников, а не только у самых плодовитых', () => {
  const items = [
    ...Array.from({ length: 50 }, (_, i) => ({ title: `Индия ${i}`, source: 'Inc42', date: '2026-09-07' })),
    { title: 'Европа 1', source: 'Sifted', date: '2026-09-06' },
    { title: 'Китай 1', source: 'Pandaily', date: '2026-09-05' },
  ]
  const picked = pickCandidates(items, 6)
  const sources = new Set(picked.map((p) => p.source))
  assert.ok(sources.has('Sifted'), 'Sifted должен попасть в выборку')
  assert.ok(sources.has('Pandaily'), 'Pandaily должен попасть в выборку')
  assert.equal(picked.length, 6)
})

test('круг не теряет записи, если источник один', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ title: `A ${i}`, source: 'A', date: '2026-09-07' }))
  assert.equal(pickCandidates(items, 10).length, 5)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAnswer, capPerSource, withinTextBudget } from '../answer.js'
import { renderCandidates, stripUnknownLinks } from '../anthropic.js'
import { createCache } from '../cache.js'
import { parseEnv, parseParams, parseSphere } from '../env.js'
import { createLimiter } from '../limits.js'

const ENV = {
  ANTHROPIC_API_KEY: 'test',
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  MAX_OUTPUT_TOKENS: 2048,
  MAX_DAILY_CALLS: 3,
  RATE_LIMIT_PER_MIN: 2,
  RATE_LIMIT_PER_HOUR: 5,
}

const DEFAULTS = { prompt: '', stopSequences: [], maxTokens: 600, perSource: 5, temperature: 1 }

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
function fakeFetch({ feeds = {}, answer = 'ответ', usage, stop, onModelCall = () => {} } = {}) {
  return async (url, options) => {
    if (typeof url === 'string' && url.includes('api.anthropic.com')) {
      onModelCall(JSON.parse(options.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: answer }],
          usage: usage ?? { input_tokens: 100, output_tokens: 50 },
          stop_reason: stop?.reason ?? 'end_turn',
          stop_sequence: stop?.sequence ?? null,
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

test('параметры: дефолты при пустых полях', () => {
  const { params } = parseParams({}, ENV)
  assert.deepEqual(params, DEFAULTS)
})

test('температура: шаг 0.1, границы 0–1, дефолт 1', () => {
  assert.equal(parseParams({}, ENV).params.temperature, 1)
  assert.equal(parseParams({ temperature: '0' }, ENV).params.temperature, 0)
  assert.equal(parseParams({ temperature: '0.7' }, ENV).params.temperature, 0.7)
  assert.equal(parseParams({ temperature: '1' }, ENV).params.temperature, 1)
  // Двоичная дробь: 0.1*3 приходит как 0.30000000000000004 и обязана пройти.
  assert.equal(parseParams({ temperature: 0.1 * 3 }, ENV).params.temperature, 0.3)
})

test('температура вне шкалы или диапазона — отказ', () => {
  assert.equal(parseParams({ temperature: '1.1' }, ENV).ok, false)
  assert.equal(parseParams({ temperature: '-0.1' }, ENV).ok, false)
  assert.equal(parseParams({ temperature: '0.15' }, ENV).ok, false)
  assert.equal(parseParams({ temperature: 'жарко' }, ENV).ok, false)
  assert.equal(parseParams({ temperature: {} }, ENV).ok, false)
  assert.equal(parseParams({ temperature: Number.NaN }, ENV).ok, false)
})

test('температура доезжает до тела запроса и до записи ленты', async () => {
  let body = null
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    onModelCall: (b) => {
      body = b
    },
  })
  const result = await buildAnswer(
    'fintech',
    { ...DEFAULTS, temperature: 0.2 },
    {
      cache: createCache(),
      limiter: createLimiter(ENV),
      env: ENV,
      ip: '1.1.1.1',
      deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
    },
  )
  assert.equal(body.temperature, 0.2)
  assert.equal(result.params.temperature, 0.2, 'запись ленты несёт температуру')
})

test('дефолтная температура в тело запроса не кладётся', async () => {
  let body = null
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    onModelCall: (b) => {
      body = b
    },
  })
  const result = await buildAnswer('fintech', DEFAULTS, {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
  })
  // Модели вроде Opus 4.7+ отвергают параметр целиком, даже с дефолтным
  // значением: не отправляя его, день остаётся рабочим и на них.
  assert.equal('temperature' in body, false)
  assert.equal(result.params.temperature, 1, 'в ленте температура всё равно видна')
})

test('значения около шага не округляются молча', () => {
  assert.equal(parseParams({ temperature: '0.0999991' }, ENV).ok, false)
  assert.equal(parseParams({ temperature: '1e-7' }, ENV).ok, false)
  assert.equal(parseParams({ temperature: '0.9999999' }, ENV).ok, false)
})

test('параметры: границы отвергаются, а не подменяются молча', () => {
  assert.equal(parseParams({ maxTokens: '0' }, ENV).ok, false)
  assert.equal(parseParams({ maxTokens: '4096' }, ENV).ok, false)
  assert.equal(parseParams({ maxTokens: 'abc' }, ENV).ok, false)
  assert.equal(parseParams({ perSource: '16' }, ENV).ok, false)
  assert.equal(parseParams({ perSource: '0' }, ENV).ok, false)
  assert.equal(parseParams({ prompt: 'x'.repeat(1001) }, ENV).ok, false)
  assert.equal(parseParams({ stop: 'x'.repeat(401) }, ENV).ok, false)
})

test('параметры: стоп-последовательности — построчно, не больше четырёх', () => {
  const ok = parseParams({ stop: ' раунд \n\nIPO\r\nэкзит ' }, ENV)
  assert.deepEqual(ok.params.stopSequences, ['раунд', 'IPO', 'экзит'])
  assert.equal(parseParams({ stop: 'a\nb\nc\nd\ne' }, ENV).ok, false)
})

test('не больше N статей с источника, свежесть сохраняется', () => {
  const items = [
    ...Array.from({ length: 40 }, (_, i) => ({ title: `A${i}`, source: 'A' })),
    { title: 'B0', source: 'B' },
  ]
  const capped = capPerSource(items, 30)
  assert.equal(capped.filter((x) => x.source === 'A').length, 30)
  assert.equal(capped.filter((x) => x.source === 'B').length, 1)
  assert.equal(capped[0].title, 'A0', 'самые свежие записи источника остаются первыми')
})

test('параметры пользователя доезжают до тела запроса к API', async () => {
  let body = null
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    onModelCall: (b) => {
      body = b
    },
  })
  const params = {
    prompt: 'таблицей',
    stopSequences: ['СТОП'],
    maxTokens: 77,
    perSource: 5,
    temperature: 0.3,
  }
  await buildAnswer('fintech', params, {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
  })
  assert.equal(body.max_tokens, 77)
  assert.equal(body.temperature, 0.3)
  assert.deepEqual(body.stop_sequences, ['СТОП'])
  assert.match(body.messages[0].content, /таблицей/)
  assert.equal(body.output_config, undefined, 'строгая схема дня 1 не применяется')
})

test('без стоп-последовательностей поле stop_sequences не отправляется', async () => {
  let body = null
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    onModelCall: (b) => {
      body = b
    },
  })
  await buildAnswer('fintech', DEFAULTS, {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
  })
  assert.equal(body.stop_sequences, undefined)
})

test('ответ несёт расход токенов и причину останова', async () => {
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    usage: { input_tokens: 1234, output_tokens: 56 },
    stop: { reason: 'stop_sequence', sequence: 'СТОП' },
  })
  const result = await buildAnswer('fintech', DEFAULTS, {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
  })
  assert.deepEqual(result.usage, { inputTokens: 1234, outputTokens: 56 })
  assert.equal(result.stopReason, 'stop_sequence')
  assert.equal(result.stopSequence, 'СТОП')
  assert.deepEqual(result.params, DEFAULTS)
})

test('в списке для модели есть ссылка и полный текст статьи', () => {
  const text = renderCandidates([
    {
      title: 'Заголовок',
      url: 'https://a.test/статья',
      date: '2026-09-07T00:00:00.000Z',
      summary: 'кратко',
      text: 'Полный текст статьи про раунд.',
      source: 'A',
    },
  ])
  assert.match(text, /1\. \[2026-09-07\] \[A\] Заголовок/)
  assert.ok(text.includes('https://a.test/статья'))
  assert.match(text, /Текст статьи: Полный текст статьи про раунд\./)
})

test('материал без полного текста помечается как анонс', () => {
  // Иначе модель решит, что статья короткая, а не урезанная изданием.
  const text = renderCandidates([
    {
      title: 'Заголовок',
      url: 'https://a.test/1',
      date: '2026-09-07T00:00:00.000Z',
      summary: 'только тизер',
      text: '',
      source: 'TechCrunch',
    },
  ])
  assert.match(text, /Издание не отдаёт полный текст в ленту\. Анонс: только тизер/)
  assert.ok(!text.includes('Текст статьи:'))
})

test('бюджет текста раздаётся, пока хватает, дальше остаётся заголовок', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    title: `T${i}`,
    url: `https://a.test/${i}`,
    source: 'A',
    text: 'x'.repeat(100),
  }))
  const capped = withinTextBudget(items, 250)
  assert.deepEqual(
    capped.map((c) => c.text.length),
    [100, 100, 0, 0, 0],
    'после исчерпания бюджета текст не досылается',
  )
  assert.deepEqual(
    capped.map((c) => c.textOmitted),
    [false, false, true, true, true],
    'срезанный бюджетом текст помечается, а не выдаётся за отсутствующий',
  )
})

test('срезанный бюджетом текст не выдаётся за отсутствующий у издания', () => {
  const rendered = renderCandidates([
    { title: 'A', url: 'https://a.test/1', date: '2026-09-07T00:00:00.000Z', source: 'A',
      summary: 'анонс', text: '', textOmitted: true },
    { title: 'B', url: 'https://b.test/1', date: '2026-09-07T00:00:00.000Z', source: 'B',
      summary: 'анонс', text: '', textOmitted: false },
  ])
  assert.match(rendered, /не поместился в бюджет этого запроса/)
  assert.match(rendered, /Издание не отдаёт полный текст в ленту/)
})

test('ссылка не из списка источников вырезается из ответа', () => {
  const items = [{ url: 'https://a.test/real' }]
  const text = 'Смотри https://a.test/real и https://evil.test/fake.'
  const clean = stripUnknownLinks(text, items)
  assert.ok(clean.includes('https://a.test/real'))
  assert.ok(!clean.includes('evil.test'))
  assert.ok(clean.includes('[ссылка не из списка источников].'))
})

test('ссылка из списка с хвостовой пунктуацией не вырезается', () => {
  const items = [{ url: 'https://a.test/real' }]
  const clean = stripUnknownLinks('Итог: https://a.test/real.', items)
  assert.ok(clean.includes('https://a.test/real.'))
})

test('повтор запроса с теми же параметрами снова вызывает API: ответы не кэшируются', async () => {
  let modelCalls = 0
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    onModelCall: () => {
      modelCalls += 1
    },
  })
  const cache = createCache()
  const limiter = createLimiter(ENV)
  const deps = { fetchImpl, now: NOW, feeds: [FEED_A] }

  await buildAnswer('fintech', DEFAULTS, { cache, limiter, env: ENV, ip: '1.1.1.1', deps })
  await buildAnswer('fintech', DEFAULTS, { cache, limiter, env: ENV, ip: '1.1.1.1', deps })
  assert.equal(modelCalls, 2)
})

test('суточный лимит проверяется до вызова API', async () => {
  let modelCalls = 0
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    onModelCall: () => {
      modelCalls += 1
    },
  })
  const env = { ...ENV, MAX_DAILY_CALLS: 1, RATE_LIMIT_PER_MIN: 10 }
  const limiter = createLimiter(env)
  const cache = createCache()
  const deps = { fetchImpl, now: NOW, feeds: [FEED_A] }

  await buildAnswer('a', DEFAULTS, { cache, limiter, env, ip: '1.1.1.1', deps })
  await assert.rejects(
    () => buildAnswer('b', DEFAULTS, { cache, limiter, env, ip: '1.1.1.1', deps }),
    /Суточный лимит/,
  )
  assert.equal(modelCalls, 1, 'после отказа лимита API вызываться не должен')
})

test('отказ лимита не запускает загрузку лент', async () => {
  let feedCalls = 0
  const fetchImpl = async (url) => {
    if (typeof url === 'string' && url.includes('anthropic'))
      throw new Error('API вызываться не должен')
    feedCalls += 1
    return { ok: false, status: 500, body: null }
  }
  const env = { ...ENV, MAX_DAILY_CALLS: 0 }
  await assert.rejects(
    () =>
      buildAnswer('a', DEFAULTS, {
        cache: createCache(),
        limiter: createLimiter(env),
        env,
        ip: '1.1.1.1',
        deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
      }),
    /Суточный лимит/,
  )
  assert.equal(feedCalls, 0)
})

test('пустые ленты — честное состояние без вызова API', async () => {
  let modelCalls = 0
  const fetchImpl = fakeFetch({
    feeds: {},
    onModelCall: () => {
      modelCalls += 1
    },
  })
  const result = await buildAnswer('fintech', DEFAULTS, {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A] },
  })
  assert.equal(modelCalls, 0)
  assert.equal(result.answer, '')
  assert.match(result.note, /Модель не вызывалась/)
})

test('отказ одной ленты не роняет сборку, а попадает в note', async () => {
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
  })
  const result = await buildAnswer('fintech', DEFAULTS, {
    cache: createCache(),
    limiter: createLimiter(ENV),
    env: ENV,
    ip: '1.1.1.1',
    deps: { fetchImpl, now: NOW, feeds: [FEED_A, FEED_B] },
  })
  assert.match(result.note, /Недоступны ленты: B/)
})

test('сфера принимается на любом языке, не только латиницей', () => {
  // Подсказки в UI есть на русском, китайском и хинди — граница не должна
  // резать не-латиницу: ленты индийские и китайские тоже.
  assert.equal(parseSphere('人工智能').sphere, '人工智能')
  assert.equal(parseSphere('  फिनटेक  ').sphere, 'फिनटेक')
  assert.equal(parseSphere('климатические технологии').ok, true)
})

test('сфера валидируется на границе', () => {
  assert.equal(parseSphere('  fintech  ').sphere, 'fintech')
  assert.equal(parseSphere('').ok, false)
  assert.equal(parseSphere('x'.repeat(61)).ok, false)
  assert.equal(parseSphere(42).ok, false)
})

test('параметры чужого типа — отказ, а не приведение и не падение', () => {
  // Объект без toString ронял String() и вместе с ним процесс (ревью, Б-1).
  const evil = { toString: null, valueOf: null }
  assert.equal(parseParams({ prompt: evil }, ENV).ok, false)
  assert.equal(parseParams({ prompt: ['a', 'b'] }, ENV).ok, false)
  assert.equal(parseParams({ stop: 42 }, ENV).ok, false)
  assert.equal(parseParams({ stop: {} }, ENV).ok, false)
  assert.equal(parseParams({ maxTokens: evil }, ENV).ok, false)
  assert.equal(parseParams({ perSource: [30] }, ENV).ok, false)
})

test('параллельный залп не проходит мимо суточного лимита', async () => {
  let modelCalls = 0
  const fetchImpl = fakeFetch({
    feeds: {
      'https://a.test/feed': feedXml([
        { title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 },
      ]),
    },
    onModelCall: () => {
      modelCalls += 1
    },
  })
  const env = { ...ENV, MAX_DAILY_CALLS: 1, RATE_LIMIT_PER_MIN: 10, RATE_LIMIT_PER_HOUR: 10 }
  const limiter = createLimiter(env)
  const cache = createCache()
  const deps = { fetchImpl, now: NOW, feeds: [FEED_A] }

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      buildAnswer(`сфера ${i}`, DEFAULTS, { cache, limiter, env, ip: '1.1.1.1', deps }),
    ),
  )
  assert.equal(modelCalls, 1, 'пять одновременных запросов при лимите 1 — один вызов API')
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(limiter.stats().callsToday, 1)
})

test('пустые ленты возвращают зарезервированный слот', async () => {
  const fetchImpl = fakeFetch({ feeds: {} })
  const env = { ...ENV, MAX_DAILY_CALLS: 1, RATE_LIMIT_PER_MIN: 10 }
  const limiter = createLimiter(env)
  const cache = createCache()
  const deps = { fetchImpl, now: NOW, feeds: [FEED_A] }

  await buildAnswer('a', DEFAULTS, { cache, limiter, env, ip: '1.1.1.1', deps })
  assert.equal(limiter.stats().callsToday, 0, 'вызова API не было — слот не потрачен')
})

test('поминутный лимит срабатывает и отпускает через минуту', () => {
  let t = NOW
  const env = { ...ENV, RATE_LIMIT_PER_MIN: 2, RATE_LIMIT_PER_HOUR: 100, MAX_DAILY_CALLS: 100 }
  const limiter = createLimiter(env, { now: () => t })
  for (let i = 0; i < 2; i += 1) assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.reserve('1.1.1.1').reason, 'minute')
  assert.equal(limiter.reserve('2.2.2.2').ok, true, 'другой адрес не должен страдать')
  t += 61_000
  assert.equal(limiter.reserve('1.1.1.1').ok, true, 'через минуту окно должно освободиться')
})

test('чужая ссылка не проходит сменой регистра схемы или хоста', () => {
  const items = [{ url: 'https://a.test/real' }]
  const clean = stripUnknownLinks('см. HTTPS://EVIL.TEST/x и httpS://evil.test/y', items)
  assert.ok(!/evil/i.test(clean.replace(/\[ссылка не из списка источников\]/g, '')))
})

test('своя ссылка с иным регистром хоста не вырезается', () => {
  const items = [{ url: 'https://a.test/real' }]
  const clean = stripUnknownLinks('см. https://A.TEST/real', items)
  assert.ok(!clean.includes('не из списка'))
})

test('ссылка из списка со скобками сохраняется целиком', () => {
  const items = [{ url: 'https://a.test/a_(b)' }]
  assert.equal(
    stripUnknownLinks('ок https://a.test/a_(b) конец', items),
    'ок https://a.test/a_(b) конец',
  )
  // А скобка, не входящая в URL, остаётся в тексте.
  assert.equal(stripUnknownLinks('(см. https://a.test/a_(b))', items), '(см. https://a.test/a_(b))')
})

test('одновременные запросы одной сферы читают ленты один раз', async () => {
  let feedFetches = 0
  const xml = feedXml([{ title: 'Есть', url: 'https://a.test/1', at: NOW - 86400000 }])
  const base = fakeFetch({ feeds: { 'https://a.test/feed': xml } })
  const fetchImpl = async (url, options) => {
    if (typeof url === 'string' && url.includes('a.test/feed')) feedFetches += 1
    return base(url, options)
  }
  const env = { ...ENV, MAX_DAILY_CALLS: 10, RATE_LIMIT_PER_MIN: 10, RATE_LIMIT_PER_HOUR: 10 }
  const cache = createCache()
  const limiter = createLimiter(env)
  const deps = { fetchImpl, now: NOW, feeds: [FEED_A] }

  await Promise.all(
    Array.from({ length: 5 }, () =>
      buildAnswer('fintech', DEFAULTS, { cache, limiter, env, ip: '1.1.1.1', deps }),
    ),
  )
  assert.equal(feedFetches, 1, 'кэш лент и once должны схлопывать параллельную загрузку')
})

test('окружение разбирается, ошибки собираются, а не глотаются', () => {
  const { env, errors } = parseEnv({ MAX_DAILY_CALLS: 'много', PORT: '9090' })
  assert.equal(env.PORT, 9090)
  assert.equal(env.MAX_DAILY_CALLS, 50)
  assert.ok(errors.some((e) => e.includes('ANTHROPIC_API_KEY')))
  assert.ok(errors.some((e) => e.includes('MAX_DAILY_CALLS')))
})

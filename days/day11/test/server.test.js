// Интеграционный тест дня: настоящий сервер дня против поддельного сервиса
// агентов. Проверяется связка — две cookie, оба окна лимитера, ручки профиля
// и его диалогов, создание диалога первым сообщением, прокси потока.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { after, before, test } from 'node:test'

/** Поддельный сервис агентов: помнит запросы и переписку по диалогам. */
const agentLog = []
let agentMode = 'ok'
const stored = new Map()

const PID = '11111111-1111-4111-8111-111111111111'
/** Профиль без живого диалога: выбор его сессию не создаёт. */
const EMPTY_PID = '22222222-2222-4222-8222-222222222222'
/** Профиль, у которого двадцать живых диалогов: двадцать первый — 409. */
const FULL_PID = '33333333-3333-4333-8333-333333333333'
const GONE_PID = '44444444-4444-4444-8444-444444444444'
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
/** Диалог чужого профиля: агент отвечает на него как на несуществующий. */
const ALIEN_SID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NEW_SID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
/** Ключевой профиль: сервис отдаёт у него имя ключа, открытый — `null`. */
const KEYED_PID = '55555555-5555-4555-8555-555555555555'

/**
 * Отказы ключа, которые выдаёт сервис агентов, а не день: значение ключа,
 * окно отказов и суточный потолок сверяет он. Стенд повторяет его коды и его
 * заголовки, чтобы проверялся проброс дня, а не сверка.
 */
const KEY_REFUSALS = {
  wrong: [403, { ok: false, code: 'bad_model_key', message: 'Ключ модели не принят' }],
  burst: [
    429,
    { ok: false, code: 'too_many_attempts', message: 'Слишком много попыток — подождите минуту' },
    { 'retry-after': '37' },
  ],
  over: [
    429,
    {
      ok: false,
      code: 'model_key_daily_cap',
      message: 'Суточный потолок 2000 запусков на ключ исчерпан',
      resetAt: '2026-10-09T00:00:00.000Z',
    },
  ],
  wrongmodel: [
    403,
    {
      ok: false,
      code: 'keyed_profile_model',
      message: 'В этом профиле доступна только модель без встроенных отказов.',
    },
  ],
}

const profileBody = (id, sessions) => ({
  ok: true,
  profile: {
    id,
    // Имя ключа — поле, по которому экран узнаёт ключевой профиль.
    keyName: id === KEYED_PID ? 'mika' : null,
    name: id === PID ? 'Мика' : 'Гость',
    settings: { strategy: 'summary', maxTokens: 2000 },
    rules: [{ key: 'тон', value: 'коротко', sourceSessionId: SID, updatedAt: 1 }],
    topics: [{ id: 7, title: 'fintech', facts: 12, updatedAt: 2 }],
    sessions,
    lastSession: sessions[0]?.id ?? null,
  },
  sessionCap: 20,
})

const LIVE = [
  { id: SID, lastSeenAt: 1000, messages: 14, topicId: 7, topicTitle: 'fintech' },
  { id: OTHER_SID, lastSeenAt: 900, messages: 6, topicId: null, topicTitle: null },
]

const agent = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString()
  agentLog.push({
    method: req.method,
    url: req.url,
    auth: req.headers.authorization,
    // Заголовки, по которым проверяется Б5: что ключ модели дошёл, а чужие
    // заголовки клиента — нет. `undefined` в записи и значит «не дошёл».
    modelKey: req.headers['x-model-key'],
    evalKey: req.headers['x-eval-key'],
    forwardedHost: req.headers['x-forwarded-host'],
    cookie: req.headers.cookie,
    body,
  })
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  if (agentMode === 'down') {
    res.destroy()
    return
  }
  const [path, query = ''] = req.url.split('?')
  const profileOf = new URLSearchParams(query).get('profile')

  // Ровно те ветви, на которых сервис агентов отказывает по ключу
  // (`agents/src/service.js`): профили, диалоги и создание запуска. На
  // `/v1/agents` и `/healthz` ключ не спрашивают, и отказа там нет.
  const refusal = KEY_REFUSALS[req.headers['x-model-key']]
  if (
    refusal &&
    (path.startsWith('/v1/profiles') || path.startsWith('/v1/sessions') || path === '/v1/runs')
  ) {
    res.writeHead(refusal[0], { 'content-type': 'application/json', ...(refusal[2] ?? {}) })
    return res.end(JSON.stringify(refusal[1]))
  }

  // Ключевой профиль без ключа СВОЕГО имени отвечает как несуществующий —
  // ровно так ведёт себя `agents` (`visibleProfile` подменяет номер на тот,
  // которого в базе нет). Это общая ветвь на все пути профиля, а не на
  // отдельные: ручка, забывшая проброс ключа, обязана краснеть независимо от
  // того, какая она (блокирующая находка `reviewer`: `POST /api/session`
  // проброс потеряла, а стенд спрашивал ключ только у путей, которые её
  // тест не задевал).
  const keyedPath =
    path.startsWith(`/v1/profiles/${KEYED_PID}`) ||
    (profileOf === KEYED_PID && path.startsWith('/v1/sessions/'))
  if (keyedPath && req.headers['x-model-key'] !== 'mika') {
    return json(404, { ok: false, code: 'unknown_profile' })
  }

  // --- профили ---
  if (path === '/v1/profiles' && req.method === 'GET') {
    // `keyName` в строках списка — как у `liveProfiles` сервиса: имя у
    // ключевого профиля, `null` у открытого. Ключевая строка приходит только
    // предъявившему ключ её имени, поэтому с ключом список длиннее.
    const keyed = { id: KEYED_PID, name: 'Мика по ключу', lastSeenAt: 1100, createdAt: 1, sessions: 1, keyName: 'mika' }
    const open = [
      { id: PID, name: 'Мика', lastSeenAt: 1000, createdAt: 1, sessions: 2, keyName: null },
      { id: EMPTY_PID, name: 'Гость', lastSeenAt: 900, createdAt: 1, sessions: 0, keyName: null },
    ]
    return json(200, {
      ok: true,
      cap: 5,
      profiles: req.headers['x-model-key'] === 'mika' ? [keyed, ...open] : open,
    })
  }
  if (path === '/v1/profiles' && req.method === 'POST') {
    const { name } = JSON.parse(body)
    if (name === 'шестой')
      return json(409, { ok: false, code: 'profiles_full', message: 'Мест нет: профилей не больше 5' })
    if (!name)
      return json(400, { ok: false, code: 'bad_input', message: 'Имя профиля не может быть пустым' })
    return json(200, { ok: true, profile: { id: NEW_SID, name } })
  }
  const profile = path.match(/^\/v1\/profiles\/([^/]+)$/)
  if (profile) {
    const id = profile[1]
    if (id === GONE_PID) return json(404, { ok: false, code: 'unknown_profile' })
    if (req.method === 'DELETE') return json(200, { ok: true, removed: { profiles: 1, sessions: 2 } })
    return json(200, profileBody(id, id === EMPTY_PID ? [] : LIVE))
  }
  const settings = path.match(/^\/v1\/profiles\/([^/]+)\/settings$/)
  if (settings && req.method === 'PUT') {
    const sent = JSON.parse(body)
    if (sent.maxTokens > 2048)
      return json(400, { ok: false, code: 'bad_input', message: 'Лимит токенов: целое от 1 до 2048' })
    return json(200, { ok: true, settings: sent })
  }
  const sessions = path.match(/^\/v1\/profiles\/([^/]+)\/sessions$/)
  if (sessions) {
    if (req.method === 'GET') return json(200, { ok: true, cap: 20, sessions: LIVE })
    if (sessions[1] === FULL_PID)
      return json(409, {
        ok: false,
        code: 'sessions_full',
        message: 'Диалогов не больше 20: закройте лишние',
      })
    return json(200, { ok: true, sessionId: NEW_SID, topicId: JSON.parse(body).topicId })
  }
  const topicFacts = path.match(/^\/v1\/profiles\/([^/]+)\/topics\/(\d+)$/)
  if (topicFacts) {
    return json(200, {
      ok: true,
      topic: {
        id: Number(topicFacts[2]),
        title: 'fintech',
        facts: [{ text: 'Ather Energy — раунд D', at: '2026-09-16T14:05:00.000Z', sourceSessionId: SID }],
      },
    })
  }

  // --- диалоги ---
  if (path === '/v1/runs') {
    const input = JSON.parse(body).input
    if (!input.prompt)
      return json(400, { ok: false, code: 'bad_input', message: 'Напишите сообщение' })
    const list = stored.get(input.sessionId) ?? []
    list.push({ role: 'user', text: input.prompt, meta: {} })
    stored.set(input.sessionId, list)
    const suffix = input.prompt === 'без денег' ? '7' : '1'
    return json(202, { ok: true, runId: `00000000-0000-4000-8000-00000000000${suffix}` })
  }
  const events = path.match(/^\/v1\/runs\/([^/]+)\/events$/)
  if (events) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`id: 1\nevent: event\ndata: ${JSON.stringify({ seq: 1, stage: 'received' })}\n\n`)
    const end = events[1].endsWith('7')
      ? { status: 'failed', error: { code: 'budget_too_small', message: 'мало', paidNothing: true } }
      : { status: 'succeeded', result: { answer: 'ответ', summary: { totalTokens: 100 } } }
    res.write(`event: end\ndata: ${JSON.stringify(end)}\n\n`)
    return res.end()
  }
  const topic = path.match(/^\/v1\/sessions\/([^/]+)\/topic$/)
  if (topic && req.method === 'POST') {
    const sent = JSON.parse(body)
    if (sent.decision === 'busy')
      return json(409, { ok: false, code: 'busy', message: 'Дождитесь ответа на предыдущее сообщение' })
    return json(200, { ok: true, topic: { id: 9, title: 'climate tech' }, factsWritten: 3, warnings: [] })
  }
  const session = path.match(/^\/v1\/sessions\/([^/]+)$/)
  if (session) {
    if (session[1] === ALIEN_SID || profileOf === GONE_PID)
      return json(404, { ok: false, code: 'unknown_session' })
    if (req.method === 'DELETE') {
      stored.delete(session[1])
      return json(200, { ok: true, removed: 2 })
    }
    return json(200, {
      ok: true,
      profileId: profileOf,
      topic: { id: 7, title: 'fintech' },
      pendingTopic: { title: 'Климатические стартапы Индии', facts: 3 },
      messages: stored.get(session[1]) ?? [],
      totalTokens: 4200,
      summary: null,
      facts: null,
      head: null,
      context: { total: 2560, summaryTokens: 560, freshTokens: 2000 },
    })
  }
  if (path === '/v1/agents') {
    return json(200, {
      ok: true,
      agents: [
        {
          id: 'layered-agent',
          name: 'Агент со слоями памяти',
          version: '1.0.0',
          purpose: 'назначение',
          systemPrompt: 'промпт',
          tools: [],
          models: [{ id: 'anthropic-haiku', label: 'Claude Haiku 4.5' }],
          presets: [],
          defaults: { model: 'anthropic-haiku', contextTokens: 3000, maxTokens: 1024 },
          limits: { maxTokens: 2048 },
        },
      ],
    })
  }
  // Срок хранения у агента намеренно не 30: страница обещает то число,
  // по которому переписка действительно удаляется.
  if (path === '/healthz') return json(200, { ok: true, sessionTtlHours: 42 })
  json(404, { ok: false })
})

await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key'
process.env.AGENT_URL = `http://127.0.0.1:${agent.address().port}`
process.env.COOKIE_PATH = '/'
process.env.COOKIE_SECURE = 'false'
// Окна широкие: у каждого теста свой адрес, а отдельные проверки лимитеров
// ниже упираются в предел намеренно.
process.env.MAX_DAILY_CALLS = '50'
process.env.RATE_LIMIT_PER_MIN = '4'
process.env.RATE_LIMIT_PER_HOUR = '50'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '5'

const { pending, server, sweepPending, sweepTimer } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => agent.close(resolve))
})

/** Все значения Set-Cookie ответа одной строкой: их в ответе бывает два. */
const setCookies = (response) => response.headers.getSetCookie().join(' | ')
const cookieValue = (response, name) => {
  const found = setCookies(response).match(new RegExp(`${name}=([0-9a-f-]*)`))
  return found ? found[1] : null
}

const call = (method, path, body, { ip = '10.0.0.1', cookie, modelKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
      ...(modelKey ? { 'x-model-key': modelKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const withProfile = (id = PID) => `day11_pid=${id}`
const withSession = (id = SID, pid = PID) => `day11_pid=${pid}; day11_sid=${id}`

test('/healthz отвечает и не раскрывает ключ', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.equal((await r.text()).includes('agent-key'), false)
})

test('экран входа получает все профили, потолок и профиль из cookie', async () => {
  const r = await call('GET', '/api/profiles', undefined, { ip: '10.1.0.1', cookie: withProfile() })
  const body = await r.json()
  assert.equal(body.profiles.length, 2)
  assert.equal(body.cap, 5)
  assert.equal(body.currentId, PID, 'профиль из cookie помечается «в прошлый раз»')
  // Чтение списка cookie не ставит: выбор — отдельное действие.
  assert.equal(r.headers.getSetCookie().length, 0)
})

test('создание профиля не ставит cookie: выбор — отдельное действие', async () => {
  const r = await call('POST', '/api/profile', { name: 'Мика' }, { ip: '10.1.0.2' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).profile.name, 'Мика')
  assert.equal(r.headers.getSetCookie().length, 0)
})

test('шестой профиль: 409 и слова агента, без предложения удалить чужой', async () => {
  const r = await call('POST', '/api/profile', { name: 'шестой' }, { ip: '10.1.0.3' })
  assert.equal(r.status, 409)
  const body = await r.json()
  assert.equal(body.code, 'profiles_full')
  assert.match(body.error, /Мест нет/)
  assert.equal(/удал/i.test(body.error), false, 'стереть чужое продукт не предлагает')
})

test('выбор профиля ставит cookie профиля и cookie последнего живого диалога', async () => {
  const r = await call('POST', '/api/profile/select', { id: PID }, { ip: '10.1.0.4' })
  assert.equal(r.status, 200)
  const cookies = setCookies(r)
  assert.match(cookies, /day11_pid=11111111/)
  assert.match(cookies, /HttpOnly/)
  assert.match(cookies, /SameSite=Lax/)
  assert.match(cookies, new RegExp(`day11_sid=${SID}`))
  assert.match(cookies, /Max-Age=2592000/, 'профиль живёт 30 дней')
  assert.match(cookies, /Max-Age=108000/, 'диалог живёт 30 часов')
  const body = await r.json()
  assert.equal(body.profile.name, 'Мика')
  assert.equal(body.profile.sessions[0].id, SID)
  assert.match(body.profile.sessions[0].name, /^[а-яё]+-[а-яё]+-\d{1,2}$/, 'имя диалога читаемо')
  assert.equal(body.profile.sessionCap, 20)
})

test('выбор профиля без живого диалога сессию не создаёт', async () => {
  const r = await call('POST', '/api/profile/select', { id: EMPTY_PID }, { ip: '10.1.0.5' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).sessionId, null)
  const cookies = setCookies(r)
  assert.match(cookies, /day11_pid=22222222/)
  assert.match(cookies, /day11_sid=; .*Max-Age=0/, 'cookie диалога стирается, а не выдумывается')
  // Ни одного обращения к созданию диалога: выбор профиля сессию не создаёт.
  assert.equal(agentLog.filter((c) => c.method === 'POST' && c.url.endsWith('/sessions')).length, 0)
})

test('выбор исчезнувшего профиля: 404 и оба указателя стираются', async () => {
  const r = await call('POST', '/api/profile/select', { id: GONE_PID }, {
    ip: '10.1.0.6',
    cookie: withSession(),
  })
  assert.equal(r.status, 404)
  assert.match(setCookies(r), /day11_pid=; .*Max-Age=0/)
  assert.match(setCookies(r), /day11_sid=; .*Max-Age=0/)
})

test('удаление своего профиля стирает cookie, удаление чужого — нет', async () => {
  const mine = await call('DELETE', '/api/profile', { id: PID }, {
    ip: '10.1.0.7',
    cookie: withSession(),
  })
  assert.equal(mine.status, 200)
  assert.match(setCookies(mine), /day11_pid=; .*Max-Age=0/)

  const other = await call('DELETE', '/api/profile', { id: EMPTY_PID }, {
    ip: '10.1.0.7',
    cookie: withProfile(),
  })
  assert.equal(other.status, 200)
  assert.equal(other.headers.getSetCookie().length, 0, 'свой указатель цел')
})

test('память профиля перечитывается чтением, а не выбором: вне окна записей', async () => {
  // Пять записей окно уже исчерпали бы — чтение профиля через него не идёт.
  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/profile', { name: `имя ${i}` }, { ip: '10.1.1.0' })
  }
  const r = await call('GET', '/api/profile', undefined, { ip: '10.1.1.0', cookie: withProfile() })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.profile.rules[0].key, 'тон')
  // У правила стоит имя диалога-источника, а не его идентификатор.
  assert.match(body.profile.rules[0].source, /^[а-яё]+-[а-яё]+-\d{1,2}$/)
  assert.equal(
    JSON.stringify(body.profile.rules).includes(SID),
    false,
    'идентификатора диалога в правилах нет',
  )
  assert.equal(body.profile.topics[0].title, 'fintech')
  assert.equal(body.profile.settings.maxTokens, 2000)
  assert.equal(r.headers.getSetCookie().length, 0, 'чтение указателей не трогает')
})

test('чтение исчезнувшего профиля: 404 и стёртые указатели', async () => {
  const r = await call('GET', '/api/profile', undefined, {
    ip: '10.1.1.1',
    cookie: withSession(SID, GONE_PID),
  })
  assert.equal(r.status, 404)
  assert.match(setCookies(r), /day11_pid=; .*Max-Age=0/)
})

test('настройки: отказ приходит словами агента и его кодом', async () => {
  const bad = await call('PUT', '/api/settings', { maxTokens: 4096 }, {
    ip: '10.1.0.8',
    cookie: withProfile(),
  })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /от 1 до 2048/)

  const ok = await call('PUT', '/api/settings', { maxTokens: 2000 }, {
    ip: '10.1.0.8',
    cookie: withProfile(),
  })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).settings.maxTokens, 2000)
})

test('ручки профиля без выбранного профиля отвечают 409, до агента не доходят', async () => {
  const calls = agentLog.length
  for (const [method, path] of [
    ['PUT', '/api/settings'],
    ['GET', '/api/sessions'],
    ['POST', '/api/session'],
    ['POST', '/api/session/topic'],
    ['POST', '/api/answer'],
  ]) {
    const r = await call(method, path, method === 'GET' ? undefined : { prompt: 'x' }, {
      ip: '10.1.0.9',
    })
    assert.equal(r.status, 409, `${method} ${path}`)
    assert.equal((await r.json()).code, 'no_profile')
  }
  assert.equal(agentLog.length, calls, 'без профиля к агенту не ходим')
})

test('новый диалог создаётся с темой и ставит cookie диалога', async () => {
  const r = await call('POST', '/api/session', { topicId: 7 }, {
    ip: '10.2.0.1',
    cookie: withProfile(),
  })
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(agentLog.at(-1).body).topicId, 7, 'тема уходит в создание диалога')
  assert.match(setCookies(r), new RegExp(`day11_sid=${NEW_SID}`))
})

test('двадцать первый диалог: 409 словами агента', async () => {
  const r = await call('POST', '/api/session', {}, { ip: '10.2.0.2', cookie: withProfile(FULL_PID) })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).code, 'sessions_full')
})

test('выбор чужого диалога: 404, cookie не меняется', async () => {
  const r = await call('POST', '/api/session/select', { id: ALIEN_SID }, {
    ip: '10.2.0.3',
    cookie: withProfile(),
  })
  assert.equal(r.status, 404)
  assert.equal(r.headers.getSetCookie().length, 0)
})

test('ответ о теме уходит с профилем из cookie; 409 busy доходит кодом', async () => {
  const ok = await call('POST', '/api/session/topic', { decision: 'open' }, {
    ip: '10.2.0.4',
    cookie: withSession(),
  })
  assert.equal(ok.status, 200)
  assert.match(agentLog.at(-1).url, new RegExp(`/v1/sessions/${SID}/topic\\?profile=${PID}`))
  assert.equal((await ok.json()).factsWritten, 3)

  const busy = await call('POST', '/api/session/topic', { decision: 'busy' }, {
    ip: '10.2.0.4',
    cookie: withSession(),
  })
  assert.equal(busy.status, 409)
  assert.equal((await busy.json()).code, 'busy')
})

test('факты темы приходят с датой и именем диалога, без идентификатора', async () => {
  const r = await call('GET', '/api/topic/7', undefined, { ip: '10.2.0.5', cookie: withProfile() })
  const body = await r.json()
  assert.equal(body.topic.facts[0].text, 'Ather Energy — раунд D')
  assert.match(body.topic.facts[0].source, /^[а-яё]+-[а-яё]+-\d{1,2}$/)
  assert.equal(JSON.stringify(body).includes(SID), false, 'идентификатора диалога в фактах нет')
})

test('первое сообщение создаёт диалог профиля и ставит cookie', async () => {
  const r = await call('POST', '/api/answer', { prompt: 'привет', topicId: 7 }, {
    ip: '10.3.0.1',
    cookie: withProfile(),
  })
  assert.equal(r.status, 202)
  assert.match(setCookies(r), new RegExp(`day11_sid=${NEW_SID}`))
  const sent = JSON.parse(agentLog.at(-1).body)
  assert.equal(sent.agent, 'layered-agent')
  assert.equal(sent.input.profileId, PID, 'профиль добавляет сервер')
  assert.equal(sent.input.sessionId, NEW_SID)
  assert.equal('topicId' in sent.input, false, 'тема ушла в создание диалога, а не во вход запуска')
  assert.equal(agentLog.at(-1).auth, 'Bearer agent-key')
})

test('потолок диалогов держит и первое сообщение: запуска нет, слот возвращён', async () => {
  const before = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  const calls = agentLog.filter((c) => c.url === '/v1/runs').length
  const r = await call('POST', '/api/answer', { prompt: 'привет' }, {
    ip: '10.3.0.2',
    cookie: withProfile(FULL_PID),
  })
  assert.equal(r.status, 409)
  assert.equal(agentLog.filter((c) => c.url === '/v1/runs').length, calls, 'запуска не было')
  assert.equal((await (await fetch(`${base}/healthz`)).json()).limiter.callsToday, before)
})

test('лимитер запусков стоит до агента: отказ не доходит до сервиса', async () => {
  const calls = agentLog.length
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/answer', { prompt: 'раз' }, {
      ip: '10.3.0.3',
      cookie: withSession(),
    })
    assert.equal(r.status, 202)
  }
  const refused = await call('POST', '/api/answer', { prompt: 'пятый' }, {
    ip: '10.3.0.3',
    cookie: withSession(),
  })
  assert.equal(refused.status, 429)
  assert.match((await refused.json()).error, /Слишком часто/)
  assert.equal(agentLog.length, calls + 4, 'пятый запрос до агента не дошёл')
})

test('записи профиля сидят под своим окном лимитера и до агента не доходят', async () => {
  const calls = agentLog.length
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/profile', { name: `имя ${i}` }, { ip: '10.4.0.1' })
    assert.equal(r.status, 200)
  }
  const refused = await call('POST', '/api/profile', { name: 'шестой по счёту' }, {
    ip: '10.4.0.1',
  })
  assert.equal(refused.status, 429)
  assert.match((await refused.json()).error, /изменений профилей за час/)
  assert.equal(agentLog.length, calls + 5, 'отказ лимитера до агента не дошёл')

  // Удаление — тоже запись: то же окно, тот же отказ.
  const removal = await call('DELETE', '/api/profile', { id: PID }, { ip: '10.4.0.1' })
  assert.equal(removal.status, 429)
  assert.equal(agentLog.length, calls + 5)
})

test('окно записей не трогает окно запусков и чтения', async () => {
  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/profile', { name: `имя ${i}` }, { ip: '10.4.0.2' })
  }
  const read = await call('GET', '/api/profiles', undefined, { ip: '10.4.0.2' })
  assert.equal(read.status, 200, 'чтения вне лимитера')
  const run = await call('POST', '/api/answer', { prompt: 'вопрос' }, {
    ip: '10.4.0.2',
    cookie: withSession(),
  })
  assert.equal(run.status, 202, 'окно запусков своё')
})

test('переписка читается с профилем в запросе и несёт тему и предложение', async () => {
  const r = await call('GET', '/api/chat?strategy=summary&model=anthropic-haiku&lol=1', undefined, {
    ip: '10.5.0.1',
    cookie: withSession(),
  })
  const asked = agentLog.at(-1).url
  assert.match(asked, new RegExp(`profile=${PID}`))
  assert.match(asked, /strategy=summary/)
  assert.equal(asked.includes('lol'), false, 'список параметров закрытый')
  const body = await r.json()
  assert.equal(body.topic.title, 'fintech')
  assert.equal(body.pendingTopic.facts, 3)
  assert.equal(body.totalTokens, 4200)
  assert.match(body.session.name, /^[а-яё]+-[а-яё]+-\d{1,2}$/)
})

test('без выбранного диалога переписка пуста, а не ошибочна', async () => {
  const calls = agentLog.length
  const r = await call('GET', '/api/chat', undefined, { ip: '10.5.0.2', cookie: withProfile() })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.deepEqual(body.messages, [])
  assert.equal(body.session, null)
  assert.equal(agentLog.length, calls, 'спрашивать нечего — к агенту не ходим')
})

test('очистка удаляет диалог и стирает cookie, нового диалога не заводит', async () => {
  const r = await call('DELETE', '/api/chat', undefined, { ip: '10.5.0.3', cookie: withSession() })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.cleared, true)
  assert.equal(body.session, null, 'новая сессия не выдумывается')
  assert.match(setCookies(r), /day11_sid=; .*Max-Age=0/)
  assert.match(agentLog.at(-1).url, new RegExp(`profile=${PID}`))
})

test('исчезнувший по сроку диалог: пустой лог и стёртый указатель, а не чужая переписка', async () => {
  const r = await call('GET', '/api/chat', undefined, {
    ip: '10.5.0.4',
    cookie: withSession(ALIEN_SID),
  })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.expired, true)
  assert.deepEqual(body.messages, [])
  assert.match(setCookies(r), /day11_sid=; .*Max-Age=0/)
})

// Поток событий теперь привязан к адресу создателя запуска (ADR
// 2026-10-07-1349, п. 4, Б6), поэтому адрес здесь предъявляется тот же, что
// у `/api/answer`. До этого ADR у потока не было никакой авторизации, и
// запрос без адреса проходил — потому эта проверка и правится.
test('поток событий проксируется как есть — с адреса, создавшего запуск', async () => {
  const { runId } = await (
    await call('POST', '/api/answer', { prompt: 'вопрос' }, {
      ip: '10.6.0.1',
      cookie: withSession(),
    })
  ).json()
  const r = await call('GET', `/api/runs/${runId}/events`, undefined, { ip: '10.6.0.1' })
  assert.equal(r.status, 200)
  assert.match(await r.text(), /event: end\ndata: \{"status":"succeeded"/)
})

test('состояние несёт оба срока и не раскрывает ключ', async () => {
  const r = await fetch(`${base}/api/state`)
  const s = await r.json()
  assert.equal(s.session.ttlHours, 42, 'часы берутся у того, кто удаляет переписку')
  assert.equal(s.profile.ttlDays, 30)
  assert.equal(s.limits.maxTokens, 2048, 'потолок ответа — потолок класса дня 11')
  assert.deepEqual(s.agent.tools, [], 'инструментов у агента нет')
  assert.equal(JSON.stringify(s).includes('agent-key'), false)
})

test('агент недоступен: 502 на запрос, 503 на состояние, 502 на список профилей', async () => {
  agentMode = 'down'
  const before = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  const run = await call('POST', '/api/answer', { prompt: 'вопрос' }, {
    ip: '10.7.0.1',
    cookie: withSession(),
  })
  assert.equal(run.status, 502)
  assert.equal(
    (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday,
    before,
    'слот возвращён: денег не потратили',
  )
  assert.equal((await fetch(`${base}/api/state`)).status, 503)
  assert.equal((await call('GET', '/api/profiles', undefined, { ip: '10.7.0.1' })).status, 502)
  agentMode = 'ok'
})

test('подделанная cookie не принимается: профиль считается невыбранным', async () => {
  const r = await call('GET', '/api/sessions', undefined, {
    ip: '10.8.0.1',
    cookie: 'day11_pid=../../etc/passwd',
  })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).code, 'no_profile')
})

// --- Ключ модели и привязка потока (ADR 2026-10-07-1349, п. 4) -------------
// Б5: до стенда доходит РОВНО `x-model-key` и ни один другой заголовок
// клиента. Б6, Б10, Б11: поток событий отдаётся только адресу, создавшему
// запуск; запись переживает закрытие соединения и `end`; срок держат проверка
// на чтении и таймер; слот лимитера разбирается ровно один раз.

const MODEL_KEY = 'K'.repeat(32)

test('до стенда доходит ровно x-model-key и ни один другой заголовок клиента (Б5)', async () => {
  const before = agentLog.length
  const r = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '10.9.0.1',
      cookie: withSession(),
      'x-model-key': MODEL_KEY,
      // Заголовки, которых у стенда быть не должно: день собирает заголовки
      // сам, клиентских не пропускает, и `...req.headers` ему запрещён.
      authorization: 'Bearer FORGED',
      'x-eval-key': 'someone-elses-key',
      'x-forwarded-host': 'evil.example',
    },
    body: JSON.stringify({ prompt: 'вопрос' }),
  })
  assert.equal(r.status, 202)

  const runCall = agentLog.slice(before).find((c) => c.url === '/v1/runs')
  assert.notEqual(runCall, undefined, 'запуск до стенда дошёл')
  assert.equal(runCall.modelKey, MODEL_KEY, 'ключ модели проброшен')
  // Ключ сервиса — СВОЙ, из окружения дня, а не присланный клиентом.
  assert.equal(runCall.auth, 'Bearer agent-key')
  assert.equal(runCall.evalKey, undefined, 'чужой x-eval-key до стенда не дошёл')
  assert.equal(runCall.forwardedHost, undefined, 'x-forwarded-host не дошёл')
  assert.equal(runCall.cookie, undefined, 'cookie посетителя не дошла')
})

test('негодная форма ключа — 403, и до стенда запрос не идёт', async () => {
  const before = agentLog.length
  const r = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '10.9.0.2',
      cookie: withSession(),
      // Пробел вне [A-Za-z0-9_-]: значение не могло прийти от нашего экрана.
      // Только ASCII: заголовок HTTP не принимает ничего вне ByteString, и
      // кириллица уронила бы сам `fetch` в тесте, ничего не проверив.
      'x-model-key': 'key with space',
    },
    body: JSON.stringify({ prompt: 'вопрос' }),
  })
  assert.equal(r.status, 403)
  const body = await r.json()
  assert.equal(body.code, 'bad_model_key')
  // Значение не попало в ответ: ни в сообщение, ни в код.
  assert.equal(JSON.stringify(body).includes('key with space'), false)
  assert.deepEqual(agentLog.slice(before), [], 'стенд не вызван')
})

/** Запуск с заданного адреса: отдаёт `runId`, которым открывается поток. */
const startRun = async (ip, prompt = 'вопрос') =>
  (await call('POST', '/api/answer', { prompt }, { ip, cookie: withSession() })).json()

test('поток событий с чужого адреса — 404, и стенд не вызван (Б6)', async () => {
  const { runId } = await startRun('10.10.0.1')
  const before = agentLog.length

  const alien = await call('GET', `/api/runs/${runId}/events`, undefined, { ip: '10.10.0.99' })
  assert.equal(alien.status, 404)
  assert.equal((await alien.json()).error, 'Запуск не найден')
  assert.deepEqual(agentLog.slice(before), [], 'до стенда чужой запрос не дошёл')

  // Контрольная ветвь: с адреса-создателя тот же запуск отдаётся.
  const mine = await call('GET', `/api/runs/${runId}/events`, undefined, { ip: '10.10.0.1' })
  assert.equal(mine.status, 200)
  await mine.text()
})

test('переподключение с того же адреса после закрытия и после end — 200 (Б10)', async () => {
  const { runId } = await startRun('10.11.0.1')

  // Первое чтение доводится до конца: в нём приходит `end`.
  const first = await call('GET', `/api/runs/${runId}/events`, undefined, { ip: '10.11.0.1' })
  assert.equal(first.status, 200)
  assert.match(await first.text(), /event: end/)

  // Переподключение ПОСЛЕ `end` — именно то, что делает EventSource при
  // обрыве сети. Со стиранием записи на `close` или на `end` здесь был бы 404.
  for (const attempt of [1, 2]) {
    const again = await call('GET', `/api/runs/${runId}/events`, undefined, { ip: '10.11.0.1' })
    assert.equal(again.status, 200, `переподключение ${attempt}`)
    await again.text()
  }
  // Запись на месте, и отметка от `end` стоит.
  assert.equal(pending.has(runId), true)
  assert.equal(pending.get(runId).ended, true)

  // А с чужого адреса переподключение по-прежнему 404.
  assert.equal(
    (await call('GET', `/api/runs/${runId}/events`, undefined, { ip: '10.11.0.77' })).status,
    404,
  )
})

test('слот лимитера при paidNothing возвращается ровно один раз (Б10)', async () => {
  const ip = '10.12.0.1'
  const used = async () => (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  // «без денег» — стенд отвечает запуском, который кончается paidNothing.
  const { runId } = await startRun(ip, 'без денег')
  const afterStart = await used()

  const read = async () => {
    const r = await call('GET', `/api/runs/${runId}/events`, undefined, { ip })
    assert.equal(r.status, 200)
    await r.text()
  }
  await read()
  const afterFirst = await used()
  assert.equal(afterFirst, afterStart - 1, 'слот вернулся: денег не потратили')

  // Второе и третье чтение того же потока слот больше не возвращают: иначе
  // каждое перечитывание дарило бы адресу лишний запуск суточного потолка.
  await read()
  await read()
  assert.equal(await used(), afterFirst, 'возврат слота не повторяется')
})

test('по истечении срока — 404 всем, и записи в pending больше нет (Б11)', async () => {
  const { runId } = await startRun('10.13.0.1')
  assert.equal(pending.has(runId), true)

  // Отметка сдвигается в прошлое: `now - at` — та же величина, что при ходе
  // часов вперёд, и проверка на чтении смотрит именно на неё. Часы процесса
  // при этом не трогаются, и соседние тесты от этого не зависят.
  pending.get(runId).at -= 11 * 60_000
  const before = agentLog.length

  const late = await call('GET', `/api/runs/${runId}/events`, undefined, { ip: '10.13.0.1' })
  assert.equal(late.status, 404, 'даже адресу-создателю — 404')
  assert.deepEqual(agentLog.slice(before), [], 'стенд не вызван')
  assert.equal(pending.has(runId), false, 'запись снята на месте, на чтении')
})

test('запись запуска, поток которого не открывали, исчезает по таймеру (Б11)', async () => {
  const { runId } = await startRun('10.14.0.1')
  assert.equal(pending.has(runId), true)

  // Поток не открывается вовсе: до проверки на чтении дело не доходит, и
  // снять запись может только таймер.
  pending.get(runId).at -= 11 * 60_000
  // Зовётся та же функция, что стоит в `setInterval`.
  assert.equal(sweepPending() >= 1, true, 'уборка сняла хотя бы эту запись')
  assert.equal(pending.has(runId), false)

  // Таймер есть и не держит событийный цикл. ЧЕСТНАЯ ГРАНИЦА: что он
  // срабатывает сам раз в минуту, здесь не проверяется — см. комментарий у
  // экспорта в `server.js`.
  assert.notEqual(sweepTimer, undefined, 'таймер уборки существует')
  assert.equal(sweepTimer.hasRef(), false, 'таймер не держит процесс')

  // Свежая запись уборкой не задета — иначе зелёный результат выше
  // удовлетворяла бы гипотеза «уборка стирает всё подряд».
  const fresh = await startRun('10.14.0.2')
  sweepPending()
  assert.equal(pending.has(fresh.runId), true)
})

// --- Остальная ветвь запусков недостижима (Б7) ----------------------------

test('кроме /events, ветвь /api/runs/* не проксируется: 404 и стенд не вызван (Б7)', async () => {
  const { runId } = await startRun('10.15.0.1')
  const before = agentLog.length

  for (const [method, path] of [
    ['GET', `/api/runs/${runId}`],
    ['GET', `/api/runs/${runId}/log.csv`],
    ['GET', `/api/runs/${runId}/prompts`],
    ['POST', `/api/runs/${runId}/pause`],
  ]) {
    const r = await call(method, path, method === 'POST' ? {} : undefined, { ip: '10.15.0.1' })
    assert.equal(r.status, 404, `${method} ${path}`)
  }
  assert.deepEqual(agentLog.slice(before), [], 'ни один из них до стенда не дошёл')
})

// --- Отказы ключа доходят до страницы своим кодом --------------------------

test('403 bad_model_key от сервиса — 403 с кодом, а не 502 «агент не ответил»', async () => {
  // Форма ключа годная, значение — нет: сверяет его сервис, и его отказ
  // должен дойти до экрана. Прежде этот ответ становился 502, и экран просил
  // проверить связь — действие, которое ключ не исправляет.
  const before = agentLog.length
  const r = await call('GET', '/api/profiles', undefined, { ip: '10.20.0.1', modelKey: 'wrong' })
  assert.equal(r.status, 403)
  const body = await r.json()
  assert.equal(body.code, 'bad_model_key')
  assert.equal(body.error, 'Ключ модели не принят')
  // Отказ пришёл ОТ СТЕНДА, а не от собственной проверки формы в дне: иначе
  // тот же зелёный результат удовлетворяла бы гипотеза «день отверг форму»,
  // а форма у `wrong` годная. Улика — запись в журнале стенда, не код ответа.
  const seen = agentLog.slice(before)
  assert.equal(seen.length, 1, 'запрос до стенда не дошёл')
  assert.equal(seen[0].url, '/v1/profiles')
  assert.equal(seen[0].modelKey, 'wrong', 'стенд получил ровно предъявленное значение')
})

test('429 окна отказов доходит кодом и тем же retry-after, что назвал сервис', async () => {
  const r = await call('GET', '/api/profile', undefined, {
    ip: '10.20.0.2',
    cookie: withProfile(),
    modelKey: 'burst',
  })
  assert.equal(r.status, 429)
  assert.equal(r.headers.get('retry-after'), '37', 'число окна — сервиса, а не дня')
  assert.equal((await r.json()).code, 'too_many_attempts')
})

test('429 суточного потолка доходит кодом и временем сброса', async () => {
  const r = await call('POST', '/api/answer', { prompt: 'привет' }, {
    ip: '10.20.0.3',
    cookie: withSession(),
    modelKey: 'over',
  })
  assert.equal(r.status, 429)
  const body = await r.json()
  assert.equal(body.code, 'model_key_daily_cap')
  assert.equal(body.resetAt, '2026-10-09T00:00:00.000Z', 'страница называет время сброса')
})

test('403 границы ключевого профиля доходит кодом с запуска', async () => {
  const r = await call('POST', '/api/answer', { prompt: 'привет' }, {
    ip: '10.20.0.4',
    cookie: withSession(),
    modelKey: 'wrongmodel',
  })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).code, 'keyed_profile_model')
})

test('имя ключа профиля доходит до страницы чтением и выбором; у открытого — null', async () => {
  const read = await call('GET', '/api/profile', undefined, {
    ip: '10.20.0.5',
    cookie: withProfile(KEYED_PID),
    modelKey: 'mika',
  })
  assert.equal(read.status, 200)
  assert.equal((await read.json()).profile.keyName, 'mika')

  const picked = await call('POST', '/api/profile/select', { id: KEYED_PID }, {
    ip: '10.20.0.5',
    modelKey: 'mika',
  })
  assert.equal(picked.status, 200)
  assert.equal((await picked.json()).profile.keyName, 'mika')

  // Открытый профиль различим от ключевого: иначе зелёный результат выше
  // удовлетворяла бы гипотеза «поле всегда непусто».
  const open = await call('GET', '/api/profile', undefined, {
    ip: '10.20.0.5',
    cookie: withProfile(PID),
  })
  assert.equal((await open.json()).profile.keyName, null)
})

// --- Ключ не попадает в браузерные хранилища (решение владельца 7) --------

test('страница не кладёт ключ ни в localStorage, ни в sessionStorage, ни в cookie', async () => {
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  // Проверяется исполняемый текст, а не комментарии и не разметку: в
  // комментариях эти имена названы нарочно — там сказано, почему их нет в
  // коде. Блочные комментарии и строки-комментарии снимаются, HTML-комментарии
  // снимаются тоже.
  const code = page
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // Хранилищ в дне 11 нет вовсе: указатели профиля и диалога ставит сервер
  // своими cookie, а страница их не читает. Поэтому проверка — на отсутствие
  // самих обращений, а не на отсутствие ключа рядом с ними: вторая форма
  // зеленела бы от переименования переменной.
  for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.equal(code.includes(store), false, `страница обращается к ${store}`)
  }

  // Поле ключа существует, закрыто и БЕЗ атрибута name: без name значение не
  // попадает в адрес страницы даже при сбое обработчика отправки. Без этих
  // двух проверок всё выше зеленело бы на странице, где ключа нет вообще.
  const field = page.match(/<input id="model-key"[^>]*>/)
  assert.ok(field, 'поля ключа на странице нет')
  assert.match(field[0], /type="password"/)
  assert.equal(/\sname=/.test(field[0]), false, 'у поля ключа есть name — значение уедет в адрес')
})

// --- Ключевой профиль различим в списке входа -----------------------------

test('список входа несёт имя ключа, и страница метит такие профили', async () => {
  // Сервер: имя ключа доезжает до страницы в каждой строке списка. Без него
  // пометку рисовать нечем, и список читался бы как «все открыты».
  const keyed = await call('GET', '/api/profiles', undefined, {
    ip: '10.21.0.1',
    modelKey: 'mika',
  })
  assert.equal(keyed.status, 200)
  const rows = (await keyed.json()).profiles
  assert.deepEqual(
    rows.map((p) => [p.name, p.keyName]),
    [['Мика по ключу', 'mika'], ['Мика', null], ['Гость', null]],
    'ключевой профиль назван именем ключа, открытые — null',
  )

  // Без ключа ключевой строки в списке нет вовсе: иначе зелёный результат
  // выше удовлетворяла бы гипотеза «список всегда одинаков».
  const open = await call('GET', '/api/profiles', undefined, { ip: '10.21.0.1' })
  assert.deepEqual(
    (await open.json()).profiles.map((p) => [p.name, p.keyName]),
    [['Мика', null], ['Гость', null]],
  )

  // Страница: подпись в строке списка строится из `p.keyName`, и это
  // исполняемый код, а не комментарий — комментарии и разметка сняты.
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  const code = page
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.match(
    code,
    /if \(p\.keyName\) \{[\s\S]{0,200}?chip\.textContent = 'по ключу'/,
    'подпись «по ключу» в строке списка не строится из p.keyName',
  )
  // И строка состояния ключа больше не признаётся, что не различает их.
  assert.equal(code.includes('список не различает'), false)
})

// --- Проброс ключа на КАЖДОЙ ручке профиля --------------------------------
// Блокирующая находка `reviewer` к PR #334: `POST /api/session` был
// единственным из четырнадцати обработчиков без проброса `x-model-key`, и в
// ключевом профиле «новый диалог» отвечал «профиль не найден». Прежние тесты
// этого не держали: они проверяли проброс на тех ручках, которые трогали, а
// счёт ручек стоял только в комментарии.
//
// Эта проверка перебирает ВСЕ ручки профиля и утверждает об одном: что бы
// ручка ни делала, каждый её запрос к сервису уходит с ключом. Пропущенная
// ручка краснеет здесь независимо от того, какая она.

/** Ручка профиля: метод, путь, тело и свой адрес — окна лимитера узкие. */
const PROFILE_ROUTES = [
  ['GET', '/api/profiles', undefined, '10.30.0.1'],
  ['GET', '/api/profile', undefined, '10.30.0.2'],
  ['POST', '/api/profile', { name: 'по ключу' }, '10.30.0.3'],
  ['POST', '/api/profile/select', { id: KEYED_PID }, '10.30.0.4'],
  ['PUT', '/api/settings', { maxTokens: 1500 }, '10.30.0.5'],
  ['GET', '/api/sessions', undefined, '10.30.0.6'],
  ['POST', '/api/session', { topicId: null }, '10.30.0.7'],
  ['POST', '/api/session/select', { id: SID }, '10.30.0.8'],
  ['POST', '/api/session/topic', { topicId: 7 }, '10.30.0.9'],
  ['GET', '/api/topic/7', undefined, '10.30.0.10'],
  ['GET', '/api/chat', undefined, '10.30.0.11'],
  ['PUT', '/api/chat/head', { messageId: 3 }, '10.30.0.12'],
  ['POST', '/api/answer', { prompt: 'вопрос' }, '10.30.0.13'],
  ['DELETE', '/api/chat', undefined, '10.30.0.14'],
  ['DELETE', '/api/profile', { id: KEYED_PID }, '10.30.0.15'],
]

test('каждая ручка профиля уносит x-model-key до сервиса — все четырнадцать', async () => {
  for (const [method, path, body, ip] of PROFILE_ROUTES) {
    const before = agentLog.length
    const response = await call(method, path, body, {
      ip,
      cookie: withSession(SID, KEYED_PID),
      modelKey: 'mika',
    })
    const seen = agentLog.slice(before)
    assert.ok(seen.length > 0, `${method} ${path}: до сервиса вообще не дошло`)
    for (const callToAgent of seen) {
      assert.equal(
        callToAgent.modelKey,
        'mika',
        `${method} ${path}: запрос ${callToAgent.method} ${callToAgent.url} ушёл БЕЗ ключа`,
      )
    }
    // И ответ не «профиль не найден»: стенд ведёт себя как agents, то есть
    // ключевой профиль без ключа отвечает как несуществующий. Без проброса
    // любая из этих ручек вернула бы именно это.
    const json = await response.json().catch(() => null)
    assert.notEqual(
      json?.code,
      'unknown_profile',
      `${method} ${path}: ключевой профиль ответил как несуществующий`,
    )
  }
})

test('POST /api/session в ключевом профиле создаёт диалог, а не 404 (находка reviewer)', async () => {
  const before = agentLog.length
  const r = await call('POST', '/api/session', { topicId: null }, {
    ip: '10.31.0.1',
    cookie: withProfile(KEYED_PID),
    modelKey: 'mika',
  })
  assert.equal(r.status, 200, 'диалог создан')
  const body = await r.json()
  assert.equal(body.sessionId, NEW_SID)
  assert.match(setCookies(r), new RegExp(`day11_sid=${NEW_SID}`), 'cookie диалога поставлена')

  const made = agentLog.slice(before).find((c) => c.method === 'POST' && c.url.endsWith('/sessions'))
  assert.notEqual(made, undefined, 'создание диалога дошло до сервиса')
  assert.equal(made.modelKey, 'mika', 'и дошло с ключом')
})

test('негодная форма ключа — 403 на каждой ручке профиля, и до сервиса не доходит', async () => {
  // Форму проверяет сам день (`modelKey`), и теперь это делает общий
  // помощник: пропустить ручку нельзя. Пробел вне [A-Za-z0-9_-].
  for (const [method, path, body, ip] of PROFILE_ROUTES) {
    const before = agentLog.length
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `10.32.${ip.split('.')[3]}.1`,
        cookie: withSession(SID, KEYED_PID),
        'x-model-key': 'key with space',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(r.status, 403, `${method} ${path}`)
    assert.equal((await r.json()).code, 'bad_model_key', `${method} ${path}`)
    assert.deepEqual(agentLog.slice(before), [], `${method} ${path}: стенд не вызван`)
  }
})

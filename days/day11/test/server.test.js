// Интеграционный тест дня: настоящий сервер дня против поддельного сервиса
// агентов. Проверяется связка — две cookie, оба окна лимитера, ручки профиля
// и его диалогов, создание диалога первым сообщением, прокси потока.

import assert from 'node:assert/strict'
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

const profileBody = (id, sessions) => ({
  ok: true,
  profile: {
    id,
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
  agentLog.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
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

  // --- профили ---
  if (path === '/v1/profiles' && req.method === 'GET') {
    return json(200, {
      ok: true,
      cap: 5,
      profiles: [
        { id: PID, name: 'Мика', lastSeenAt: 1000, createdAt: 1, sessions: 2 },
        { id: EMPTY_PID, name: 'Гость', lastSeenAt: 900, createdAt: 1, sessions: 0 },
      ],
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

const { server } = await import('../server.js')
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

const call = (method, path, body, { ip = '10.0.0.1', cookie } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
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

test('поток событий проксируется как есть', async () => {
  const { runId } = await (
    await call('POST', '/api/answer', { prompt: 'вопрос' }, {
      ip: '10.6.0.1',
      cookie: withSession(),
    })
  ).json()
  const r = await fetch(`${base}/api/runs/${runId}/events`)
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

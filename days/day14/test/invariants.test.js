// День 14: три ручки инвариантов против поддельного сервиса агентов
// (ADR 2026-09-22-0827, критерий 11). Проверяется то, за что отвечает день:
// слот лимитера до платного обращения, окно записей, cookie профиля и то,
// что карточек черновика нет в переписке. Ворота билета — дело сервиса, и
// проверены его собственным тестом.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const PID = '11111111-1111-4111-8111-111111111111'
const agentLog = []

/** Что ответит сервис на ход черновика: тест двигает это перед вызовом. */
let draftReply = { status: 200, body: { ok: true, draft: { verdict: 'ok', variants: [] } } }

const agent = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString()
  agentLog.push({ method: req.method, url: req.url, body })
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const [path] = req.url.split('?')

  if (path === `/v1/profiles/${PID}/invariants/draft` && req.method === 'POST') {
    return json(draftReply.status, draftReply.body)
  }
  if (path === `/v1/profiles/${PID}/invariants` && req.method === 'POST') {
    const parsed = JSON.parse(body)
    if (!parsed.ticket) return json(400, { ok: false, code: 'no_ticket', message: 'нет билета' })
    return json(200, { ok: true, invariant: { num: 3, text: parsed.text, createdAt: 1 } })
  }
  const num = path.match(new RegExp(`^/v1/profiles/${PID}/invariants/(\\d+)$`))
  if (num && req.method === 'DELETE') {
    if (num[1] === '9') return json(404, { ok: false, code: 'unknown_invariant' })
    return json(200, { ok: true, num: Number(num[1]) })
  }
  if (path === `/v1/profiles/${PID}` && req.method === 'GET') {
    return json(200, {
      ok: true,
      sessionCap: 20,
      profile: {
        id: PID,
        name: 'Мика',
        settings: {},
        stagedSettings: {},
        rules: [],
        invariants: [{ num: 1, text: 'Отвечай коротко', createdAt: 1 }],
        topics: [],
        sessions: [],
        lastSession: null,
      },
    })
  }
  if (path === '/healthz') return json(200, { ok: true })
  json(404, { ok: false })
})

await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key'
process.env.AGENT_URL = `http://127.0.0.1:${agent.address().port}`
process.env.COOKIE_PATH = '/'
process.env.COOKIE_SECURE = 'false'
process.env.MAX_DAILY_CALLS = '400'
process.env.RATE_LIMIT_PER_MIN = '2'
process.env.RATE_LIMIT_PER_HOUR = '12'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '40'

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

const withProfile = `day14_pid=${PID}`
const call = (method, path, body, { ip = '10.1.0.1', cookie = withProfile } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

test('ход черновика идёт под слотом запусков и доходит до сервиса', async () => {
  agentLog.length = 0
  draftReply = {
    status: 200,
    body: {
      ok: true,
      draft: {
        verdict: 'revise',
        remark: 'слишком общо',
        conflict: null,
        text: null,
        ticket: null,
        variants: [{ text: 'Отвечай не длиннее пяти предложений', ticket: 'a'.repeat(64) }],
      },
    },
  }
  const r = await call('POST', '/api/invariants/draft', { text: 'пиши покороче' }, { ip: '10.1.1.1' })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.draft.variants.length, 1)
  assert.equal(agentLog.at(-1).url, `/v1/profiles/${PID}/invariants/draft`)
})

test('без слота лимитера хода нет: 429 и вызова к сервису не было', async () => {
  const ip = '10.1.2.1'
  // Окно — два запуска в минуту: третий ход упирается в него.
  await call('POST', '/api/invariants/draft', { text: 'раз' }, { ip })
  await call('POST', '/api/invariants/draft', { text: 'два' }, { ip })
  agentLog.length = 0
  const r = await call('POST', '/api/invariants/draft', { text: 'три' }, { ip })
  assert.equal(r.status, 429)
  assert.deepEqual(agentLog, [], 'к сервису не ходили')
})

test('ход без профиля — 409, вызова нет', async () => {
  agentLog.length = 0
  const r = await call('POST', '/api/invariants/draft', { text: 'что-то' }, {
    ip: '10.1.3.1',
    cookie: '',
  })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).code, 'no_profile')
  assert.deepEqual(agentLog, [])
})

test('ответ без варианта доходит словами сервиса и назван оплаченным', async () => {
  draftReply = {
    status: 502,
    body: {
      ok: false,
      code: 'draft_no_variants',
      message: 'Формулировщик не дал варианта — отправьте ещё раз',
      paid: true,
    },
  }
  const r = await call('POST', '/api/invariants/draft', { text: 'пиши покороче' }, { ip: '10.1.4.1' })
  assert.equal(r.status, 502)
  const body = await r.json()
  assert.equal(body.code, 'draft_no_variants')
  assert.equal(body.paid, true)
})

test('приём идёт под окном записей и несёт билет', async () => {
  agentLog.length = 0
  const r = await call(
    'POST',
    '/api/invariants',
    { text: 'Отвечай не длиннее пяти предложений', ticket: 'b'.repeat(64) },
    { ip: '10.1.5.1' },
  )
  assert.equal(r.status, 200)
  assert.equal((await r.json()).invariant.num, 3)
  assert.equal(JSON.parse(agentLog.at(-1).body).ticket, 'b'.repeat(64))
})

test('приём без билета — 400 no_ticket словами сервиса', async () => {
  const r = await call('POST', '/api/invariants', { text: 'без билета' }, { ip: '10.1.6.1' })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).code, 'no_ticket')
})

test('удаление по номеру: 200 своего, 404 несуществующего', async () => {
  const ok = await call('DELETE', '/api/invariants/2', undefined, { ip: '10.1.7.1' })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).num, 2)

  const missing = await call('DELETE', '/api/invariants/9', undefined, { ip: '10.1.7.1' })
  assert.equal(missing.status, 404)
})

test('инварианты профиля приходят странице списком', async () => {
  const r = await call('GET', '/api/profile', undefined, { ip: '10.1.8.1' })
  const body = await r.json()
  assert.deepEqual(body.profile.invariants, [{ num: 1, text: 'Отвечай коротко', createdAt: 1 }])
})

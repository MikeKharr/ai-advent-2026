// Интеграционный тест дня 13 против поддельного сервиса агентов. Проверяется
// то, что день 13 добавил к дню 11, — по критериям приёмки ADR 2026-09-21-1747,
// п. 11: резерв слотов под круги проверки (16), пауза и возобновление (3, 5),
// состояние запуска в переписке (7), журнал этапов (9), этапы в `/api/state`.
// Устройство дня 11 (две cookie, окна лимитера, прокси потока) проверено его
// собственным тестом и здесь сверяется только на границах, которые день 13
// сдвинул.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const agentLog = []

const PID = '11111111-1111-4111-8111-111111111111'
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** Диалог чужого профиля: агент отвечает на него как на несуществующий. */
const ALIEN_SID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
/** Диалог без живого запуска: паузить нечего. */
const IDLE_SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
/** Диалог, чей запуск уже завершён на стороне агента: ручка паузы отдаёт 409. */
const DONE_SID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const RUN = '00000000-0000-4000-8000-000000000001'
const ALIEN_RUN = '00000000-0000-4000-8000-0000000000aa'

/** Сколько кругов назовёт `end` потока: тест этим двигает возврат слотов. */
let endRounds = 1
/** Прерван ли вызов у запуска: от этого зависит, берёт ли возобновление слот. */
let interruptedCall = false
const pauseCalls = []

const agent = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString()
  agentLog.push({ method: req.method, url: req.url, body })
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const [path, query = ''] = req.url.split('?')
  const params = new URLSearchParams(query)

  if (path === '/v1/runs' && req.method === 'POST') {
    return json(202, { ok: true, runId: RUN })
  }

  const pause = path.match(/^\/v1\/runs\/([^/]+)\/pause$/)
  if (pause && req.method === 'POST') {
    pauseCalls.push({ runId: pause[1], body: JSON.parse(body) })
    if (pause[1] === ALIEN_RUN) return json(404, { ok: false, code: 'unknown_run' })
    return json(200, { ok: true, paused: JSON.parse(body).paused })
  }

  const log = path.match(/^\/v1\/runs\/([^/]+)\/log\.csv$/)
  if (log) {
    if (log[1] === ALIEN_RUN) return json(404, { ok: false, code: 'unknown_run' })
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' })
    return res.end('run_id,state,outcome\n' + `${RUN},intake,done\n`)
  }

  const events = path.match(/^\/v1\/runs\/([^/]+)\/events$/)
  if (events) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: event\ndata: ${JSON.stringify({ seq: 1, stage: 'state' })}\n\n`)
    const end = {
      status: 'succeeded',
      result: { answer: 'ответ', summary: { totalTokens: 100, rounds: endRounds } },
    }
    res.write(`event: end\ndata: ${JSON.stringify(end)}\n\n`)
    return res.end()
  }

  const session = path.match(/^\/v1\/sessions\/([^/]+)$/)
  if (session) {
    const id = session[1]
    if (id === ALIEN_SID || params.get('profile') !== PID)
      return json(404, { ok: false, code: 'unknown_session' })
    const run =
      id === IDLE_SID
        ? null
        : id === DONE_SID
          ? { id: ALIEN_RUN, status: 'running', state: 'answer', paused: false, interruptedCall: false }
          : { id: RUN, status: 'running', state: 'answer', paused: false, interruptedCall, since: 1 }
    return json(200, {
      ok: true,
      messages: [],
      totalTokens: 0,
      summary: null,
      facts: null,
      head: null,
      context: null,
      topic: null,
      pendingTopic: null,
      run,
    })
  }

  if (path === '/v1/agents') {
    return json(200, {
      ok: true,
      agents: [
        {
          id: 'staged-agent',
          name: 'Агент с машиной состояний',
          version: '1.0.0',
          purpose: 'назначение',
          systemPrompt: 'промпт',
          tools: [],
          models: [{ id: 'anthropic-haiku', label: 'Claude Haiku 4.5' }],
          defaults: { model: 'anthropic-haiku', reviewModel: 'kimi-k2.6', reviewRounds: 2 },
          limits: { maxTokens: 2048, reviewRounds: { min: 1, max: 3, default: 2 } },
          stages: [
            { id: 'intake', title: 'Приём', prompt: null, rule: 'профиль жив' },
            { id: 'answer', title: 'Вызов модели', prompt: 'текст промпта', rule: null },
          ],
        },
      ],
    })
  }
  if (path === '/healthz') return json(200, { ok: true, sessionTtlHours: 30 })
  json(404, { ok: false })
})

await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key'
process.env.AGENT_URL = `http://127.0.0.1:${agent.address().port}`
process.env.COOKIE_PATH = '/'
process.env.COOKIE_SECURE = 'false'
// Окна широкие: у каждого теста свой адрес, а проверки резерва слотов ниже
// упираются в предел намеренно, своим адресом и своим числом.
process.env.MAX_DAILY_CALLS = '50'
process.env.RATE_LIMIT_PER_MIN = '4'
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

const withSession = (id = SID, pid = PID) => `day13_pid=${pid}; day13_sid=${id}`

/** Дождаться конца прокси потока: возврат слотов случается в нём, не в ответе. */
const drain = async (runId, cookie) => {
  const r = await fetch(`${base}/api/runs/${runId}/events`, { headers: { cookie } })
  await r.text()
}

/* ---------- cookie дня 13 ---------- */

test('cookie дня 13 свои: день 11 не затрагивается', async () => {
  const r = await call('GET', '/api/chat', undefined, { ip: '10.9.0.1', cookie: withSession() })
  assert.equal(r.status, 200)
  // Запрос ушёл с идентификатором из day13_sid, а не из day11_sid.
  assert.ok(agentLog.some((c) => c.url.startsWith(`/v1/sessions/${SID}`)))
})

/* ---------- критерий 7: состояние запуска в переписке ---------- */

test('переписка несёт живой запуск, а без диалога — null', async () => {
  const live = await call('GET', '/api/chat', undefined, { ip: '10.9.0.2', cookie: withSession() })
  const body = await live.json()
  assert.equal(body.run.id, RUN)
  assert.equal(body.run.state, 'answer')
  assert.equal(body.run.paused, false)

  const none = await call('GET', '/api/chat', undefined, { ip: '10.9.0.2', cookie: `day13_pid=${PID}` })
  assert.equal((await none.json()).run, null, 'диалога нет — запуска нет, а не выдуманный')
})

/* ---------- этапы и предел кругов в состоянии ---------- */

test('/api/state отдаёт шесть этапов агента и предел кругов', async () => {
  const r = await call('GET', '/api/state', undefined, { ip: '10.9.0.3' })
  const body = await r.json()
  assert.equal(body.stages[0].id, 'intake')
  assert.equal(body.stages[0].prompt, null, 'у этапа без вызова промпта нет')
  // Текст промпта страница берёт отсюда, а не из событий: в событиях текстов нет.
  assert.equal(body.stages[1].prompt, 'текст промпта')
  assert.deepEqual(body.limits.reviewRounds, { min: 1, max: 3, default: 2 })
  assert.equal((await (await call('GET', '/api/state', undefined, { ip: '10.9.0.3' })).text()).includes('agent-key'), false)
})

/* ---------- критерий 16: резерв слотов под круги ---------- */

test('сообщение резервирует reviewRounds слотов до запуска', async () => {
  const ip = '10.2.0.1'
  const cookie = withSession()
  // Минутное окно — четыре слота. Сообщение с тремя кругами занимает три:
  // столько платных ответов оно может стоить.
  const first = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 3 }, { ip, cookie })
  assert.equal(first.status, 202)
  assert.equal((await first.json()).reserved, 3, 'зарезервировано по слоту на круг')

  // Второго сообщения с тремя кругами окно не выдержит: 3 + 3 > 4. Отказ
  // случается ДО обращения к агенту — запуска нет вовсе (I-4).
  const before = agentLog.filter((c) => c.url === '/v1/runs').length
  const denied = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 3 }, { ip, cookie })
  assert.equal(denied.status, 429)
  assert.equal(
    agentLog.filter((c) => c.url === '/v1/runs').length,
    before,
    'при отказе лимитера запуска нет вовсе',
  )

  // А на один круг слот ещё есть: резерв считается слотами, а не сообщениями.
  const one = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 1 }, { ip, cookie })
  assert.equal(one.status, 202)
  assert.equal((await one.json()).reserved, 1)
})

test('предел кругов вне 1–3 приводится к границе, а не доверяется странице', async () => {
  const ip = '10.2.0.2'
  const r = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 99 }, {
    ip,
    cookie: withSession(),
  })
  assert.equal((await r.json()).reserved, 3, '99 кругов — это 3')

  const none = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 0 }, {
    ip: '10.2.0.3',
    cookie: withSession(),
  })
  assert.equal((await none.json()).reserved, 1)

  const missing = await call('POST', '/api/answer', { prompt: 'да' }, {
    ip: '10.2.0.4',
    cookie: withSession(),
  })
  assert.equal((await missing.json()).reserved, 2, 'умолчание — два круга')
})

test('при одном состоявшемся круге лишние слоты возвращаются по end', async () => {
  const ip = '10.3.0.1'
  endRounds = 1
  const cookie = withSession()
  const r = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 3 }, { ip, cookie })
  assert.equal(r.status, 202)
  await drain(RUN, cookie)

  // Три слота заняты, два вернулись — остался один. Минутное окно 4, значит
  // ещё три сообщения по одному кругу должны пройти.
  for (let i = 0; i < 3; i++) {
    const next = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 1 }, { ip, cookie })
    assert.equal(next.status, 202, `сообщение ${i + 2} после возврата слотов`)
  }
  const over = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 1 }, { ip, cookie })
  assert.equal(over.status, 429, 'возвращено ровно два слота, не больше')
})

test('состоявшиеся круги слотов не возвращают', async () => {
  const ip = '10.3.0.2'
  endRounds = 3
  const cookie = withSession()
  await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 3 }, { ip, cookie })
  await drain(RUN, cookie)
  const next = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 3 }, { ip, cookie })
  assert.equal(next.status, 429, 'три круга съели три слота, четвёртый не найдётся')
  endRounds = 1
})

/* ---------- критерии 3 и 5: пауза ---------- */

test('пауза уходит агенту с профилем и диалогом из cookie', async () => {
  pauseCalls.length = 0
  const r = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.1',
    cookie: withSession(),
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).paused, true)
  assert.equal(pauseCalls.length, 1)
  assert.deepEqual(pauseCalls[0], {
    runId: RUN,
    body: { paused: true, profileId: PID, sessionId: SID },
  })
})

test('пауза чужого диалога — 404, и до ручки паузы дело не доходит', async () => {
  pauseCalls.length = 0
  const r = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.2',
    cookie: withSession(ALIEN_SID),
  })
  assert.equal(r.status, 404)
  assert.equal(pauseCalls.length, 0)
})

test('пауза без профиля — 409, без диалога — 409', async () => {
  const noProfile = await call('POST', '/api/run/pause', { paused: true }, { ip: '10.4.0.3' })
  assert.equal(noProfile.status, 409)
  const noSession = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.4',
    cookie: `day13_pid=${PID}`,
  })
  assert.equal(noSession.status, 409)
})

test('пауза завершённого запуска — 409 словами агента', async () => {
  const r = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.5',
    cookie: withSession(IDLE_SID),
  })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).code, 'no_run')
})

test('paused не булево — 400, к агенту запрос не идёт', async () => {
  pauseCalls.length = 0
  const r = await call('POST', '/api/run/pause', { paused: 'да' }, {
    ip: '10.4.0.6',
    cookie: withSession(),
  })
  assert.equal(r.status, 400)
  assert.equal(pauseCalls.length, 0)
})

test('возобновление без прерванного вызова слота не тратит', async () => {
  const ip = '10.5.0.1'
  interruptedCall = false
  const cookie = withSession()
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
    assert.equal(r.status, 200, `возобновление ${i + 1} не упирается в минутное окно запусков`)
  }
})

test('возобновление с прерванным вызовом берёт слот, а 429 оставляет паузу', async () => {
  const ip = '10.6.0.1'
  interruptedCall = true
  const cookie = withSession()
  pauseCalls.length = 0
  // Минутное окно — 4 слота: четыре возобновления проходят, пятое отвергается.
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
    assert.equal(r.status, 200)
  }
  assert.equal(pauseCalls.length, 4)
  const denied = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
  assert.equal(denied.status, 429)
  assert.match((await denied.json()).error, /Слишком часто/)
  assert.equal(pauseCalls.length, 4, 'без слота запуск остаётся на паузе: агента не трогаем')
  interruptedCall = false
})

test('отказ агента на возобновлении возвращает взятый слот', async () => {
  const ip = '10.7.0.1'
  interruptedCall = true
  const cookie = withSession(DONE_SID)
  // Запуск этого диалога агент считает несуществующим: ручка отдаёт 404.
  for (let i = 0; i < 6; i++) {
    const r = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
    assert.equal(r.status, 404, `попытка ${i + 1}`)
  }
  // Шесть попыток при минутном окне в 4 — значит слот каждый раз возвращался.
  interruptedCall = false
})

/* ---------- критерий 9: журнал этапов ---------- */

test('журнал отдаётся как CSV и не исполняется браузером', async () => {
  const r = await fetch(`${base}/api/runs/${RUN}/log.csv`, { headers: { cookie: withSession() } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/csv/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.match(r.headers.get('content-disposition'), /attachment/)
  const text = await r.text()
  assert.match(text, /^run_id,state,outcome/)
  assert.equal(text.includes('agent-key'), false)
})

test('журнал чужого запуска — 404', async () => {
  const r = await fetch(`${base}/api/runs/${ALIEN_RUN}/log.csv`, {
    headers: { cookie: withSession() },
  })
  assert.equal(r.status, 404)
})

test('журнал без диалога и с негодным идентификатором — 404', async () => {
  const noSession = await fetch(`${base}/api/runs/${RUN}/log.csv`, {
    headers: { cookie: `day13_pid=${PID}` },
  })
  assert.equal(noSession.status, 404)
  const bad = await fetch(`${base}/api/runs/..%2F..%2Fetc/log.csv`, {
    headers: { cookie: withSession() },
  })
  assert.equal(bad.status, 404)
})

/* ---------- страница ---------- */

test('страница отдаётся и ключа в ней нет', async () => {
  const r = await fetch(`${base}/`)
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.equal(html.includes('agent-key'), false)
  assert.match(html, /день 13/)
})

test('/healthz отвечает и не раскрывает ключ', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.equal((await r.text()).includes('agent-key'), false)
})

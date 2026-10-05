// Шов «лимитер в диспетчере» дня 25 (ADR 2026-09-29-1600, слой 2 держателя) и
// решение владельца Р8(б) (ADR 2026-10-05-0544, п. 6): слот суточного потолка
// берётся до разбора тела, а отказ 4xx его ВОЗВРАЩАЕТ.
//
// Предмет проверки — НЕ «лимитер где-то есть», а два утверждения:
//
//   1. «забыть окно у новой ручки нельзя». Тест берёт СПИСОК РУЧЕК ДНЯ —
//      экспортированную таблицу `routes`, ту самую, по которой день
//      маршрутизирует в проде, — и требует от каждой записи окна либо
//      названной причины исключения. Ручка без окна до этого теста не
//      доживает: `server.js` не загружается вовсе (слой 1, `checkRoutes`).
//      Ручка с окном, но без образца запроса здесь, краснит «у каждой ручки
//      есть образец».
//   2. «отказ 4xx не стоит денег». Ручка формулировщика берёт слот до разбора
//      тела; десять запросов с негодным телом при суточном потолке 3 обязаны
//      кончиться тем, что законный ход всё равно проходит.
//
// Улика различает гипотезы дважды: отказ сверяется с ТЕКСТОМ своего окна (один
// код 429 не отличил бы окно записей от окна запусков) и с ЖУРНАЛОМ стенда
// сервиса (код ответа день отдал бы и сходив в сервис).

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const KEY = 'agent-key-secret-seam-do-not-leak'
const PID = '11111111-1111-4111-8111-111111111111'
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '00000000-0000-4000-8000-000000000001'

/** @type {{method:string,url:string}[]} журнал стенда сервиса агентов */
const seen = []

const agents = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  seen.push({ method: req.method, url: req.url })
  const [path] = req.url.split('?')

  if (path.endsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    return res.end('event: end\ndata: {"status":"succeeded"}\n\n')
  }
  if (path.endsWith('/log.csv')) {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' })
    return res.end('run_id,state,outcome\n')
  }
  const payload = {
    ok: true,
    runId: RUN,
    // Предел кругов профиля — один: ручка сообщения занимает ровно один слот,
    // и окно «запусков» в единицу упирается вторым запросом, а не первым.
    profile: { id: PID, name: 'стенд', stagedSettings: { reviewRounds: 1 }, sessions: [] },
    profiles: [],
    sessions: [],
    sessionId: SID,
    draft: { variants: [], ticket: 't' },
    invariant: { num: 1, text: 'и' },
    prompt: { promptId: 'stage.task', text: 'п' },
    settings: {},
    messages: [],
    prompts: [],
    topic: { id: 1, title: 'т', facts: [] },
    agents: [{ id: 'rag-chat-agent', name: 'ч', version: '1', models: [], stages: [] }],
    head: null,
    paused: true,
    run: null,
  }
  res.writeHead(path === '/v1/runs' ? 202 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Оба окна по единице: второй запрос той же ручки обязан упереться.
process.env.RATE_LIMIT_PER_MIN = '1'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '1'
// Потолок заведомо недостижим: иначе отказ приходил бы от него, и окно минуты
// осталось бы без держателя. Возврат слота по 4xx проверяется отдельным
// тестом со своим сервером.
process.env.MAX_DAILY_CALLS = '1000'

const { checkRoutes, routes, server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const key = (route) => `${route.method} ${route.path}`
const json = { 'content-type': 'application/json' }
const cookie = `day25_pid=${PID}; day25_sid=${SID}`

/**
 * Как позвать каждую ручку. Ключ — запись таблицы; новая ручка без образца
 * краснит тест ниже, а не проходит молча.
 */
const SAMPLES = {
  'GET /healthz': {},
  'GET /api/profiles': {},
  'GET /api/profile': {},
  'POST /api/profile': { headers: json, body: JSON.stringify({ name: 'стенд' }) },
  'DELETE /api/profile': { headers: json, body: JSON.stringify({ id: PID }) },
  'POST /api/profile/select': { headers: json, body: JSON.stringify({ id: PID }) },
  'PUT /api/settings': { headers: json, body: JSON.stringify({ strategy: 'window' }) },
  'POST /api/invariants/draft': { headers: json, body: JSON.stringify({ text: 'правило' }) },
  'POST /api/invariants': { headers: json, body: JSON.stringify({ text: 'правило', ticket: 't' }) },
  'DELETE /^\\/api\\/invariants\\/(\\d{1,9})$/': { path: '/api/invariants/1' },
  'PUT /^\\/api\\/prompts\\/([a-z][a-z.]{1,40})$/': {
    path: '/api/prompts/stage.task',
    headers: json,
    body: JSON.stringify({ text: 'текст промпта' }),
  },
  'DELETE /^\\/api\\/prompts\\/([a-z][a-z.]{1,40})$/': { path: '/api/prompts/stage.task' },
  'GET /api/sessions': {},
  'POST /api/session': { headers: json, body: '{}' },
  'POST /api/session/select': { headers: json, body: JSON.stringify({ id: SID }) },
  'POST /api/session/topic': { headers: json, body: JSON.stringify({ decision: 'no' }) },
  'GET /^\\/api\\/topic\\/(\\d{1,9})$/': { path: '/api/topic/1' },
  'POST /api/answer': { headers: json, body: JSON.stringify({ prompt: 'что держит I-4' }) },
  'POST /api/run/pause': { headers: json, body: JSON.stringify({ paused: true }) },
  'GET /^\\/api\\/runs\\/([^/]+)\\/prompts$/': { path: `/api/runs/${RUN}/prompts` },
  'GET /^\\/api\\/runs\\/([^/]+)\\/log\\.csv$/': { path: `/api/runs/${RUN}/log.csv` },
  'GET /api/chat': {},
  'DELETE /api/chat': {},
  'PUT /api/chat/head': { headers: json, body: JSON.stringify({ messageId: 1 }) },
  'GET /^\\/api\\/runs\\/([^/]+)\\/events$/': { path: `/api/runs/${RUN}/events` },
  'GET /api/state': {},
}

/** Текст отказа — у каждого окна свой; по нему и опознаётся, КТО отказал. */
const DENIAL = {
  run: 'Слишком часто. Подождите минуту.',
  write: 'Слишком много изменений профилей за час. Попробуйте позже.',
}

const call = (route, ip) => {
  const sample = SAMPLES[key(route)]
  const path = sample.path ?? route.path
  return fetch(`${base}${path}`, {
    method: route.method,
    headers: { 'x-forwarded-for': ip, cookie, ...(sample.headers ?? {}) },
    body: sample.body,
  })
}

test('у каждой ручки таблицы названо окно, а у исключения — причина', () => {
  const free = []
  for (const route of routes) {
    assert.ok(
      ['run', 'write', 'read', 'open'].includes(route.limit),
      `${key(route)}: окно не названо`,
    )
    if (route.limit === 'open' || route.limit === 'read') {
      assert.ok(route.why && route.why.trim() !== '', `${key(route)}: исключение без причины`)
      free.push(`${key(route)} [${route.limit}] — ${route.why}`)
    }
  }
  // Список исключений идёт в вывод целиком: он должен читаться глазами, а не
  // только проверяться машиной.
  console.log(`вне платных окон (${free.length}):\n  ${free.join('\n  ')}`)
})

test('у каждой ручки таблицы есть образец запроса в этом тесте', () => {
  const missing = routes.filter((route) => !SAMPLES[key(route)]).map(key)
  assert.deepEqual(missing, [], `новая ручка не проверена швом: ${missing.join(', ')}`)
})

test('таблица не грузится, если ручка не назвала окно или исключение не назвало причину', () => {
  const stub = () => {}
  assert.throws(() => checkRoutes([{ method: 'POST', path: '/api/forgot', handler: stub }]), /limit/)
  assert.throws(
    () => checkRoutes([{ method: 'GET', path: '/api/x', limit: 'maybe', handler: stub }]),
    /limit/,
  )
  assert.throws(
    () => checkRoutes([{ method: 'GET', path: '/api/x', limit: 'open', handler: stub }]),
    /why/,
  )
  assert.throws(
    () => checkRoutes([{ method: 'GET', path: '/api/x', limit: 'read', handler: stub }]),
    /why/,
  )
  assert.throws(() => checkRoutes([{ method: 'GET', path: '/api/x', limit: 'read', why: 'ч' }]), /обработчик/)
  // Платная ручка обязана назвать, сколько слотов занимает, а «свои слоты» —
  // объяснить: иначе ручка, берущая слот сама, ничем не отличалась бы от
  // ручки, забывшей его взять.
  assert.throws(
    () => checkRoutes([{ method: 'POST', path: '/api/x', limit: 'run', handler: stub }]),
    /slots/,
  )
  assert.throws(
    () => checkRoutes([{ method: 'POST', path: '/api/x', limit: 'run', slots: 'own', handler: stub }]),
    /why/,
  )
  assert.throws(
    () => checkRoutes([{ method: 'POST', path: '/api/x', limit: 'write', alsoRun: '', handler: stub }]),
    /alsoRun/,
  )
})

test('каждая ручка под платным окном отказывает СВОИМИ словами и до сервиса не доходит', async () => {
  const limited = routes.filter((route) => route.limit === 'run' || route.limit === 'write')
  assert.ok(limited.length > 0, 'под платным окном нет ни одной ручки — проверять нечего')

  for (const [i, route] of limited.entries()) {
    const ip = `10.9.0.${i + 1}` // своё окно каждой ручке: адреса не пересекаются
    const first = await call(route, ip)
    assert.notEqual(first.status, 429, `${key(route)}: слот не выдан даже первому запросу`)

    seen.length = 0
    const second = await call(route, ip)
    assert.equal(second.status, 429, `${key(route)}: второй запрос прошёл мимо окна ${route.limit}`)
    const body = await second.json()
    // Не просто 429: текст называет ИМЕННО то окно, которое объявила таблица.
    assert.equal(body.error, DENIAL[route.limit], `${key(route)}: отказало не окно ${route.limit}`)
    if (route.slots === 'own') {
      // Исключение, названное таблицей полем `why`: число слотов равно пределу
      // кругов из настроек профиля, и до резерва ручка читает их у сервиса.
      // Чтение БЕСПЛАТНО — модель оно не зовёт, — и проверяется это не словом
      // «бесплатно», а журналом стенда: в нём только чтение профиля и ни
      // одного создания запуска.
      assert.deepEqual(
        seen.map((call) => `${call.method} ${call.url.split('?')[0]}`),
        [`GET /v1/profiles/${PID}`],
        `${key(route)}: до резерва ушло не только чтение настроек: ${JSON.stringify(seen)}`,
      )
    } else {
      assert.deepEqual(
        seen,
        [],
        `${key(route)}: отказ лимитера всё-таки дошёл до сервиса: ${JSON.stringify(seen)}`,
      )
    }
  }
})

test('чтения и проба живости остаются вне окон', async () => {
  for (const route of routes.filter((r) => r.limit === 'read' || r.limit === 'open')) {
    for (let i = 0; i < 4; i += 1) {
      const res = await call(route, '10.9.9.9')
      assert.notEqual(res.status, 429, `${key(route)}: чтение всё-таки под окном`)
    }
  }
})

test('проба живости не отдаёт остатка суточного потолка', async () => {
  const res = await fetch(`${base}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(Object.keys(body).sort(), ['errors', 'ok'])
  // Прямым текстом, а не только по ключам: любое поле с остатком — подсказка
  // снаружи, когда бить залпом (решение владельца Р8).
  const raw = JSON.stringify(body)
  for (const word of ['callsToday', 'dailyLimit', 'trackedIps', 'writeIps', 'limiter'])
    assert.ok(!raw.includes(word), `в пробе живости осталось поле ${word}`)
})

// Шов «лимитер в диспетчере» (ADR 2026-09-29-1600), слой 2 держателя.
//
// Предмет проверки — НЕ «лимитер где-то есть», а утверждение «забыть окно у
// новой ручки нельзя». Тест берёт СПИСОК РУЧЕК ДНЯ — экспортированную таблицу
// `routes`, ту самую, по которой день маршрутизирует в проде, — и требует от
// каждой записи одного из двух: окно или причина исключения. Ручка, которую
// автор добавил, а окно назвать забыл, до этого теста не доживает: `server.js`
// не загружается вовсе (слой 1, `checkRoutes`). Ручка с окном, но без образца
// запроса здесь, краснит «у каждой ручки таблицы есть образец».
//
// Улика различает гипотезы дважды: отказ сверяется с ТЕКСТОМ своего окна (один
// код 429 не отличил бы окно чтений от окна запусков) и с ЖУРНАЛОМ стенда
// сервиса (код ответа день отдал бы и сходив в сервис).
//
// Окна здесь по единице: ПЕРВЫЙ запрос каждой ручки тратит её слот и до стенда
// доходит — это ожидаемо и проверяется; красное свойство несёт ВТОРОЙ.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const KEY = 'agent-key-secret-seam-do-not-leak'

/** @type {{method:string,url:string}[]} журнал стенда сервиса агентов */
const seen = []

const agents = http.createServer(async (req, res) => {
  for await (const _ of req) void _
  seen.push({ method: req.method, url: req.url })
  if (req.url.endsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    return res.end('event: end\ndata: {"status":"succeeded"}\n\n')
  }
  res.writeHead(req.url === '/v1/runs' ? 202 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, runId: 'run-abc' }))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Оба окна по единице: второй запрос той же ручки обязан упереться.
process.env.RATE_LIMIT_PER_MIN = '1'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_READS_PER_HOUR = '1'
// Потолок заведомо недостижим: иначе отказ приходил бы от него, и окно
// запусков осталось бы без держателя — тот же приём, что в server.test.js.
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

/**
 * Как позвать каждую ручку. Ключ — запись таблицы; новая ручка без образца
 * краснит тест ниже, а не проходит молча.
 */
const SAMPLES = {
  'GET /healthz': {},
  'POST /api/runs': {
    body: JSON.stringify({ question: 'где держится I-4', mode: 'rag' }),
    headers: { 'content-type': 'application/json' },
  },
  'GET /^\\/api\\/runs\\/([^/]+)\\/events$/': { path: '/api/runs/run-abc/events' },
}

/** Текст отказа — у каждого окна свой; по нему и опознаётся, КТО отказал. */
const DENIAL = {
  run: 'Предел запросов страницы: слишком часто.',
  read: 'Слишком много чтений страницы за час. Попробуйте позже.',
}

const call = (route, ip) => {
  const sample = SAMPLES[key(route)]
  const path = sample.path ?? route.path
  return fetch(`${base}${path}`, {
    method: route.method,
    headers: { 'x-forwarded-for': ip, ...(sample.headers ?? {}) },
    body: sample.body,
  })
}

test('у каждой ручки таблицы названо окно, а у исключения — причина', () => {
  const open = []
  for (const route of routes) {
    assert.ok(['run', 'read', 'open'].includes(route.limit), `${key(route)}: окно не названо`)
    if (route.limit === 'open') {
      assert.ok(route.why && route.why.trim() !== '', `${key(route)}: исключение без причины`)
      open.push(`${key(route)} — ${route.why}`)
    }
  }
  // Список исключений идёт в вывод целиком: он должен читаться глазами, а не
  // только проверяться машиной.
  console.log(`вне окон (${open.length}):\n  ${open.join('\n  ')}`)
})

test('у каждой ручки таблицы есть образец запроса в этом тесте', () => {
  const missing = routes.filter((route) => !SAMPLES[key(route)]).map(key)
  assert.deepEqual(missing, [], `новая ручка не проверена швом: ${missing.join(', ')}`)
})

test('таблица не грузится, если ручка не назвала окно или исключение не назвало причину', () => {
  const stub = () => {}
  assert.throws(() => checkRoutes([{ method: 'POST', path: '/api/forgot', handler: stub }]), /limit/)
  assert.throws(() => checkRoutes([{ method: 'GET', path: '/api/x', limit: 'maybe', handler: stub }]), /limit/)
  assert.throws(() => checkRoutes([{ method: 'GET', path: '/api/x', limit: 'open', handler: stub }]), /why/)
  assert.throws(() => checkRoutes([{ method: 'GET', path: '/api/x', limit: 'read' }]), /обработчик/)
  // Окна записей у дня нет, и значение `write` таблица не принимает: ручка,
  // правящая общую базу сервиса, обязана завести себе окно осознанно, а не
  // проехать на значении, скопированном из дня 20.
  assert.throws(() => checkRoutes([{ method: 'POST', path: '/api/x', limit: 'write', handler: stub }]), /limit/)
})

test('каждая ручка под окном отказывает СВОИМИ словами и до сервиса не доходит', async () => {
  const limited = routes.filter((route) => route.limit !== 'open')
  assert.ok(limited.length > 0, 'под окном нет ни одной ручки — проверять нечего')

  for (const [i, route] of limited.entries()) {
    const ip = `10.9.0.${i + 1}` // своё окно каждой ручке: адреса не пересекаются
    const first = await call(route, ip)
    assert.notEqual(first.status, 429, `${key(route)}: слот не выдан даже первому запросу`)

    seen.length = 0
    const second = await call(route, ip)
    assert.equal(second.status, 429, `${key(route)}: второй запрос прошёл мимо окна ${route.limit}`)
    const json = await second.json()
    // Не просто 429: текст называет ИМЕННО то окно, которое объявила таблица.
    assert.equal(json.error, DENIAL[route.limit], `${key(route)}: отказало не окно ${route.limit}`)
    assert.deepEqual(seen, [], `${key(route)}: отказ лимитера всё-таки дошёл до сервиса: ${JSON.stringify(seen)}`)
  }
})

test('исключение остаётся открытым: окно на нём не стоит', async () => {
  for (const route of routes.filter((r) => r.limit === 'open')) {
    for (let i = 0; i < 5; i += 1) {
      const res = await call(route, '10.9.9.9')
      assert.notEqual(res.status, 429, `${key(route)}: исключение всё-таки под окном`)
    }
  }
})

test('окна не отнимают друг у друга: исчерпанное чтение не мешает задать вопрос', async () => {
  const ip = '10.9.1.1'
  assert.equal((await fetch(`${base}/api/runs/run-abc/events`, { headers: { 'x-forwarded-for': ip } })).status, 200)
  assert.equal((await fetch(`${base}/api/runs/run-abc/events`, { headers: { 'x-forwarded-for': ip } })).status, 429)
  const asked = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'вопрос', mode: 'rerank' }),
  })
  assert.equal(asked.status, 202, 'исчерпанное окно чтений отняло право задать вопрос')
})

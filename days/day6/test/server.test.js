// Интеграционный тест дня: настоящий сервер дня против поддельного сервиса
// агентов на локальном порту. Проверяется связка — лимитер, создание
// запуска, прокси потока, возврат слота, сборка состояния.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

/** Поддельный агент: помнит запросы, отдаёт заданный поток. */
const agentLog = []
let agentMode = 'ok'
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
  if (req.url === '/v1/runs') {
    const input = JSON.parse(body).input
    if (!input.sphere) return json(400, { ok: false, code: 'bad_input', message: 'Укажите тему' })
    return json(202, {
      ok: true,
      // Хвост runId задаёт тема: тест выбирает, какой поток получит запуск.
      runId: `00000000-0000-4000-8000-00000000000${input.sphere === 'без денег' ? '7' : '1'}`,
    })
  }
  const events = req.url.match(/^\/v1\/runs\/([^/]+)\/events$/)
  if (events) {
    if (events[1].endsWith('9')) return json(404, { ok: false, code: 'unknown_run' })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`id: 1\nevent: event\ndata: ${JSON.stringify({ seq: 1, stage: 'received' })}\n\n`)
    res.write(': ping\n\n')
    const end = events[1].endsWith('7')
      ? {
          status: 'failed',
          error: { code: 'budget_too_small', message: 'мало', paidNothing: true },
        }
      : { status: 'succeeded', result: { answer: 'ответ' } }
    res.write(`event: end\ndata: ${JSON.stringify(end)}\n\n`)
    return res.end()
  }
  if (req.url === '/v1/agents') {
    return json(200, {
      ok: true,
      agents: [
        {
          id: 'news-analyst',
          name: 'Аналитик',
          version: '1.0.0',
          purpose: 'назначение',
          systemPrompt: 'промпт',
          tools: [{ name: 'archive' }],
          models: [{ id: 'anthropic-haiku' }],
          presets: [{ id: 'p' }],
          defaults: { model: 'anthropic-haiku' },
          limits: { maxTokens: 2048 },
        },
      ],
    })
  }
  if (req.url === '/v1/agents/news-analyst/tools/archive') {
    return json(200, { ok: true, total: 5, capacity: 1000, sources: [{ source: 'TechCrunch' }] })
  }
  json(404, { ok: false })
})

await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key'
process.env.AGENT_URL = `http://127.0.0.1:${agent.address().port}`
process.env.MAX_DAILY_CALLS = '4'
process.env.RATE_LIMIT_PER_MIN = '3'
process.env.RATE_LIMIT_PER_HOUR = '4'

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

const ask = (body, ip = '10.0.0.1') =>
  fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('/healthz отвечает и не раскрывает ключ', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.equal((await r.text()).includes('agent-key'), false)
})

test('запрос уходит агенту с ключом дня и именем агента; страница получает runId', async () => {
  const mine = 'Отвечай одним предложением.'
  const r = await ask({ sphere: 'финтех', articles: 3, system: mine })
  assert.equal(r.status, 202)
  const { runId } = await r.json()
  assert.match(runId, /^[0-9a-f-]{36}$/)
  const sent = agentLog.at(-1)
  assert.equal(sent.auth, 'Bearer agent-key')
  const body = JSON.parse(sent.body)
  assert.equal(body.agent, 'news-analyst')
  assert.deepEqual(
    body.input,
    { sphere: 'финтех', articles: 3, system: mine },
    'вход уходит как есть, включая свой системный промпт, — проверяет его агент',
  )
})

test('отказ агента во входе доходит словами агента, слот возвращается', async () => {
  const before = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  const r = await ask({ sphere: '' })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'Укажите тему')
  const after = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  assert.equal(after, before, 'слот вернулся')
  assert.equal((await ask('{не json')).status, 400)
  assert.equal((await ask([1, 2])).status, 400)
})

test('поток событий проксируется как есть, включая end с результатом', async () => {
  const { runId } = await (await ask({ sphere: 'финтех' })).json()
  const r = await fetch(`${base}/api/runs/${runId}/events`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/event-stream/)
  const text = await r.text()
  assert.match(text, /event: event\ndata: \{"seq":1/)
  assert.match(text, /: ping/)
  assert.match(text, /event: end\ndata: \{"status":"succeeded"/)
})

test('запуск, отказанный агентом без траты денег, возвращает слот лимитера', async () => {
  // Поддельный агент отдаёт end с paidNothing для runId на «7».
  const before = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  const created = await ask({ sphere: 'без денег' }, '10.0.0.7')
  assert.equal(created.status, 202)
  const { runId } = await created.json()
  assert.equal((await (await fetch(`${base}/healthz`)).json()).limiter.callsToday, before + 1)
  await (await fetch(`${base}/api/runs/${runId}/events`)).text()
  assert.equal((await (await fetch(`${base}/healthz`)).json()).limiter.callsToday, before)
})

test('чужой или кривой runId — 404, а не обращение к агенту', async () => {
  const calls = agentLog.length
  assert.equal((await fetch(`${base}/api/runs/../events`)).status, 404)
  assert.equal((await fetch(`${base}/api/runs/x/events`)).status, 404)
  assert.equal(agentLog.length, calls)
  const unknown = await fetch(`${base}/api/runs/00000000-0000-4000-8000-000000000009/events`)
  assert.equal(unknown.status, 404)
})

test('состояние собирается из реестра и архива агента', async () => {
  const s = await (await fetch(`${base}/api/state`)).json()
  assert.equal(s.agent.name, 'Аналитик')
  assert.equal(s.agent.systemPrompt, 'промпт')
  assert.equal(s.agent.version, '1.0.0')
  assert.deepEqual(s.models, [{ id: 'anthropic-haiku' }])
  assert.equal(s.archive.total, 5)
  assert.equal('sources' in s.archive, false)
  assert.deepEqual(s.sources, [{ source: 'TechCrunch' }])
  assert.equal(JSON.stringify(s).includes('agent-key'), false)
})

test('окно на минуту и суточный предел работают до обращения к агенту', async () => {
  const calls = agentLog.length
  // 10.0.0.1 уже сделал два запроса (202 и 400→слот возвращён): пройдёт ещё два.
  assert.equal((await ask({ sphere: 'a' })).status, 202)
  const r = await ask({ sphere: 'a' })
  assert.equal(r.status, 429)
  assert.match((await r.json()).error, /Слишком часто/)
  assert.equal(agentLog.length, calls + 1, 'отказ лимитера до агента не дошёл')
})

test('агент недоступен: 502 на запрос, 503 на состояние, слот возвращён', async () => {
  agentMode = 'down'
  const before = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  const r = await ask({ sphere: 'финтех' }, '10.0.0.2')
  assert.equal(r.status, 502)
  assert.equal((await (await fetch(`${base}/healthz`)).json()).limiter.callsToday, before)
  assert.equal((await fetch(`${base}/api/state`)).status, 503)
  agentMode = 'ok'
})

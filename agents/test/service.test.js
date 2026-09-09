// Контракт сервиса через настоящий HTTP: авторизация, создание запуска,
// поток событий с воспроизведением, снимок, реестр и состояние архива.

import assert from 'node:assert/strict'
import http from 'node:http'
import { connect } from 'node:net'
import { after, before, test } from 'node:test'
import { createNewsAnalyst } from '../src/agent.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { ENV, fakeArchive, fakeRouter, NEWS } from './fixtures.js'

const runs = createRuns()
const archive = fakeArchive()
const agent = createNewsAnalyst({
  agent: NEWS,
  archive,
  runs,
  env: ENV,
  fetchImpl: fakeRouter(),
  log: () => {},
})
const agents = new Map([[agent.id, agent]])
const server = http.createServer(createService({ agents, archive, runs, env: ENV, log: () => {} }))
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => server.close(resolve)))

const AUTH = { authorization: 'Bearer agent-key' }
const post = (path, body, headers = AUTH) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** Читает поток SSE до закрытия и разбирает сообщения. */
async function readStream(path) {
  const response = await fetch(`${base}${path}`, { headers: AUTH })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((block) => block.trim() && !block.startsWith(':'))
    .map((block) => {
      const out = {}
      for (const line of block.split('\n')) {
        const i = line.indexOf(': ')
        out[line.slice(0, i)] = line.slice(i + 2)
      }
      return { ...out, data: JSON.parse(out.data) }
    })
}

test('/healthz открыт и отдаёт состояние без секретов', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual(j.agents, ['news-analyst'])
  assert.equal(JSON.stringify(j).includes('agent-key'), false)
})

test('без ключа или с чужим — 401 до всего остального', async () => {
  assert.equal((await fetch(`${base}/v1/agents`)).status, 401)
  assert.equal(
    (await fetch(`${base}/v1/agents`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  )
  assert.equal(
    (await post('/v1/runs', { agent: 'news-analyst', input: { sphere: 'x' } }, {})).status,
    401,
  )
})

test('создание запуска: проверка тела, агента и входа', async () => {
  assert.equal((await post('/v1/runs', '{не json')).status, 400)
  const unknown = await post('/v1/runs', { agent: 'nobody', input: { sphere: 'x' } })
  assert.equal(unknown.status, 404)
  const bad = await post('/v1/runs', { agent: 'news-analyst', input: { sphere: '' } })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).message, /Укажите тему/)
})

test('запуск: 202 с runId, поток событий до end с результатом, снимок готового', async () => {
  const created = await post('/v1/runs', {
    agent: 'news-analyst',
    input: { sphere: 'финтех', articles: 3 },
  })
  assert.equal(created.status, 202)
  const { runId } = await created.json()
  assert.match(runId, /^[0-9a-f-]{36}$/)

  const messages = await readStream(`/v1/runs/${runId}/events`)
  const events = messages.filter((m) => m.event === 'event').map((m) => m.data)
  assert.equal(events[0].stage, 'received')
  assert.equal(events.at(-1).stage, 'done')
  assert.equal(messages[0].id, '1', 'id сообщения — номер события')
  const end = messages.at(-1)
  assert.equal(end.event, 'end')
  assert.equal(end.data.status, 'succeeded')
  assert.ok(end.data.result.answer.length > 0)

  // Повторное чтение готового запуска — воспроизведение и сразу end.
  const again = await readStream(`/v1/runs/${runId}/events`)
  assert.equal(again.length, messages.length)

  const snap = await (await fetch(`${base}/v1/runs/${runId}`, { headers: AUTH })).json()
  assert.equal(snap.run.status, 'succeeded')
  assert.equal(snap.finished, true)
  assert.equal(snap.run.events.length, events.length)
  assert.equal(JSON.stringify(snap.run).includes('финтех'), false, 'вход не отдаётся')
})

test('неизвестный запуск — 404, и для потока тоже', async () => {
  const id = '00000000-0000-4000-8000-000000000000'
  assert.equal((await fetch(`${base}/v1/runs/${id}`, { headers: AUTH })).status, 404)
  assert.equal((await fetch(`${base}/v1/runs/${id}/events`, { headers: AUTH })).status, 404)
  assert.equal((await fetch(`${base}/v1/runs/../x`, { headers: AUTH })).status, 404)
})

test('реестр для окна передачи: промпт, версия, модели, пресеты', async () => {
  const j = await (await fetch(`${base}/v1/agents`, { headers: AUTH })).json()
  const a = j.agents[0]
  assert.equal(a.id, 'news-analyst')
  assert.equal(a.version, '1.0.0')
  assert.equal(a.systemPrompt, NEWS.systemPrompt)
  assert.ok(a.models.length >= 4)
  assert.equal(a.presets.length, 7)
  assert.equal(a.tools[0].name, 'archive')
})

test('состояние архива у агента; у чужого агента — 404', async () => {
  const r = await fetch(`${base}/v1/agents/news-analyst/tools/archive`, { headers: AUTH })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.total, 2)
  assert.equal(j.capacity, 1000)
  assert.equal(
    (await fetch(`${base}/v1/agents/nobody/tools/archive`, { headers: AUTH })).status,
    404,
  )
})

test('битый заголовок Host — 400, а не падение процесса', async () => {
  // Необработанный отказ в async-обработчике валит весь сервис, поэтому
  // разбор адреса проверяется сырым запросом, минуя fetch с его нормализацией.
  const { port } = server.address()
  const answer = await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write('GET /v1/agents HTTP/1.1\r\nHost: не адрес\r\nConnection: close\r\n\r\n')
    })
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk
    })
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
  })
  assert.match(answer, /^HTTP\/1\.1 400 /)
  // Процесс жив: обычный запрос после битого проходит.
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
})

test('переписка сессии читается и удаляется через сервис', async () => {
  // Сервис в этом файле поднят без хранилища: сессии в нём выключены,
  // и это должно быть честным отказом, а не молчаливой пустотой.
  const id = '33333333-3333-4333-8333-333333333333'
  const r = await fetch(`${base}/v1/sessions/${id}`, { headers: AUTH })
  assert.equal(r.status, 503)
  assert.equal((await r.json()).code, 'no_sessions')

  // Кривой идентификатор не доходит до хранилища.
  assert.equal((await fetch(`${base}/v1/sessions/..`, { headers: AUTH })).status, 404)
  // Без ключа — 401, как и всё под /v1/.
  assert.equal((await fetch(`${base}/v1/sessions/${id}`)).status, 401)
})

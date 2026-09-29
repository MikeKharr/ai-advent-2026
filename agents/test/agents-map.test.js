// Сборка исполнителей по НАСТОЯЩЕМУ реестру `config/agents.json` и контракт
// ручки `/v1/agents` на полном реестре.
//
// Зачем именно так: `/v1/agents` зовёт `describe()` у ВСЕХ агентов разом
// (`src/service.js`), поэтому агент без этого метода роняет ручку целиком, а с
// ней экран состояния девяти дней (6–11, 13–15). Так и случилось с PR #237:
// исполнители `mcp-agent` и `pipeline-agent` метода не имели, и не краснело
// ничто. Проверка идёт по реестру, а не по списку имён: следующий агент
// попадёт под неё сам, без правки теста.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { createAgents } from '../src/agents-map.js'
import { registryPrompts } from '../src/prompts.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { ENV, fakeArchive, REGISTRY } from './fixtures.js'

const runs = createRuns()
const archive = fakeArchive()
const agents = createAgents({
  registry: REGISTRY,
  archive,
  runs,
  sessions: null,
  stageLog: { append: () => false, prune: () => 0 },
  invariants: null,
  prompts: registryPrompts,
  // Реестра серверов MCP в тесте нет: адреса берутся из окружения, и без них
  // сервер в реестр не попадает. Описанию агента это безразлично.
  servers: new Map(),
  env: ENV,
  log: () => {},
})

const server = http.createServer(createService({ agents, archive, runs, env: ENV, log: () => {} }))
let base = ''
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => server.close(resolve)))

test('у каждого агента реестра есть describe(), и он отвечает', async () => {
  assert.ok(agents.size > 0, 'исполнителей не собралось вовсе')
  for (const [id, agent] of agents) {
    assert.equal(typeof agent.describe, 'function', `у агента ${id} нет describe()`)
    const described = await agent.describe()
    assert.equal(described?.id, id, `describe() агента ${id} не назвал себя`)
  }
})

test('у каждого агента реестра есть весь контракт, который зовёт сервис', () => {
  // Тот же класс дефекта, что и пропавший `describe`: сервис зовёт эти
  // методы, не спрашивая, есть ли они (`src/service.js`). У `describe` цена
  // выше — он падает на ручке реестра и уносит экраны девяти дней, — но
  // забытый `parseInput` уронит запуск ровно так же молча.
  for (const [id, agent] of agents) {
    for (const method of ['describe', 'parseInput', 'execute', 'isBusy', 'hold'])
      assert.equal(typeof agent[method], 'function', `у агента ${id} нет ${method}()`)
  }
})

test('GET /v1/agents отвечает 200 на полном реестре и отдаёт всех собранных', async () => {
  const response = await fetch(`${base}/v1/agents`, { headers: { authorization: 'Bearer agent-key' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(
    body.agents.map((a) => a.id).sort(),
    [...agents.keys()].sort(),
    'в выдаче не все собранные агенты',
  )
})

test('описание агентов MCP не выносит наружу промпт и адреса серверов', async () => {
  const response = await fetch(`${base}/v1/agents`, { headers: { authorization: 'Bearer agent-key' } })
  const body = await response.json()
  for (const id of ['mcp-agent', 'pipeline-agent']) {
    const described = body.agents.find((a) => a.id === id)
    assert.ok(described, `агента ${id} нет в выдаче`)
    assert.equal(described.systemPrompt, undefined, `описание ${id} несёт системный промпт`)
    const text = JSON.stringify(described)
    assert.equal(/https?:\/\//.test(text), false, `описание ${id} несёт адрес`)
    assert.equal(text.includes('agent-key'), false)
  }
  // Имена серверов — не адреса: их страница дня 20 называет вслух.
  assert.deepEqual(body.agents.find((a) => a.id === 'mcp-agent').servers, [
    'mcpnews',
    'mcpstore',
    'day16',
  ])
})

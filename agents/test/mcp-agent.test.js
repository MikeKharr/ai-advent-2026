// Цикл `mcp-agent` против поддельных серверов MCP и поддельного роутера.
// Ни один тест этого файла в сеть не ходит: серверы MCP — локальные
// `node:http`, роутер — подставной `fetchImpl`.
//
// Главный предмет файла — КАКИМ КЛЮЧОМ ПРИЛОЖЕНИЯ платит запуск. У двух
// точек входа ключи разные: посетитель дня 20 — `ROUTER_APP_KEY` ($10 в
// сутки у приложения `agents`), планировщик дня 18 — `ROUTER_APP_KEY_SCHEDULER`
// ($0,5 у приложения `scheduler`). Два теста ниже держат каждый свою
// половину: поменяв ключи местами, красными становятся оба.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import {
  askTools,
  clipToolResult,
  createJobRunner,
  createMcpAgent,
  MAX_ROUNDS,
  runToolLoop,
  TOOL_RESULT_LIMIT,
} from '../src/mcp/agent.js'
import { createPipelineAgent } from '../src/mcp/pipeline-agent.js'
import { loadServers } from '../src/mcp/servers.js'
import { loadRegistry } from '../src/registry.js'
import { createRuns } from '../src/runs.js'

const APP_KEY = 'app-key-agents'
const SCHEDULER_KEY = 'app-key-scheduler'

const env = {
  ROUTER_URL: 'http://router:8081',
  ROUTER_APP_KEY: APP_KEY,
  ROUTER_APP_KEY_SCHEDULER: SCHEDULER_KEY,
  ROUTER_TIMEOUT_MS: 5_000,
}

const registry = loadRegistry(
  JSON.parse(readFileSync(new URL('../config/agents.json', import.meta.url), 'utf8')),
)

/** Поддельный сервер MCP: список инструментов и поведение `tools/call`. */
async function fakeMcp({ tools, call }) {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', async () => {
      const rpc = JSON.parse(raw)
      let result = {}
      if (rpc.method === 'tools/list')
        result = { tools: tools.map((name) => ({ name, description: `делает ${name}`, inputSchema: { type: 'object' } })) }
      else if (rpc.method === 'tools/call') {
        seen.push({ name: rpc.params.name, args: rpc.params.arguments })
        result = await call(rpc.params.name, rpc.params.arguments)
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  }
}

/** Серверы не кладут `structuredContent`: JSON уходит строкой в текстовом блоке. */
const packed = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

/** Подставной роутер: копит запросы и отдаёт заготовленные ответы по кругам. */
function fakeRouter(replies) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      key: init.headers.authorization,
      body: JSON.parse(init.body),
    })
    const reply = typeof replies === 'function' ? replies(calls.length) : replies[calls.length - 1]
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ...reply }),
    }
  }
  return { calls, fetchImpl }
}

const answer = (text) => ({ text, content: [{ type: 'text', text }], stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 }, budgetLeft: { costUsd: 0.42, tokens: 1000 } })
const wantsTool = (name, input = {}) => ({
  text: '',
  content: [{ type: 'tool_use', id: `tu-${name}`, name, input }],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
  budgetLeft: { costUsd: 0.4, tokens: 1000 },
})

/** Один сервер новостей и реестр над ним. */
async function oneServer(overrides = {}) {
  const news = await fakeMcp({
    tools: ['news.search'],
    call: () => packed({ items: [{ title: 'новость' }] }),
    ...overrides,
  })
  const { servers } = loadServers(
    { servers: [{ name: 'mcpnews', title: 'Новости', urlEnv: 'MCP_NEWS_URL' }] },
    { MCP_NEWS_URL: news.url },
  )
  return { news, servers }
}

const jobOf = (prompt = 'собери сводку') => ({ id: 'digest', agentId: 'mcp-agent', prompt })

test('автономный запуск планировщика платит ключом приложения scheduler, а не ключом agents', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([answer('сводка готова')])
  const runs = createRuns()
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl: router.fetchImpl })

  const out = await runJob({ job: jobOf(), runId: 'run-scheduler' })

  assert.equal(out.status, 'succeeded')
  assert.equal(router.calls.length, 1)
  assert.equal(router.calls[0].key, `Bearer ${SCHEDULER_KEY}`)
  // Половина, которая краснеет при подмене: ключом приложения `agents`
  // автономный расход идти не может — у него свой потолок $0,5 в сутки.
  assert.notEqual(router.calls[0].key, `Bearer ${APP_KEY}`)
  await news.close()
})

test('интерактивный запуск дня 20 платит ключом приложения agents, а не ключом планировщика', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([answer('ответ')])
  const runs = createRuns()
  const entry = registry.get('mcp-agent')
  const agent = createMcpAgent({ agent: entry, servers, runs, env, fetchImpl: router.fetchImpl })

  const parsed = agent.parseInput({ task: 'что нового' })
  assert.ok(parsed.ok)
  const run = runs.create({ agent: entry, input: parsed.input })
  await agent.execute(run)

  assert.equal(runs.snapshot(run.id).status, 'succeeded')
  assert.equal(router.calls[0].key, `Bearer ${APP_KEY}`)
  assert.notEqual(router.calls[0].key, `Bearer ${SCHEDULER_KEY}`)
  await news.close()
})

test('вызов роутера без ключа приложения не уходит вовсе', async () => {
  const router = fakeRouter([answer('ответ')])
  await assert.rejects(
    () =>
      askTools(
        { messages: [{ role: 'user', content: 'x' }], tools: [], taskClass: 'tool_use' },
        { routerUrl: env.ROUTER_URL, routerKey: null, fetchImpl: router.fetchImpl, timeoutMs: 1000 },
      ),
    /без ключа приложения/,
  )
  assert.equal(router.calls.length, 0)
})

test('потолок кругов держит хост: девятого вызова роутера не бывает', async () => {
  const { news, servers } = await oneServer()
  // Модель зовёт инструмент бесконечно — остановить её может только хост.
  const router = fakeRouter(() => wantsTool('mcpnews__news_search'))
  const out = await runToolLoop({
    task: 'ищи',
    system: 'ты агент',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: SCHEDULER_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
  })
  assert.equal(router.calls.length, MAX_ROUNDS)
  assert.equal(out.status, 'failed')
  assert.match(out.summary, /Потолок в 8 кругов/)
  await news.close()
})

test('потолок времени проверяется до вызова роутера: истёкший срок круга не покупает', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter(() => wantsTool('mcpnews__news_search'))
  let clock = 0
  const out = await runToolLoop({
    task: 'ищи',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: SCHEDULER_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
    // Часы прыгают за потолок сразу после старта.
    now: () => (clock += 200_000),
    deadlineMs: 120_000,
  })
  assert.equal(router.calls.length, 0)
  assert.equal(out.status, 'failed')
  assert.match(out.summary, /Потолок времени/)
  await news.close()
})

test('обрыв ответа по длине с блоком tool_use: инструмент не исполняется', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([
    {
      text: '',
      content: [{ type: 'tool_use', id: 'tu-1', name: 'mcpnews__news_search', input: {} }],
      // Роутер называет обрыв по длине `length`, а не `max_tokens`.
      stopReason: 'length',
      usage: { inputTokens: 1, outputTokens: 1 },
      budgetLeft: { costUsd: 0.3 },
    },
  ])
  const out = await runToolLoop({
    task: 'ищи',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: SCHEDULER_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
  })
  assert.deepEqual(news.seen, [])
  assert.equal(router.calls.length, 1)
  assert.equal(out.status, 'failed')
  assert.match(out.summary, /обрезан потолком токенов/)
  await news.close()
})

test('одноимённые инструменты двух серверов не сталкиваются: вызов уходит своему', async () => {
  const one = await fakeMcp({ tools: ['file.read'], call: () => packed({ from: 'one' }) })
  const two = await fakeMcp({ tools: ['file.read'], call: () => packed({ from: 'two' }) })
  const { servers } = loadServers(
    {
      servers: [
        { name: 'mcpstore', title: 'Файлы', urlEnv: 'A' },
        { name: 'day16', title: 'День 16', urlEnv: 'B' },
      ],
    },
    { A: one.url, B: two.url },
  )
  const router = fakeRouter([wantsTool('day16__file_read', { name: 'x' }), answer('готово')])
  const out = await runToolLoop({
    task: 'прочитай',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: SCHEDULER_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
  })
  assert.equal(out.status, 'succeeded')
  assert.deepEqual(one.seen, [])
  assert.deepEqual(two.seen, [{ name: 'file.read', args: { name: 'x' } }])
  assert.equal(out.calls[0].server, 'day16')
  await one.close()
  await two.close()
})

test('неизвестное модели имя инструмента: на серверы ничего не уходит, модель получает отказ', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([wantsTool('mcpnews__нет_такого'), answer('извини')])
  const out = await runToolLoop({
    task: 'ищи',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: SCHEDULER_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
  })
  assert.deepEqual(news.seen, [])
  const back = router.calls[1].body.messages.at(-1).content[0]
  assert.equal(back.type, 'tool_result')
  assert.equal(back.is_error, true)
  assert.equal(out.status, 'succeeded')
  await news.close()
})

test('результат инструмента длиннее 8 КБ уходит модели обрезанным и с пометкой', async () => {
  const long = 'я'.repeat(20_000)
  const news = await fakeMcp({
    tools: ['news.search'],
    call: () => ({ content: [{ type: 'text', text: long }] }),
  })
  const { servers } = loadServers(
    { servers: [{ name: 'mcpnews', title: 'Новости', urlEnv: 'U' }] },
    { U: news.url },
  )
  const router = fakeRouter([wantsTool('mcpnews__news_search'), answer('готово')])
  const out = await runToolLoop({
    task: 'ищи',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: SCHEDULER_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
  })
  const sent = router.calls[1].body.messages.at(-1).content[0].content[0].text
  assert.ok(Buffer.byteLength(sent) <= TOOL_RESULT_LIMIT + 64)
  assert.match(sent, /обрезан хостом/)
  assert.ok(out.warnings.some((w) => /обрезан до/.test(w)))
  await news.close()
})

test('ни один сервер не отдал инструментов: роутер не вызывается, расхода нет', async () => {
  const { servers } = loadServers(
    { servers: [{ name: 'mcpnews', title: 'Новости', urlEnv: 'U' }] },
    { U: 'http://127.0.0.1:1/mcp' },
  )
  const router = fakeRouter([answer('нечему быть')])
  const out = await runToolLoop({
    task: 'ищи',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: SCHEDULER_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
  })
  assert.equal(router.calls.length, 0)
  assert.equal(out.status, 'failed')
  assert.equal(out.tokens, null)
  assert.equal(out.budgetLeftUsd, null)
})

test('роутер не ответил: остаток бюджета остаётся неизвестным, а не нулём', async () => {
  const { news, servers } = await oneServer()
  const runs = createRuns()
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ ok: false, code: 'budget_exceeded', message: 'потолок' }),
  })
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl })
  const out = await runJob({ job: jobOf(), runId: 'run-no-router' })
  assert.equal(out.status, 'failed')
  assert.equal(out.budgetLeftUsd, null)
  assert.equal(out.tokens, null)
  await news.close()
})

test('запуск планировщика виден в памяти под тем же идентификатором и несёт трейс rpc', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([wantsTool('mcpnews__news_search'), answer('сводка')])
  const runs = createRuns()
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl: router.fetchImpl })
  const out = await runJob({ job: jobOf(), runId: 'run-trace' })

  const snapshot = runs.snapshot('run-trace')
  assert.equal(snapshot.status, 'succeeded')
  assert.ok(snapshot.events.some((e) => e.stage === 'rpc'))
  // Трейс ленты — те же данные, что в событиях: `{server, method, ...}`.
  assert.ok(out.trace.length >= 2)
  assert.equal(out.trace[0].server, 'mcpnews')
  assert.equal(out.trace.at(-1).method, 'tools/call')
  assert.equal(out.tokens, 30)
  assert.equal(out.budgetLeftUsd, 0.42)
  await news.close()
})

test('обрезка результата меряется байтами, а не знаками', () => {
  assert.deepEqual(clipToolResult('коротко'), { text: 'коротко', clipped: false })
  const clipped = clipToolResult('я'.repeat(TOOL_RESULT_LIMIT))
  assert.equal(clipped.clipped, true)
})

test('цепочка дня 19 зарегистрирована и исполняется агентом без модели', async () => {
  const files = new Map()
  const news = await fakeMcp({
    tools: ['news.search', 'news.summarize'],
    call: (name, args) =>
      name === 'news.search'
        ? packed({ items: [{ title: `о ${args.query}` }] })
        : packed({ text: 'выжимка' }),
  })
  const store = await fakeMcp({
    tools: ['file.save', 'file.read'],
    call: (name, args) => {
      if (name === 'file.save') {
        files.set(args.name, args.content)
        return packed({ name: args.name })
      }
      return packed({ found: true, name: args.name, content: files.get(args.name) })
    },
  })
  const { servers } = loadServers(
    {
      servers: [
        { name: 'mcpnews', title: 'Новости', urlEnv: 'A' },
        { name: 'mcpstore', title: 'Файлы', urlEnv: 'B' },
      ],
    },
    { A: news.url, B: store.url },
  )
  const runs = createRuns()
  const entry = registry.get('pipeline-agent')
  assert.ok(entry, 'pipeline-agent обязан быть в реестре')
  const agent = createPipelineAgent({ agent: entry, servers, runs })
  const parsed = agent.parseInput({ task: 'финтех' })
  assert.ok(parsed.ok)
  const run = runs.create({ agent: entry, input: parsed.input })
  await agent.execute(run)

  const snapshot = runs.snapshot(run.id)
  assert.equal(snapshot.status, 'succeeded')
  assert.equal(snapshot.result.match, true)
  assert.equal(snapshot.events.filter((e) => e.stage === 'rpc').length, 6)
  await news.close()
  await store.close()
})

test('пустое задание цепочки отвергается до единого вызова', async () => {
  const { servers } = loadServers(
    { servers: [{ name: 'mcpnews', title: 'Новости', urlEnv: 'U' }] },
    { U: 'http://127.0.0.1:1/mcp' },
  )
  const agent = createPipelineAgent({ agent: registry.get('pipeline-agent'), servers, runs: createRuns() })
  assert.equal(agent.parseInput({ task: '  ' }).ok, false)
  assert.equal(agent.parseInput({ task: 'x'.repeat(601) }).ok, false)
})

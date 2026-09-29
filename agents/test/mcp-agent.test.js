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
import { createSessions } from '../src/sessions.js'

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

/** Пара серверов цепочки: новости и хранилище, в их настоящих формах ответов. */
async function chainPair() {
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
  return { news, store, servers, files }
}

test('работа планировщика с агентом без модели идёт цепочкой, а не отвергается', async () => {
  // Держатель решения владельца: предмет работы — инструменты и MCP, а не
  // сводка моделью. Отказ `modelless` ронял бы работу на КАЖДОМ сроке.
  const { news, store, servers } = await chainPair()
  const router = fakeRouter([answer('этого быть не должно')])
  const runs = createRuns()
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl: router.fetchImpl })

  const out = await runJob({ job: { id: 'digest', agentId: 'pipeline-agent', prompt: 'финтех' }, runId: 'run-chain' })

  assert.equal(out.status, 'succeeded')
  // Роутер не вызывался: у цепочки модели нет, и расход её равен нулю.
  assert.equal(router.calls.length, 0)
  assert.equal(out.tokens, null)
  assert.equal(out.budgetLeftUsd, null)
  // Трейс ленты дня 18: два списка инструментов и четыре вызова.
  assert.equal(out.trace.length, 6)
  assert.equal(runs.snapshot('run-chain').status, 'succeeded')
  await news.close()
  await store.close()
})

test('бесплатная работа не зависит от ключа приложения: без ROUTER_APP_KEY_SCHEDULER цепочка идёт', async () => {
  const { news, store, servers } = await chainPair()
  const router = fakeRouter([answer('этого быть не должно')])
  const runs = createRuns()
  // Ключа планировщика нет вовсе — платить цепочке всё равно нечем.
  const runJob = createJobRunner({
    registry,
    servers,
    runs,
    env: { ...env, ROUTER_APP_KEY_SCHEDULER: null },
    fetchImpl: router.fetchImpl,
  })

  const out = await runJob({ job: { id: 'digest', agentId: 'pipeline-agent', prompt: 'финтех' }, runId: 'run-nokey' })

  assert.equal(out.status, 'succeeded')
  assert.equal(router.calls.length, 0)
  await news.close()
  await store.close()
})

test('отказ планировщика остаётся для агента, которого в реестре нет', async () => {
  const { news, store, servers } = await chainPair()
  const runs = createRuns()
  const router = fakeRouter([answer('нет')])
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl: router.fetchImpl })
  const out = await runJob({ job: { id: 'digest', agentId: 'нет-такого', prompt: 'x' }, runId: 'run-unknown' })
  assert.equal(out.status, 'failed')
  assert.match(out.summary, /нет в реестре/)
  assert.equal(router.calls.length, 0)
  await news.close()
  await store.close()
})

test('цепочка планировщика оборвалась: запуск failed, а не молчаливый успех', async () => {
  const news = await fakeMcp({ tools: ['news.search'], call: () => packed({ items: [] }) })
  const { servers } = loadServers(
    { servers: [{ name: 'mcpnews', title: 'Новости', urlEnv: 'A' }] },
    { A: news.url },
  )
  const runs = createRuns()
  const out = await createJobRunner({ registry, servers, runs, env })({
    job: { id: 'digest', agentId: 'pipeline-agent', prompt: 'финтех' },
    runId: 'run-broken',
  })
  assert.equal(out.status, 'failed')
  assert.equal(runs.snapshot('run-broken').status, 'failed')
  await news.close()
})

test('работа планировщика пишет в один файл, а не плодит их', async () => {
  // Держатель ADR 2026-09-28-1323, п. 5. Работа идёт 96 раз в сутки, срок
  // хранения `mcpstore` — 30 ч, потолок — 200 файлов: имя по времени старта
  // заняло бы 120 мест из 200, а заполнение хранилища — отказ `file.save` у
  // ВСЕХ, включая посетителей дня 19. Перезапись файла числа файлов не
  // меняет (`mcpstore/src/store.js:78`).
  const { news, store, servers, files } = await chainPair()
  const runs = createRuns()
  let tick = 1_700_000_000_000
  const runJob = createJobRunner({ registry, servers, runs, env, now: () => (tick += 900_000) })

  for (let i = 0; i < 3; i += 1) {
    const out = await runJob({
      job: { id: 'digest', agentId: 'pipeline-agent', prompt: 'финтех' },
      runId: `run-file-${i}`,
    })
    assert.equal(out.status, 'succeeded')
  }

  assert.deepEqual([...files.keys()], ['pipeline-digest.txt'], 'работа завела больше одного файла в mcpstore')
  await news.close()
  await store.close()
})

// ——— слова модели между вызовами (ADR 2026-09-28-1852, заход 1) ———
//
// Событие стадии `llm_text` берёт текст из ОТВЕТА ТОГО ЖЕ КРУГА: второго
// обращения к модели у него нет, и подставной роутер ниже это показывает —
// число запросов к нему от появления события не меняется.

/** Ответ круга: слова модели и её выбор инструментов рядом, как их шлёт API. */
const wordsThenTool = (text, name, stopReason = 'tool_use') => ({
  text,
  content: [
    { type: 'text', text },
    { type: 'tool_use', id: `tu-${name}`, name, input: {} },
  ],
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5 },
  budgetLeft: { costUsd: 0.4, tokens: 1000 },
})

const textEvents = (events) => events.filter((e) => e.stage === 'llm_text')

test('слова модели на круге с вызовом уходят событием: текст и выбор с именем сервера', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([wordsThenTool('Сначала поищу новости.', 'mcpnews__news_search'), answer('готово')])
  const runs = createRuns()
  const entry = registry.get('mcp-agent')
  const agent = createMcpAgent({ agent: entry, servers, runs, env, fetchImpl: router.fetchImpl })
  const run = runs.create({ agent: entry, input: agent.parseInput({ task: 'что нового' }).input })

  await agent.execute(run)

  const said = textEvents(runs.snapshot(run.id).events)
  assert.equal(said.length, 2, 'событие идёт на каждом круге, включая заключительный')
  assert.equal(said[0].data.round, 1)
  assert.equal(said[0].data.text, 'Сначала поищу новости.')
  assert.deepEqual(said[0].data.chosen, [{ server: 'mcpnews', tool: 'news.search' }])
  assert.equal(said[0].data.stopReason, 'tool_use')
  // Заключительный круг: слова есть, выбора нет.
  assert.deepEqual(said[1].data.chosen, [])
  assert.equal(said[1].data.text, 'готово')
  // Текст взят из уже пришедшего ответа: лишнего круга к модели не появилось.
  assert.equal(router.calls.length, 2)
  await news.close()
})

test('текста у круга нет — событие всё равно уходит, и text в нём пустая строка', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([wantsTool('mcpnews__news_search'), answer('готово')])
  const runs = createRuns()
  const entry = registry.get('mcp-agent')
  const agent = createMcpAgent({ agent: entry, servers, runs, env, fetchImpl: router.fetchImpl })
  const run = runs.create({ agent: entry, input: agent.parseInput({ task: 'что нового' }).input })

  await agent.execute(run)

  const said = textEvents(runs.snapshot(run.id).events)
  // Гипотезы, которые эта проверка различает: «событие спрятали, раз текста
  // нет» (длина стала бы 1) и «пустоту подменили заглушкой» (text !== '').
  assert.equal(said.length, 2)
  assert.equal(said[0].data.text, '')
  assert.deepEqual(said[0].data.chosen, [{ server: 'mcpnews', tool: 'news.search' }])
  await news.close()
})

test('обрыв по длине не пропадает молча: причина остановки стоит в событии рядом с названными инструментами', async () => {
  const { news, servers } = await oneServer()
  const long = 'Объясняю выбор. '.repeat(200)
  const router = fakeRouter([wordsThenTool(long, 'mcpnews__news_search', 'length')])
  const runs = createRuns()
  const entry = registry.get('mcp-agent')
  const agent = createMcpAgent({ agent: entry, servers, runs, env, fetchImpl: router.fetchImpl })
  const run = runs.create({ agent: entry, input: agent.parseInput({ task: 'что нового' }).input })

  await agent.execute(run)

  const said = textEvents(runs.snapshot(run.id).events)
  assert.equal(said.length, 1)
  assert.equal(said[0].data.text, long, 'длинный текст уходит целиком, а не обрезанным событием')
  assert.equal(said[0].data.stopReason, 'length')
  // Инструмент назван, но НЕ исполнен: обрезанный блок исполнять нельзя.
  assert.deepEqual(said[0].data.chosen, [{ server: 'mcpnews', tool: 'news.search' }])
  assert.deepEqual(news.seen, [])
  await news.close()
})

test('слова модели не попадают ни в трейс работы планировщика дня 18, ни в его ленту', async () => {
  const { news, servers } = await oneServer()
  const router = fakeRouter([wordsThenTool('Ищу новости.', 'mcpnews__news_search'), answer('сводка')])
  const runs = createRuns()
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl: router.fetchImpl })

  const out = await runJob({ job: jobOf(), runId: 'run-holder' })

  // Различение гипотез: событие действительно было (иначе пустой трейс ничего
  // не доказывал бы), и в трейс работы оно всё равно не попало.
  assert.equal(textEvents(runs.snapshot('run-holder').events).length, 2)
  assert.ok(out.trace.length > 0)
  for (const entry of out.trace) {
    assert.equal(typeof entry.method, 'string', `в трейсе работы запись не от JSON-RPC: ${JSON.stringify(entry)}`)
    assert.equal(entry.text, undefined)
    assert.equal(entry.chosen, undefined)
  }
  await news.close()
})

// ——— Порядок вызовов принадлежит модели (ADR 2026-09-28-1852, условие
// приёмки владельца: «важно чтобы модель реально сама выбирала инструмент»).
//
// Держатель устроен так, что сценарий в коде его ломает: задание ОДНО И ТО ЖЕ,
// меняется только ответ подставного роутера. Если порядок вызовов перестанет
// зависеть от ответа модели — отсортируется, зафиксируется реестром, сведётся к
// цепочке — оба порядка совпадут и тест покраснеет. Третий инструмент модель не
// называет ни разу: «зовём всё, что есть» тоже должно краснеть.

const THREE_TOOLS = ['alpha.one', 'beta.two', 'gamma.three']

const wantsThese = (names) => ({
  text: '',
  content: names.map((name, i) => ({ type: 'tool_use', id: `tu-${i}`, name: `mcpnews__${name.replace(/\./g, "_")}`, input: {} })),
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
  budgetLeft: { costUsd: 0.4, tokens: 1000 },
})

/** Один прогон одного и того же задания при заданном моделью порядке. */
async function runWithOrder(order) {
  const { news, servers } = await oneServer({
    tools: THREE_TOOLS,
    call: (name) => packed({ called: name }),
  })
  const router = fakeRouter([wantsThese(order), answer('готово')])
  const out = await runToolLoop({
    task: 'одно и то же задание',
    system: 'ты агент',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: APP_KEY,
    timeoutMs: 5_000,
    fetchImpl: router.fetchImpl,
  })
  const seen = news.seen.map((c) => c.name)
  await news.close()
  return { out, seen }
}

test('порядок вызовов задаёт ответ модели: то же задание, другой ответ — другой порядок', async () => {
  const first = await runWithOrder(['alpha.one', 'beta.two'])
  const second = await runWithOrder(['beta.two', 'alpha.one'])

  assert.equal(first.out.status, 'succeeded')
  assert.equal(second.out.status, 'succeeded')
  // Каждый прогон исполнил ровно то, что назвала модель, и в её порядке.
  assert.deepEqual(first.seen, ['alpha.one', 'beta.two'])
  assert.deepEqual(second.seen, ['beta.two', 'alpha.one'])
  // Главное утверждение: задание одно, порядки разные. Любая фиксация порядка
  // в коде — сортировка, реестр, цепочка — сводит эти два списка в один.
  assert.notDeepEqual(first.seen, second.seen)
  // Инструмент, которого модель не называла, не зовётся ни в одном прогоне:
  // «позвать всё, что есть» — тоже сценарий, а не выбор.
  assert.ok(!first.seen.includes('gamma.three'))
  assert.ok(!second.seen.includes('gamma.three'))
})

// ——— Диалог с сессией (ADR 2026-09-28-1852, заход 2). Механизм дня 7:
// хвост переписки текстом, замок на сессию, две записи на ход.

const SID = '11111111-1111-4111-8111-111111111111'

function memorySessions() {
  return createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, log: () => {} })
}

async function dialogAgent(replies) {
  const { news, servers } = await oneServer()
  const router = fakeRouter(replies)
  const runs = createRuns()
  const sessions = memorySessions()
  const entry = registry.get('mcp-agent')
  const agent = createMcpAgent({ agent: entry, servers, runs, sessions, env, fetchImpl: router.fetchImpl })
  return { news, runs, sessions, agent, router, entry }
}

test('прошлые реплики уходят в роутер сообщениями ПЕРЕД заданием, а не текстом внутри него', async (t) => {
  const d = await dialogAgent([answer('второй ответ')])
  t.after(() => d.news.close())
  d.sessions.append({ sessionId: SID, role: 'user', text: 'первый вопрос', tokens: 5 })
  d.sessions.append({ sessionId: SID, role: 'agent', text: 'первый ответ', tokens: 5 })

  const parsed = d.agent.parseInput({ task: 'второе задание', sessionId: SID })
  assert.ok(parsed.ok)
  await d.agent.execute(d.runs.create({ agent: d.entry, input: parsed.input }))

  assert.deepEqual(d.router.calls[0].body.messages, [
    { role: 'user', content: 'первый вопрос' },
    { role: 'assistant', content: 'первый ответ' },
    { role: 'user', content: 'второе задание' },
  ])
})

test('ход пишется в переписку двумя репликами, слова кругов лежат рядом с ответом агента', async (t) => {
  const d = await dialogAgent([wantsTool('mcpnews__news_search'), answer('итог')])
  t.after(() => d.news.close())
  const parsed = d.agent.parseInput({ task: 'что нового', sessionId: SID })
  const run = d.runs.create({ agent: d.entry, input: parsed.input })
  await d.agent.execute(run)

  const messages = d.sessions.history(SID)
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ['user', 'что нового'],
    ['agent', 'итог'],
  ])
  assert.equal(messages[1].runId, run.id)
  // Слова кругов переживают перезагрузку страницы: поток событий живёт
  // 10 минут, переписка — 30 часов (решение владельца при приёмке).
  assert.equal(messages[1].meta.rounds.length, 2)
  assert.deepEqual(messages[1].meta.rounds[0].chosen, [{ server: 'mcpnews', tool: 'news.search' }])
  assert.equal(messages[1].meta.calls, 1)
  // Сырых тел JSON-RPC в переписке нет: это байты протокола, а не разговор.
  assert.ok(!JSON.stringify(messages[1].meta).includes('jsonrpc'))
})

test('занятая сессия получает отказ на входе, а не второй запуск', async (t) => {
  const d = await dialogAgent([answer('ответ')])
  t.after(() => d.news.close())
  d.agent.hold(SID)
  const parsed = d.agent.parseInput({ task: 'ещё раз', sessionId: SID })
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /уже идёт запуск/)
  // Чужая сессия при этом свободна: замок на диалог, а не на агента.
  assert.ok(d.agent.parseInput({ task: 'ещё раз', sessionId: '22222222-2222-4222-8222-222222222222' }).ok)
})

test('замок снимается после хода: следующее сообщение того же диалога проходит', async (t) => {
  const d = await dialogAgent([answer('первый'), answer('второй')])
  t.after(() => d.news.close())
  const first = d.agent.parseInput({ task: 'раз', sessionId: SID })
  d.agent.hold(SID)
  await d.agent.execute(d.runs.create({ agent: d.entry, input: first.input }))
  assert.ok(d.agent.parseInput({ task: 'два', sessionId: SID }).ok)
})

test('sessionId чужой формы отвергается на входе', async (t) => {
  const d = await dialogAgent([answer('ответ')])
  t.after(() => d.news.close())
  assert.equal(d.agent.parseInput({ task: 'раз', sessionId: '../../etc' }).ok, false)
  // Без сессии агент работает как раньше: одиночный запуск дня 20.
  assert.deepEqual(d.agent.parseInput({ task: 'раз' }).input.sessionId, null)
})

test('планировщик дня 18 истории не шлёт: в запросе одно сообщение', async (t) => {
  const { news, servers } = await oneServer()
  t.after(() => news.close())
  const router = fakeRouter([answer('сводка')])
  const runs = createRuns()
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl: router.fetchImpl })

  await runJob({ job: jobOf('собери сводку'), runId: 'run-no-history' })

  assert.deepEqual(router.calls[0].body.messages, [{ role: 'user', content: 'собери сводку' }])
})

// Осиротевший вопрос после неудачного хода — достижимое состояние базы, а не
// теория: `execute` пишет реплику `user` ВСЕГДА, ошибкой помечает только
// ответ агента, а `sessions.tail` записи с `meta.error` в контекст не берёт
// (`agents/src/sessions.js`). Значит после одного неудачного хода в хвосте
// остаётся `user` без пары, и следующий ход даёт два `user` подряд.
//
// Провайдер такой список отвергает целиком — то есть диалог ломался бы не на
// одном сообщении, а НАВСЕГДА, до очистки переписки. Поэтому проверка идёт по
// свойству («ролей подряд не бывает»), а не по конкретной склейке: способ
// починки может смениться, требование — нет.
test('после неудачного хода роли в следующем запросе чередуются, а не идут двумя user подряд', async (t) => {
  // Первый ход: модель вернула пустой ответ — запуск `failed`, ответ агента
  // уходит в переписку с пометкой ошибки. Второй ход должен пройти.
  const d = await dialogAgent([answer(''), answer('второй ответ')])
  t.after(() => d.news.close())

  const first = d.agent.parseInput({ task: 'первый вопрос', sessionId: SID })
  await d.agent.execute(d.runs.create({ agent: d.entry, input: first.input }))
  // Предпосылка проверки: хвост действительно осиротел. Без неё тест был бы
  // зелёным и на переписке, где двух `user` подряд не бывает вовсе.
  const tail = d.sessions.tail(SID, 3000)
  assert.deepEqual(tail.messages.map((m) => m.role), ['user'], 'ответ неудачного хода не помечен ошибкой — предпосылка не воспроизвелась')

  const second = d.agent.parseInput({ task: 'второй вопрос', sessionId: SID })
  await d.agent.execute(d.runs.create({ agent: d.entry, input: second.input }))

  const sent = d.router.calls[1].body.messages
  for (let i = 1; i < sent.length; i += 1)
    assert.notEqual(sent[i].role, sent[i - 1].role, `две реплики роли ${sent[i].role} подряд: ${JSON.stringify(sent)}`)
  // Ни одна реплика при этом не потеряна: слияние — не выбрасывание.
  const all = sent.map((m) => m.content).join('\n')
  assert.match(all, /первый вопрос/)
  assert.match(all, /второй вопрос/)
})

// ——— Рассуждение модели (ADR 2026-09-29-0236, пп. 1–4).
//
// Два утверждения этого блока противоположны по смыслу и обязаны держаться
// порознь: рассуждение ДОХОДИТ до экрана и НЕ ДОХОДИТ до базы. Одного теста на
// оба не бывает: код, который не эмитит ничего, прошёл бы «не сохраняется», а
// код, который кладёт всё в `meta`, прошёл бы «доходит до экрана».

/** Ответ модели с блоками размышления перед вызовом инструмента. */
const thinksAndWants = (name, thought, extra = []) => ({
  text: '',
  content: [
    ...(thought === null ? [] : [{ type: 'thinking', thinking: thought, signature: 'sig-1' }]),
    ...extra,
    { type: 'tool_use', id: 'tu-1', name, input: {} },
  ],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
  budgetLeft: { costUsd: 0.4, tokens: 1000 },
})

/** Событие стадии `llm_text` круга N из собранного потока. */
const saidOn = (events, round) =>
  events.find((e) => e.stage === 'llm_text' && e.data.round === round)?.data ?? null

async function loopWith(replies, options = {}) {
  const { news, servers } = await oneServer()
  const router = fakeRouter(replies)
  const events = []
  const out = await runToolLoop({
    task: 'что нового',
    system: 'ты агент',
    servers,
    taskClass: 'tool_use',
    provider: 'anthropic-haiku',
    answerTokens: 1024,
    routerUrl: env.ROUTER_URL,
    routerKey: APP_KEY,
    timeoutMs: 5_000,
    emit: (event) => events.push(event),
    fetchImpl: router.fetchImpl,
    ...options,
  })
  await news.close()
  return { out, events, router }
}

test('уровень размышления просит только день 20; планировщик дня 18 зовёт роутер без поля', async (t) => {
  const { news, servers } = await oneServer()
  t.after(() => news.close())
  const runs = createRuns()
  const entry = registry.get('mcp-agent')

  const day20 = fakeRouter([answer('ответ')])
  const agent = createMcpAgent({ agent: entry, servers, runs, env, fetchImpl: day20.fetchImpl })
  const parsed = agent.parseInput({ task: 'что нового' })
  await agent.execute(runs.create({ agent: entry, input: parsed.input }))
  assert.equal(day20.calls[0].body.thinking, 'low')

  const scheduler = fakeRouter([answer('сводка')])
  const runJob = createJobRunner({ registry, servers, runs, env, fetchImpl: scheduler.fetchImpl })
  await runJob({ job: jobOf('собери сводку'), runId: 'run-no-thinking' })
  // Ключа НЕТ вовсе, а не `none`: умолчание уровня принадлежит классу в
  // роутере, и подставлять своё здесь значило бы завести второе место, где
  // решается, за что платит планировщик.
  assert.ok(
    !('thinking' in scheduler.calls[0].body),
    `планировщик просит размышление: ${JSON.stringify(scheduler.calls[0].body.thinking)}`,
  )
})

test('рассуждение доходит до события круга вместе со словами и выбором', async () => {
  const { events } = await loopWith(
    [thinksAndWants('mcpnews__news_search', 'Сначала посмотрю новости.'), answer('итог')],
    { thinking: 'low' },
  )
  const first = saidOn(events, 1)
  assert.equal(first.thinking, 'Сначала посмотрю новости.')
  assert.equal(first.redacted, false)
  // Стадия та же: рассуждение — часть того же ответа, что слова и выбор
  // (ADR, п. 4). Второй стадии нет и заводить её нельзя.
  assert.equal(events.filter((e) => e.stage === 'llm_thinking').length, 0)
})

test('блоков размышления не было — поле null, а не пустая строка и не выдуманный текст', async () => {
  const { events } = await loopWith(
    [thinksAndWants('mcpnews__news_search', null), answer('итог')],
    { thinking: 'low' },
  )
  assert.equal(saidOn(events, 1).thinking, null)
  // Круг 2 блоков не несёт: эта форма запроса чередующегося размышления не
  // включает. Экран обязан показать это отсутствием записи, а не пустотой.
  assert.equal(saidOn(events, 2).thinking, null)
})

test('поставщик скрыл часть рассуждения — это отдельное состояние, а не отсутствие', async () => {
  const { events } = await loopWith(
    [
      thinksAndWants('mcpnews__news_search', null, [{ type: 'redacted_thinking', data: 'зашифровано' }]),
      answer('итог'),
    ],
    { thinking: 'low' },
  )
  assert.equal(saidOn(events, 1).redacted, true)
  assert.equal(saidOn(events, 1).thinking, null, 'скрытый блок не притворяется текстом рассуждения')
})

test('блоки размышления возвращаются в следующий круг без изменений, вместе с подписью', async () => {
  const { router } = await loopWith(
    [thinksAndWants('mcpnews__news_search', 'думаю'), answer('итог')],
    { thinking: 'low' },
  )
  const second = router.calls[1].body.messages
  const assistant = second.find((m) => m.role === 'assistant')
  assert.ok(assistant, 'ответ модели не вернулся в диалог')
  const block = assistant.content.find((b) => b.type === 'thinking')
  assert.ok(block, 'блок размышления в следующий круг не ушёл')
  // Подпись обязана уехать вместе с блоком: без неё поставщик отвергает
  // запрос целиком, и диалог ломался бы на втором круге.
  assert.deepEqual(block, { type: 'thinking', thinking: 'думаю', signature: 'sig-1' })
})

test('рассуждение не попадает ни в meta сообщения, ни в ответ истории', async (t) => {
  const { news, servers } = await oneServer()
  t.after(() => news.close())
  const router = fakeRouter([
    thinksAndWants('mcpnews__news_search', 'вот моя внутренняя сводка'),
    answer('итог'),
  ])
  const runs = createRuns()
  const sessions = memorySessions()
  const entry = registry.get('mcp-agent')
  const agent = createMcpAgent({ agent: entry, servers, runs, sessions, env, fetchImpl: router.fetchImpl })
  const parsed = agent.parseInput({ task: 'что нового', sessionId: SID })
  await agent.execute(runs.create({ agent: entry, input: parsed.input }))

  const stored = JSON.stringify(sessions.history(SID))
  assert.ok(!stored.includes('вот моя внутренняя сводка'), `рассуждение сохранилось: ${stored}`)
  assert.ok(!stored.includes('thinking'), `поле рассуждения сохранилось: ${stored}`)
  // Слова при этом сохраняются — иначе проверка была бы зелена и на коде,
  // который не сохраняет ничего.
  const meta = sessions.history(SID).at(-1).meta
  assert.equal(meta.rounds.length, 2)
  assert.ok(Object.hasOwn(meta.rounds[0], 'chosen'), 'слова кругов перестали сохраняться')
})

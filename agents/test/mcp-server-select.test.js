// Отбор серверов MCP по агенту (ADR 2026-09-29-0236, п. 6).
//
// Реестр серверов на хосте ОДИН, а достаётся каждому агенту не весь. Предмет
// файла — что обещание «день 18 не меняется от третьего сервера» держится
// построением, а не договорённостью: работа планировщика идёт `pipeline-agent`
// 96 раз в сутки, и без отбора третий сервер получал бы от неё 96 лишних
// `tools/list`, а её лента — 96 лишних записей «Получен список инструментов
// day16».
//
// В сеть здесь не ходят: серверы MCP — локальные `node:http`, роутера нет
// вовсе (цепочка дня 19 модель не спрашивает).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import { createJobRunner, createMcpAgent } from '../src/mcp/agent.js'
import { createPipelineAgent } from '../src/mcp/pipeline-agent.js'
import { sha256 } from '../src/mcp/pipeline.js'
import { assertAgentServers, loadServers, pickServers } from '../src/mcp/servers.js'
import { loadRegistry } from '../src/registry.js'
import { createRuns } from '../src/runs.js'

const RAW_AGENTS = JSON.parse(readFileSync(new URL('../config/agents.json', import.meta.url), 'utf8'))
const RAW_SERVERS = JSON.parse(
  readFileSync(new URL('../config/mcp-servers.json', import.meta.url), 'utf8'),
)
const registry = loadRegistry(RAW_AGENTS)

const packed = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

/** Поддельный сервер MCP, помнящий КАЖДЫЙ пришедший метод, включая tools/list. */
async function fakeMcp({ tools, call = () => packed({}) }) {
  const methods = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', async () => {
      const rpc = JSON.parse(raw)
      methods.push(rpc.method)
      let result = {}
      if (rpc.method === 'tools/list')
        result = { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) }
      else if (rpc.method === 'tools/call') result = await call(rpc.params.name, rpc.params.arguments)
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    methods,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  }
}

/** Три ЖИВЫХ сервера под настоящими именами реестра: адрес есть у каждого. */
async function trio() {
  const files = new Map()
  const news = await fakeMcp({
    tools: ['news.search', 'news.summarize'],
    call: (name, args) =>
      name === 'news.search'
        ? packed({ query: args.query, days: 7, found: 1, items: [{ title: 'о ' + args.query, url: null, points: 1 }] })
        : packed({ text: 'выжимка', sha256: sha256('выжимка'), count: 1, clipped: false }),
  })
  // Состав инструментов — как у настоящих единиц: `mcpnews/src/tools.js` (2),
  // `mcpstore/src/tools.js` (3), `mcp/src/tools.js` (3). Числа 8 и 5 ниже
  // отсюда, а не выдуманы.
  const store = await fakeMcp({
    tools: ['file.save', 'file.read', 'file.list'],
    call: (name, args) => {
      if (name === 'file.save') {
        files.set(args.name, args.content)
        return packed({
          name: args.name,
          bytes: Buffer.byteLength(args.content),
          sha256: sha256(args.content),
          savedAt: '2026-09-29T00:00:00.000Z',
          expiresAt: '2026-09-30T00:00:00.000Z',
          replaced: false,
        })
      }
      const content = files.get(args.name)
      return packed({ found: content !== undefined, name: args.name, content })
    },
  })
  const day16 = await fakeMcp({ tools: ['clock.now', 'weather.current', 'wiki.summary'] })
  const { servers, known } = loadServers(RAW_SERVERS, {
    MCP_NEWS_URL: news.url,
    MCP_STORE_URL: store.url,
    MCP_DAY16_URL: day16.url,
    // Кириллица в заголовке Authorization недопустима: fetch отвергает
    // такое значение сам, и сервер выглядел бы недоступным «по сети».
    MCP_KEY: 'mcp-key-fake',
  })
  return { news, store, day16, servers, known, close: () => Promise.all([news.close(), store.close(), day16.close()]) }
}

// Один набор серверов на весь файл, а не по набору на тест: закрытый порт
// может достаться следующему серверу, и пул соединений `fetch` отдаёт по нему
// мёртвый сокет — тест падал бы «сетью», а не предметом. Утверждения ниже от
// порядка не зависят: считается ПРИРОСТ обращений, а не их общее число.
const kit = await trio()
test.after(() => kit.close())

test('работа дня 18 опрашивает два сервера: tools/list к day16 не уходит', async () => {
  const seenBefore = kit.day16.methods.length
  const runs = createRuns()
  const runJob = createJobRunner({
    registry,
    servers: kit.servers,
    runs,
    env: { ROUTER_URL: 'http://router:8081', ROUTER_TIMEOUT_MS: 5_000 },
    fetchImpl: () => assert.fail('цепочка дня 19 роутер не зовёт'),
  })

  const out = await runJob({ job: { id: 'digest', agentId: 'pipeline-agent', prompt: 'MCP protocol' }, runId: 'r1' })

  assert.equal(out.status, 'succeeded', out.summary)
  // ГЛАВНОЕ утверждение: к третьему серверу не ушло НИЧЕГО — ни tools/list,
  // ни initialize. Красным его делает снятие pickServers в createJobRunner.
  assert.equal(kit.day16.methods.length, seenBefore, 'планировщик постучался в day16')
  // И проверка, что два других опрошены: пустота у всех трёх зеленела бы тоже.
  assert.ok(kit.news.methods.includes('tools/list'))
  assert.ok(kit.store.methods.includes('tools/list'))
  // Трейс работы — те же данные, что уходят в ленту дня 18: имени day16 в ней нет.
  assert.deepEqual([...new Set(out.trace.map((r) => r.server))], ['mcpnews', 'mcpstore'])
  assert.equal(out.trace.filter((r) => r.method === 'tools/list').length, 2)
})

test('день 20 получает три сервера и восемь инструментов, планировщик — два и пять', async () => {
  const day20 = pickServers(kit.servers, registry.get('mcp-agent').servers)
  const scheduler = pickServers(kit.servers, registry.get('pipeline-agent').servers)

  assert.deepEqual([...day20.keys()], ['mcpnews', 'mcpstore', 'day16'])
  assert.deepEqual([...scheduler.keys()], ['mcpnews', 'mcpstore'])

  const { listAllTools } = await import('../src/mcp/pipeline.js')
  const a = await listAllTools({ servers: day20 })
  const b = await listAllTools({ servers: scheduler })
  assert.deepEqual(a.unreachable, [])
  assert.equal(a.tools.length, 8)
  assert.equal(b.tools.length, 5)
  assert.ok(a.tools.some((t) => t.apiName === 'day16__clock_now'))
  assert.ok(!b.tools.some((t) => t.server === 'day16'))
})

// Держатели обеих точек входа: сужение живёт в них, а не в строке сборки
// процесса, которую ни один тест не исполняет.
test('точка входа дня 20 опрашивает все три сервера своего списка', async () => {
  const runs = createRuns()
  const seen = kit.day16.methods.length
  const agent = createMcpAgent({
    agent: registry.get('mcp-agent'),
    servers: kit.servers,
    runs,
    env: { ROUTER_URL: 'http://router:8081', ROUTER_APP_KEY: 'k', ROUTER_TIMEOUT_MS: 5_000 },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      // Заодно держатель того, что список инструментов дошёл до модели именно
      // тремя серверами: имена составные, «сервер__инструмент».
      assert.ok(body.tools.some((t) => t.name.startsWith('day16__')), 'инструментов day16 не дали модели')
      assert.equal(body.tools.length, 8)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          text: 'готово',
          content: [{ type: 'text', text: 'готово' }],
          stopReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
          budgetLeft: { costUsd: 1, tokens: 1 },
        }),
      }
    },
  })
  const parsed = agent.parseInput({ task: 'сколько времени в Бангкоке' })
  assert.ok(parsed.ok)
  const run = runs.create({ agent: registry.get('mcp-agent'), input: parsed.input })
  await agent.execute(run)

  assert.equal(runs.snapshot(run.id).status, 'succeeded')
  assert.equal(kit.day16.methods.length - seen, 1, 'день 20 не спросил day16 ровно один tools/list')
})

test('точка входа дня 19 опрашивает два сервера своего списка', async () => {
  const runs = createRuns()
  const seen = kit.day16.methods.length
  const agent = createPipelineAgent({ agent: registry.get('pipeline-agent'), servers: kit.servers, runs })
  const parsed = agent.parseInput({ task: 'MCP protocol' })
  assert.ok(parsed.ok)
  const run = runs.create({ agent: registry.get('pipeline-agent'), input: parsed.input })
  await agent.execute(run)

  assert.equal(runs.snapshot(run.id).status, 'succeeded')
  assert.equal(kit.day16.methods.length, seen, 'цепочка постучалась в day16')
})

test('сервер без адреса выпадает из списка агента так же, как из общего реестра', () => {
  // `skipped`, а не отказ: недоступный сервер — штатное состояние (ADR
  // 2026-09-28-0736, п. 1), и отбор этого не меняет.
  const { servers, skipped } = loadServers(RAW_SERVERS, { MCP_NEWS_URL: 'http://n/mcp' })
  assert.deepEqual(
    skipped.map((s) => s.name),
    ['mcpstore', 'day16'],
  )
  assert.deepEqual([...pickServers(servers, registry.get('mcp-agent').servers).keys()], ['mcpnews'])
})

test('имя сервера вне mcp-servers.json — отказ старта, а не «инструментов нет»', () => {
  const { known } = loadServers(RAW_SERVERS, {})
  assert.doesNotThrow(() => assertAgentServers(registry, known))

  const typo = loadRegistry({
    agents: RAW_AGENTS.agents.map((a) =>
      a.id === 'mcp-agent' ? { ...a, servers: ['mcpnews', 'day-16'] } : a,
    ),
  })
  assert.throws(
    () => assertAgentServers(typo, known),
    /mcp-agent.*day-16.*нет в реестре серверов MCP/s,
  )
})

test('servers обязателен у агента с инструментом mcp и не бывает у прочих', () => {
  const base = { id: 'xx', name: 'н', version: '1', purpose: 'п', defaults: {} }
  // Без поля — отказ, а не «весь реестр по умолчанию»: умолчание вернуло бы
  // третий сервер планировщику, и вернуло бы молча.
  assert.throws(() => loadRegistry({ agents: [{ ...base, tools: ['mcp'] }] }), /servers: ожидался непустой список/)
  assert.throws(
    () => loadRegistry({ agents: [{ ...base, tools: ['mcp'], servers: [] }] }),
    /servers: ожидался непустой список/,
  )
  assert.throws(
    () => loadRegistry({ agents: [{ ...base, tools: ['mcp'], servers: ['mcpnews', 'mcpnews'] }] }),
    /servers: имя повторяется/,
  )
  assert.throws(
    () => loadRegistry({ agents: [{ ...base, tools: ['mcp'], servers: ['Mcp News'] }] }),
    /servers: ожидался непустой список/,
  )
  // Агент без инструмента mcp со списком серверов — расхождение, а не
  // безвредное лишнее поле: список не достался бы никому.
  assert.throws(
    () => loadRegistry({ agents: [{ ...base, tools: [], servers: ['mcpnews'] }] }),
    /servers: бывает только у агента с инструментом mcp/,
  )
})

test('запрет mcpagents в общем реестре серверов отбором не отменяется', () => {
  // ADR 2026-09-28-1820, п. 5: операции управления не должны оказаться в руках
  // задания посетителя. Отбор — про то, кому достаётся сервер из реестра, а не
  // про то, какие серверы в реестре бывают.
  assert.ok(!RAW_SERVERS.servers.some((s) => s.name === 'mcpagents'))
  for (const entry of registry.values())
    assert.ok(!(entry.servers ?? []).includes('mcpagents'), `${entry.id} назвал mcpagents`)
})

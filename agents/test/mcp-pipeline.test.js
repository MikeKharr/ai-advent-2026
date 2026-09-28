// Цепочка дня 19 против двух поддельных серверов MCP: модели в ней нет,
// поэтому и заглушки роутера здесь нет — предмет проверки только порядок
// вызовов и перенос данных между шагами.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { loadServers } from '../src/mcp/servers.js'
import { payloadOf, PipelineError, runPipeline, sha256 } from '../src/mcp/pipeline.js'
import { API_TOOL_NAME, apiToolName, buildToolIndex } from '../src/mcp/tool-names.js'
import { loadRegistry } from '../src/registry.js'
import { STAGES } from '../src/runs.js'

/** Поддельный сервер MCP: список инструментов и поведение `tools/call`. */
async function fakeMcp({ tools, call }) {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', async () => {
      const rpc = JSON.parse(raw)
      let result
      if (rpc.method === 'tools/list') result = { tools: tools.map((name) => ({ name, inputSchema: {} })) }
      else if (rpc.method === 'tools/call') result = await call(rpc.params.name, rpc.params.arguments)
      else result = {}
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  }
}

// Форма ответа взята с готовых серверов: `structuredContent` они НЕ кладут,
// JSON уходит строкой в текстовом блоке (`mcpstore/src/rpc.js:94`,
// ветка feat/mcp-news-store).
const packed = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

/** Пара серверов дня 19 в их настоящих формах ответов; `files` — хранилище. */
async function pair({ summary = 'выжимка', corrupt = null, missing = false } = {}) {
  const files = new Map()
  const news = await fakeMcp({
    tools: ['news.search', 'news.summarize'],
    call(name, args) {
      // Формы — как у `mcpnews/src/tools.js`: news.search отдаёт
      // {query, days, found, items}, news.summarize — {text, sha256, count, clipped}.
      if (name === 'news.search')
        return packed({
          query: args.query,
          days: args.days ?? 7,
          found: 1,
          items: [{ title: `о ${args.query}`, url: null, points: 10 }],
        })
      return packed({ text: summary, sha256: sha256(summary), count: 1, clipped: false })
    },
  })
  const store = await fakeMcp({
    tools: ['file.save', 'file.read'],
    call(name, args) {
      // Формы — как у `mcpstore/src/store.js`: save отдаёт
      // {name, bytes, sha256, savedAt, expiresAt, replaced}, read —
      // {found, name, ..., content} либо {found: false, name}.
      if (name === 'file.save') {
        files.set(args.name, corrupt === null ? args.content : corrupt)
        return packed({
          name: args.name,
          bytes: Buffer.byteLength(args.content),
          sha256: sha256(args.content),
          savedAt: new Date(0).toISOString(),
          expiresAt: new Date(1).toISOString(),
          replaced: false,
        })
      }
      const content = missing ? undefined : files.get(args.name)
      // Отсутствие файла хранилище отказом НЕ считает: `found: false` без isError.
      if (content === undefined) return packed({ found: false, name: args.name })
      return packed({
        found: true,
        name: args.name,
        bytes: Buffer.byteLength(content),
        sha256: sha256(content),
        content,
      })
    },
  })
  const { servers } = loadServers(
    {
      servers: [
        { name: 'mcpnews', title: 'Новости', urlEnv: 'NEWS' },
        { name: 'mcpstore', title: 'Файлы', urlEnv: 'STORE' },
      ],
    },
    { NEWS: news.url, STORE: store.url },
  )
  return { servers, files, close: () => Promise.all([news.close(), store.close()]) }
}

test('цепочка идёт в заданном порядке по двум серверам и сверяет sha256', async () => {
  const kit = await pair({ summary: 'три новости про fintech' })
  const events = []

  const result = await runPipeline({ input: { query: 'fintech' }, servers: kit.servers, emit: (e) => events.push(e) })

  assert.deepEqual(
    result.calls.map((c) => [c.tool, c.server]),
    [
      ['news.search', 'mcpnews'],
      ['news.summarize', 'mcpnews'],
      ['file.save', 'mcpstore'],
      ['file.read', 'mcpstore'],
    ],
  )
  assert.equal(result.match, true)
  assert.equal(result.sentSha256, sha256('три новости про fintech'))
  assert.equal(result.readSha256, result.sentSha256)
  assert.equal(result.declaredSha256, result.sentSha256)
  // Отпечаток считается от текста выжимки, а не от JSON-обёртки ответа.
  assert.equal(result.summary, 'три новости про fintech')
  assert.notEqual(result.sentSha256, sha256(JSON.stringify({ text: 'три новости про fintech' })))
  assert.equal(result.savedSha256, result.sentSha256)
  await kit.close()
})

test('запрос посетителя доезжает до первого инструмента, выжимка — до сохранения', async () => {
  const kit = await pair({ summary: 'выжимка о climate tech' })
  await runPipeline({ input: { query: 'climate tech' }, servers: kit.servers })

  // В хранилище лёг текст выжимки, а не обёртка ответа инструмента.
  assert.deepEqual([...kit.files.values()], ['выжимка о climate tech'])
  await kit.close()
})

test('подмена содержимого в хранилище валит запуск расхождением sha256', async () => {
  const kit = await pair({ summary: 'исходная выжимка', corrupt: 'подменено' })

  const error = await runPipeline({ input: { query: 'robotics' }, servers: kit.servers }).then(
    () => null,
    (e) => e,
  )
  assert.ok(error instanceof PipelineError)
  assert.equal(error.reason, 'sha_mismatch')
  // Оба отпечатка остаются на виду: расхождение показывают, а не прячут.
  assert.equal(error.result.sentSha256, sha256('исходная выжимка'))
  assert.equal(error.result.readSha256, sha256('подменено'))
  await kit.close()
})

test('каждый вызов даёт событие стадии rpc с именем сервера и сырыми телами', async () => {
  const kit = await pair()
  const events = []
  await runPipeline({ input: { query: 'fintech' }, servers: kit.servers, emit: (e) => events.push(e) })

  assert.ok(STAGES.includes('rpc'))
  assert.ok(events.every((e) => e.stage === 'rpc'))
  // Два списка инструментов плюс четыре шага цепочки.
  assert.equal(events.length, 6)
  const call = events.find((e) => e.data.method === 'tools/call')
  assert.equal(call.data.server, 'mcpnews')
  assert.equal(JSON.parse(call.data.request).params.name, 'news.search')
  assert.equal(JSON.parse(call.data.response).jsonrpc, '2.0')
  assert.equal(typeof call.data.ms, 'number')
  assert.deepEqual([...new Set(events.map((e) => e.data.server))], ['mcpnews', 'mcpstore'])
  await kit.close()
})

test('пропавший файл (found: false без isError) валит цепочку, а не сверяет пустоту', async () => {
  const kit = await pair({ missing: true })

  const error = await runPipeline({ input: { query: 'fintech' }, servers: kit.servers }).then(
    () => null,
    (e) => e,
  )
  assert.equal(error.reason, 'not_found')
  assert.equal(error.step, 'file.read')
  await kit.close()
})

test('отказ инструмента (isError) останавливает цепочку, а не идёт дальше', async () => {
  const kit = await pair()
  const store = kit.servers.get('mcpstore')
  const original = store.client.callTool
  store.client.callTool = async (name, args) =>
    name === 'file.save'
      ? { isError: true, text: '{"error":"больше 64 КБ"}', content: [], structured: null, trace: { server: 'mcpstore', method: 'tools/call', request: '{}', response: '{}', status: 200, ms: 1, clipped: false } }
      : original(name, args)

  const error = await runPipeline({ input: { query: 'fintech' }, servers: kit.servers }).then(
    () => null,
    (e) => e,
  )
  assert.equal(error.reason, 'tool_error')
  assert.equal(error.step, 'file.save')
  await kit.close()
})

test('недоступный сервер не валит список инструментов, но шаг без инструмента отказывает', async () => {
  const kit = await pair()
  const dead = await fakeMcp({ tools: [], call: () => ({}) })
  const url = dead.url
  await dead.close()
  const { servers } = loadServers(
    {
      servers: [
        { name: 'mcpnews', title: 'Новости', urlEnv: 'NEWS' },
        { name: 'dead', title: 'Мёртвый', urlEnv: 'DEAD' },
      ],
    },
    { NEWS: 'http://127.0.0.1:1/mcp', DEAD: url },
  )
  const error = await runPipeline({ input: { query: 'fintech' }, servers }).then(
    () => null,
    (e) => e,
  )
  assert.equal(error.reason, 'no_tool')
  assert.equal(error.step, 'news.search')
  await kit.close()
})

test('агент без модели живёт в реестре без taskClass и без промпта', () => {
  const agents = loadRegistry({
    agents: [
      {
        id: 'pipeline-agent',
        name: 'Цепочка инструментов',
        version: '1.0.0',
        purpose: 'Цепочка в коде',
        tools: ['mcp'],
        defaults: {},
      },
    ],
  })
  const agent = agents.get('pipeline-agent')
  assert.equal(agent.modelless, true)
  assert.equal(agent.taskClass, null)
  assert.equal(agent.systemPrompt, null)
})

test('агент с моделью по-прежнему обязан назвать taskClass и промпт', () => {
  const entry = {
    id: 'with-model',
    name: 'Агент',
    version: '1.0.0',
    purpose: 'п',
    tools: [],
    systemPrompt: ['строка'],
    defaults: { model: 'anthropic-haiku', maxTokens: 10, temperature: 1, contextTokens: 0 },
  }
  assert.throws(() => loadRegistry({ agents: [{ ...entry }] }), /taskClass/)
  assert.throws(
    () => loadRegistry({ agents: [{ ...entry, taskClass: 'x', systemPrompt: [] }] }),
    /systemPrompt/,
  )
  // Класс задачи у агента без модели — ошибка, а не безвредное лишнее поле:
  // он означал бы вызов модели, которого не будет.
  assert.throws(
    () =>
      loadRegistry({
        agents: [
          { id: 'no-model', name: 'n', version: '1', purpose: 'п', tools: [], taskClass: 'x', defaults: {} },
        ],
      }),
    /taskClass: у агента без модели не бывает/,
  )
  // Параметры модели у агента без модели — ошибка, а не молчаливое умолчание.
  assert.throws(
    () => loadRegistry({ agents: [{ id: 'no-model', name: 'n', version: '1', purpose: 'п', tools: [], defaults: { maxTokens: 10 } }] }),
    /maxTokens/,
  )
})

test('имя инструмента для модели проходит ограничение роутера и разбирается обратно', () => {
  const index = buildToolIndex([
    { name: 'news.search', server: 'mcpnews', inputSchema: { type: 'object' } },
    { name: 'file.save', server: 'mcpstore' },
    // Одноимённые инструменты разных серверов не сталкиваются.
    { name: 'file.save', server: 'day16' },
  ])

  assert.equal(apiToolName('mcpnews', 'news.search'), 'mcpnews__news_search')
  assert.ok(index.table().every((row) => API_TOOL_NAME.test(row.apiName)))
  assert.equal(index.size(), 3)
  assert.deepEqual(index.resolve('mcpstore__file_save'), {
    server: 'mcpstore',
    tool: 'file.save',
    schema: {},
  })
  // Имя, которого нет, модель тоже может назвать: ответ — null, а не бросок.
  assert.equal(index.resolve('чужое'), null)
})

test('непроходное имя инструмента ловится на списке, а не на 400 роутера', () => {
  assert.throws(() => apiToolName('mcpnews', 'плохое имя'), /не проходит ограничение роутера/)
  assert.throws(
    () => buildToolIndex([{ name: 'a', server: 's' }, { name: 'a', server: 's' }]),
    /повторяется/,
  )
})

test('полезная часть ответа читается тремя ступенями и на третьей не падает', () => {
  // 1. `structuredContent`, если сервер его кладёт.
  assert.deepEqual(payloadOf({ structured: { text: 'из поля' }, text: '{"text":"из блока"}' }), {
    text: 'из поля',
  })
  // 2. JSON строкой в текстовом блоке — так отвечают наши серверы.
  assert.deepEqual(payloadOf({ structured: null, text: '{"found":false,"name":"a.txt"}' }), {
    found: false,
    name: 'a.txt',
  })
  // 3. Не JSON — просто текст, без броска.
  assert.deepEqual(payloadOf({ structured: null, text: 'просто текст' }), { text: 'просто текст' })
  assert.deepEqual(payloadOf({ structured: null, text: '[1,2]' }), { text: '[1,2]' })
  assert.deepEqual(payloadOf({}), {})
})

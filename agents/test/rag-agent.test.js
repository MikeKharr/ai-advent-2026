// Агент дня 22 (ADR 2026-10-04-0735): конвейер «поиск → один вызов модели» и
// тот же вызов без поиска.
//
// Предмет файла — ПОРЯДОК и ГРАНИЦА, а не текст ответа:
//   1) поиск стоит ДО модели, и его отказ не доходит до роутера вовсе
//      (I-4 по духу: проверка предшествует расходу);
//   2) режим без RAG к серверу поиска не стучится и потолок эмбеддера не
//      тратит;
//   3) `RAG_KEY` не попадает ни в ответ запуска, ни в его события — при
//      этом служба ключ ПОЛУЧАЕТ (иначе проверка зеленела бы и там, где
//      ключ не подставлен вовсе).
//
// Сервер MCP здесь настоящий `node:http` и говорит настоящим JSON-RPC;
// роутер — поддельный `fetchImpl`, который в части тестов обязан не быть
// вызванным ни разу.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { parseEnv } from '../src/env.js'
import { loadServers } from '../src/mcp/servers.js'
import { createRagAgent, isRefusal, NORAG_SYSTEM, REFUSAL, SEARCH_LIMIT } from '../src/rag-agent.js'
import { createRuns } from '../src/runs.js'
import { REGISTRY } from './fixtures.js'

const ENTRY = REGISTRY.get('rag-agent')
const KEY = 'rag-key-fake-value-32-bytes-long'

/** Пять фрагментов выдачи — столько же, сколько просит агент. */
const RESULTS = Array.from({ length: SEARCH_LIMIT }, (_, at) => ({
  source: `agent_docs/file-${at + 1}.md`,
  title: `Файл ${at + 1}`,
  section: `Раздел ${at + 1}`,
  score: 0.9 - at / 100,
  text: `текст фрагмента ${at + 1}`,
  truncated: false,
}))

const packed = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

/**
 * Поддельная служба `rag` по MCP. Помнит каждый метод, аргументы вызова и
 * ЗАГОЛОВОК авторизации: без последнего проверка «ключа нет в ответе» не
 * различала бы «ключ не утёк» и «ключ не подставлен».
 */
async function fakeRag({ answer = () => packed({ index: INDEX, results: RESULTS }) } = {}) {
  const methods = []
  const args = []
  const auth = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const rpc = JSON.parse(raw)
      methods.push(rpc.method)
      auth.push(req.headers.authorization ?? null)
      let result = {}
      if (rpc.method === 'tools/call') {
        args.push(rpc.params.arguments)
        result = answer(rpc.params.name, rpc.params.arguments)
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    methods,
    args,
    auth,
    url: `http://127.0.0.1:${server.address().port}/rag`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  }
}

const INDEX = { commit: '57a5cd7', strategy: 'structural', chunks: 3167 }

const envOf = (extra = {}) =>
  parseEnv({
    AGENT_KEY: 'agent-key',
    ROUTER_APP_KEY: 'app-agents',
    ROUTER_URL: 'http://router.test:8081',
    STORE_FILE: '',
    ...extra,
  }).env

/** Ответ поддельного роутера: один текст, одно usage, один остаток бюджета. */
const routerReply = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    text,
    usage: { inputTokens: 4200, outputTokens: 120 },
    provider: { model: 'claude-haiku-4-5' },
    truncated: false,
    durationMs: 900,
    budgetLeft: { costUsd: 9.5 },
  }),
})

/** Собирает агента на живом сервере MCP и поддельном роутере. */
function build({ rag, fetchImpl, env = envOf(), key = KEY }) {
  const runs = createRuns()
  const { servers } = loadServers(
    JSON.parse(
      JSON.stringify({
        servers: [{ name: 'rag', title: 'Индекс проекта', urlEnv: 'MCP_RAG_URL', keyEnv: 'RAG_KEY' }],
      }),
    ),
    { MCP_RAG_URL: rag?.url ?? '', RAG_KEY: key },
  )
  const agent = createRagAgent({ agent: ENTRY, servers, runs, env, fetchImpl, log: () => {} })
  return { runs, agent }
}

async function run(agent, runs, input) {
  const parsed = agent.parseInput(input)
  assert.ok(parsed.ok, parsed.message)
  const created = runs.create({ agent: ENTRY, input: parsed.input })
  await agent.execute(created)
  return runs.snapshot(created.id)
}

test('режим с RAG: поиск сходил, пять фрагментов ушли модели, ответ отдан', async () => {
  const rag = await fakeRag()
  let body = null
  const { runs, agent } = build({
    rag,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return routerReply('По [1] agent_docs/file-1.md — вот ответ.')
    },
  })
  const snapshot = await run(agent, runs, { question: 'что такое DoD', mode: 'rag' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  // Поиск был, и ровно один.
  assert.deepEqual(rag.methods, ['tools/call'])
  assert.equal(rag.args[0].limit, SEARCH_LIMIT)
  assert.equal(rag.args[0].query, 'что такое DoD')
  // Вызов модели один, с промптом реестра и фрагментами во входе.
  assert.equal(body.provider, 'anthropic-haiku')
  assert.equal(body.taskClass, 'layered_dialogue')
  assert.equal(body.answerTokens, 800)
  assert.equal(body.system, ENTRY.systemPrompt)
  for (const item of RESULTS) assert.ok(body.input.includes(item.text), `фрагмент не ушёл: ${item.source}`)
  assert.ok(body.input.includes('[1] agent_docs/file-1.md'))
  assert.ok(body.input.includes('что такое DoD'))

  const result = snapshot.result
  assert.equal(result.mode, 'rag')
  assert.equal(result.refused, false)
  assert.equal(result.sources.length, SEARCH_LIMIT)
  // Текст фрагмента в ответе запуска — решение владельца 2026-10-04 (В2).
  assert.deepEqual(result.sources[0], {
    n: 1,
    source: 'agent_docs/file-1.md',
    section: 'Раздел 1',
    score: 0.9,
    text: 'текст фрагмента 1',
    truncated: false,
  })
  assert.deepEqual(result.index, INDEX)
  assert.equal(result.tokens, 4320)
  assert.equal(result.budgetLeftUsd, 9.5)
  // Сырые тела вызова поиска — решение владельца 2026-10-04 (В3).
  assert.equal(result.rpc.method, 'tools/call')
  assert.ok(result.rpc.request.includes('project.search'))
  assert.ok(result.rpc.response.includes('agent_docs/file-1.md'))
})

test('отказ поиска — отказ запуска БЕЗ вызова модели', async () => {
  // `isError` службы: так приходят NO_INDEX, NO_STRATEGY_INDEX,
  // DAILY_EXHAUSTED и отказ окна лимитера (`rag/rpc.py`, `tool_error`).
  const rag = await fakeRag({
    answer: () => ({ isError: true, content: [{ type: 'text', text: 'индекса нет: сборка не завершилась' }] }),
  })
  const { runs, agent } = build({
    rag,
    // Роутер вызван быть не может: вызов до проверки — и есть нарушение I-4.
    fetchImpl: () => assert.fail('модель вызвана при отказавшем поиске'),
  })
  const snapshot = await run(agent, runs, { question: 'сколько стоит приложение', mode: 'rag' })
  await rag.close()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'search_refused')
  assert.match(snapshot.error.message, /индекса нет/)
  // Запуск ничего не стоил: день вернёт слот лимитера по этому признаку.
  assert.equal(snapshot.error.paidNothing, true)
  // Ни одного события вызова модели в ленте.
  assert.deepEqual(
    snapshot.events.filter((e) => e.stage === 'llm_call'),
    [],
  )
})

test('служба поиска недоступна — тоже отказ до модели, с причиной сети', async () => {
  const rag = await fakeRag()
  const url = rag.url
  await rag.close()
  const { runs, agent } = build({
    rag: { url },
    fetchImpl: () => assert.fail('модель вызвана при недоступном поиске'),
  })
  const snapshot = await run(agent, runs, { question: 'что такое Recall@5', mode: 'rag' })

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'search_failed')
  assert.equal(snapshot.error.paidNothing, true)
})

test('адреса службы нет — отказ до модели, а не «ответ по памяти»', async () => {
  const { runs, agent } = build({
    rag: { url: '' },
    fetchImpl: () => assert.fail('модель вызвана без настроенного поиска'),
  })
  const snapshot = await run(agent, runs, { question: 'что такое MCP', mode: 'rag' })

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'search_unavailable')
})

test('пустая выдача поиска — модель не вызывается: отвечать не по чему', async () => {
  const rag = await fakeRag({ answer: () => packed({ index: INDEX, results: [] }) })
  const { runs, agent } = build({
    rag,
    fetchImpl: () => assert.fail('модель вызвана на пустой выдаче'),
  })
  const snapshot = await run(agent, runs, { question: 'вопрос', mode: 'rag' })
  await rag.close()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'search_empty')
})

test('режим без RAG: к службе поиска не ушло ничего, промпт другой', async () => {
  const rag = await fakeRag()
  let body = null
  const { runs, agent } = build({
    rag,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return routerReply('По памяти: кажется, так.')
    },
  })
  const snapshot = await run(agent, runs, { question: 'что такое MCP', mode: 'norag' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  // ГЛАВНОЕ: суточный потолок эмбеддера этот режим не тратит вовсе.
  assert.deepEqual(rag.methods, [])
  assert.equal(body.system, NORAG_SYSTEM)
  assert.notEqual(body.system, ENTRY.systemPrompt)
  assert.ok(!body.input.includes('<fragments>'))
  assert.equal(snapshot.result.mode, 'norag')
  assert.deepEqual(snapshot.result.sources, [])
  assert.equal(snapshot.result.index, null)
  assert.equal(snapshot.result.rpc, null)
  assert.equal(snapshot.result.refused, false)
})

test('ключ RAG_KEY не попадает ни в ответ запуска, ни в события — а служба его получает', async () => {
  const rag = await fakeRag()
  const { runs, agent } = build({
    rag,
    fetchImpl: async () => routerReply('ответ'),
  })
  const snapshot = await run(agent, runs, { question: 'вопрос про ключи', mode: 'rag' })
  await rag.close()

  // Различение гипотез: ключ ДОШЁЛ до службы заголовком. Без этой строки
  // проверка ниже зеленела бы и там, где ключ не подставлен вовсе.
  assert.deepEqual(rag.auth, [`Bearer ${KEY}`])
  // И его нет ни в одном поле того, что видит страница: ни в результате
  // (включая сырые тела JSON-RPC), ни в событиях ленты.
  assert.ok(!JSON.stringify(snapshot.result).includes(KEY), 'ключ в ответе запуска')
  assert.ok(!JSON.stringify(snapshot.events).includes(KEY), 'ключ в событиях запуска')
  // И отдельно — что проверять было что: тела в ответе и в ленте есть.
  assert.ok(snapshot.result.rpc.request.includes('project.search'))
  assert.ok(snapshot.events.some((e) => e.stage === 'rpc' && e.data.response.includes('results')))
})

test('фраза отказа строгого промпта приезжает признаком, а не подстрокой для страницы', async () => {
  const rag = await fakeRag()
  const { runs, agent } = build({
    rag,
    fetchImpl: async () => routerReply(`${REFUSAL}. Нашлось: 1 — про DoD.`),
  })
  const snapshot = await run(agent, runs, { question: 'сколько стоит приложение', mode: 'rag' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded')
  assert.equal(snapshot.result.refused, true)
  // Фраза живёт в одном месте с промптом: промпт реестра её требует дословно.
  assert.ok(ENTRY.systemPrompt.includes(REFUSAL), 'промпт реестра не требует фразы отказа')
  assert.equal(isRefusal('ответ по фрагментам'), false)
})

test('стратегия берётся из окружения службы и уходит в аргументы поиска', async () => {
  const rag = await fakeRag()
  const { runs, agent } = build({
    rag,
    env: envOf({ RAG_STRATEGY: 'fixed' }),
    fetchImpl: async () => routerReply('ответ'),
  })
  await run(agent, runs, { question: 'вопрос', mode: 'rag' })
  await rag.close()

  assert.equal(rag.args[0].strategy, 'fixed')
  // Умолчание — то же, что у службы (`rag/tools.py`, DEFAULT_STRATEGY).
  assert.equal(envOf().RAG_STRATEGY, 'structural')
})

test('вход запуска: вопрос обязателен и ограничен, режим называется явно', () => {
  const { agent } = build({ rag: { url: 'http://rag.test/rag' }, fetchImpl: () => assert.fail() })
  assert.equal(agent.parseInput({ question: '', mode: 'rag' }).ok, false)
  assert.equal(agent.parseInput({ question: 'a'.repeat(601), mode: 'rag' }).ok, false)
  assert.equal(agent.parseInput({ question: 'a'.repeat(600), mode: 'rag' }).ok, true)
  // Умолчания у режима нет: запуск без названного режима — запуск, про
  // который неизвестно, с чем его сравнивают.
  assert.equal(agent.parseInput({ question: 'вопрос' }).ok, false)
  assert.equal(agent.parseInput({ question: 'вопрос', mode: 'both' }).ok, false)
})

test('описание агента не выносит наружу ни промпт, ни адрес, ни ключ', async () => {
  const { agent } = build({ rag: { url: 'http://rag.test/rag' }, fetchImpl: () => assert.fail() })
  const described = await agent.describe()
  assert.equal(described.id, 'rag-agent')
  assert.deepEqual(described.servers, ['rag'])
  assert.deepEqual(described.modes, ['rag', 'norag'])
  const text = JSON.stringify(described)
  assert.equal(described.systemPrompt, undefined)
  assert.equal(/https?:\/\//.test(text), false)
  assert.equal(text.includes(KEY), false)
})

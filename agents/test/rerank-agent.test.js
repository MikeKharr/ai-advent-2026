// Агент дня 23 (ADR 2026-10-05-0544, п. 1): второй этап отбора.
//
// Предмет файла — ПОРЯДОК, ГРАНИЦА и НУМЕРАЦИЯ, а не качество отбора:
//   1) отказ поиска обрывает запуск, не оплатив НИ ОДНОГО вызова модели —
//      в обоих новых режимах, в том числе в `rewrite`, где переписывание
//      так и тянет поставить первым (I-4 по духу);
//   2) ноль релевантных кандидатов — исход БЕЗ вызова модели ответа:
//      реранкер оплачен, ответ — нет;
//   3) в промпт ответа уходят только оставшиеся, и под теми же номерами,
//      под которыми они стоят в `candidates` ответа запуска;
//   4) `RAG_KEY` не попадает ни в ответ запуска, ни в его события — при
//      этом служба ключ ПОЛУЧАЕТ.
//
// Сервер MCP — настоящий `node:http` с настоящим JSON-RPC, как в дне 22;
// роутер — поддельный `fetchImpl`, который в части тестов обязан не быть
// вызванным ни разу.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { parseEnv } from '../src/env.js'
import { loadServers } from '../src/mcp/servers.js'
import {
  applyRerank,
  KEEP_MAX,
  mergeCandidates,
  parseRewrite,
  WIDE_LIMIT,
} from '../src/rag/retrieve.js'
import { createRagAgent } from '../src/rag-agent.js'
import { createRuns } from '../src/runs.js'
import { REGISTRY } from './fixtures.js'

const ENTRY = REGISTRY.get('rerank-agent')
const KEY = 'rag-key-fake-value-32-bytes-long'
const INDEX = { commit: '4de2d6e', strategy: 'structural', chunks: 3167 }

/** Десять кандидатов по убыванию близости — столько же, сколько просит агент. */
const RESULTS = Array.from({ length: WIDE_LIMIT }, (_, at) => ({
  source: `agent_docs/file-${at + 1}.md`,
  section: `Раздел ${at + 1}`,
  score: Number((0.6 - at / 100).toFixed(3)),
  text: `текст фрагмента ${at + 1}`,
  truncated: false,
}))

const packed = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

/** Поддельная служба `rag`: помнит метод, аргументы и заголовок авторизации. */
async function fakeRag({ answer = () => packed({ index: INDEX, results: RESULTS }) } = {}) {
  const calls = []
  const auth = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const rpc = JSON.parse(raw)
      auth.push(req.headers.authorization ?? null)
      let result = {}
      if (rpc.method === 'tools/call') {
        calls.push(rpc.params.arguments)
        result = answer(rpc.params.name, rpc.params.arguments)
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    calls,
    auth,
    url: `http://127.0.0.1:${server.address().port}/rag`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  }
}

const envOf = () =>
  parseEnv({
    AGENT_KEY: 'agent-key',
    ROUTER_APP_KEY: 'app-agents',
    ROUTER_URL: 'http://router.test:8081',
    STORE_FILE: '',
  }).env

const routerReply = (fields) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    text: '',
    usage: { inputTokens: 1200, outputTokens: 60 },
    provider: { model: 'claude-haiku-4-5' },
    truncated: false,
    durationMs: 400,
    budgetLeft: { costUsd: 9.5 },
    ...fields,
  }),
})

/**
 * Поддельный роутер, отвечающий ПО ОЧЕРЕДИ и запоминающий тела запросов.
 * Очередь, а не угадывание по телу: тест обязан видеть, что вызовов было
 * ровно столько, сколько он разрешил, и в том порядке.
 */
function fakeRouter(queue) {
  const bodies = []
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      const next = queue[bodies.length - 1]
      assert.ok(next, `лишний вызов роутера №${bodies.length}: ${body.taskClass}`)
      return routerReply(next)
    },
  }
}

/** Оценки реранкера: по умолчанию 2 для первых трёх номеров, 0 остальным. */
const ratings = (pairs) => ({ json: { ratings: pairs.map(([n, relevance]) => ({ n, relevance })) } })

function build({ rag, fetchImpl, key = KEY }) {
  const runs = createRuns()
  const { servers } = loadServers(
    { servers: [{ name: 'rag', title: 'Индекс проекта', urlEnv: 'MCP_RAG_URL', keyEnv: 'RAG_KEY' }] },
    { MCP_RAG_URL: rag?.url ?? '', RAG_KEY: key },
  )
  const agent = createRagAgent({
    agent: ENTRY,
    servers,
    runs,
    env: envOf(),
    fetchImpl,
    log: () => {},
    pipeline: true,
  })
  return { runs, agent }
}

async function run(agent, runs, input) {
  const parsed = agent.parseInput(input)
  assert.ok(parsed.ok, parsed.message)
  const created = runs.create({ agent: ENTRY, input: parsed.input })
  await agent.execute(created)
  return runs.snapshot(created.id)
}

test('режимов три, и режима norag среди них нет', async () => {
  const { agent } = build({ rag: null, fetchImpl: async () => assert.fail('роутер') })
  const described = await agent.describe()
  assert.deepEqual(described.modes, ['rag', 'rerank', 'rewrite'])
  assert.equal(agent.parseInput({ question: 'что', mode: 'norag' }).ok, false)
})

test('режим rerank: десять кандидатов, один вызов реранкера, в ответ ушли только оставшиеся', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    ratings([
      [1, 0],
      [2, 2],
      [3, 1],
      [4, 0],
      [5, 0],
      [6, 0],
      [7, 2],
      [8, 0],
      [9, 0],
      [10, 0],
    ]),
    { text: 'По [2] agent_docs/file-2.md — вот ответ.' },
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'что такое DoD', mode: 'rerank' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  // Поиск один, и он просит десять, а не пять.
  assert.equal(rag.calls.length, 1)
  assert.equal(rag.calls[0].limit, WIDE_LIMIT)
  // Вызовов модели ровно два: реранкер и ответ. Реранкер — со схемой.
  assert.equal(router.bodies.length, 2)
  const [rerank, answer] = router.bodies
  assert.ok(rerank.schema, 'реранкер ушёл без схемы')
  assert.equal(rerank.answerTokens, 200)
  for (const item of RESULTS) assert.ok(rerank.input.includes(item.text), `кандидат не ушёл: ${item.source}`)
  // В промпте ответа — только оставшиеся, под номерами отбора.
  assert.ok(answer.input.includes('[2] agent_docs/file-2.md'))
  assert.ok(answer.input.includes('[7] agent_docs/file-7.md'))
  assert.ok(answer.input.includes('[3] agent_docs/file-3.md'))
  assert.ok(!answer.input.includes('agent_docs/file-1.md'), 'отсеянный кандидат ушёл модели')
  assert.equal(answer.answerTokens, 800)

  const result = snapshot.result
  assert.equal(result.outcome, 'answered')
  assert.equal(result.rewritten, null)
  assert.equal(result.candidates.length, WIDE_LIMIT)
  // Порядок оставшихся — по релевантности, при равенстве по близости.
  assert.deepEqual(
    result.sources.map((item) => item.n),
    [2, 7, 3],
  )
  assert.deepEqual(
    result.candidates.filter((item) => item.kept).map((item) => item.n),
    [2, 3, 7],
  )
  assert.equal(result.candidates[0].relevance, 0)
  assert.equal(result.candidates[1].relevance, 2)
})

test('режим rewrite: два поиска, объединение выдач, переписанный вопрос в ответе запуска', async () => {
  const extra = {
    source: 'agent_docs/guides/dod.md',
    section: 'Критерии',
    score: 0.71,
    text: 'текст про критерии приёмки',
    truncated: false,
  }
  const rag = await fakeRag({
    answer: (_name, args) =>
      args.query === 'критерии приёмки DoD'
        ? packed({ index: INDEX, results: [extra, RESULTS[0]] })
        : packed({ index: INDEX, results: RESULTS }),
  })
  const router = fakeRouter([
    { text: 'критерии приёмки DoD' },
    ratings([
      [1, 2],
      [2, 1],
    ]),
    { text: 'По [1] agent_docs/guides/dod.md — вот ответ.' },
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'а что там с DoD?', mode: 'rewrite' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  // Два поиска: по исходному вопросу и по переписанному. Исходный — ПЕРВЫЙ.
  assert.deepEqual(
    rag.calls.map((args) => args.query),
    ['а что там с DoD?', 'критерии приёмки DoD'],
  )
  assert.equal(router.bodies[0].taskClass, 'summarize')
  assert.equal(snapshot.result.rewritten, 'критерии приёмки DoD')
  // Найденное переписыванием стоит первым: его близость выше.
  const first = snapshot.result.candidates[0]
  assert.equal(first.source, 'agent_docs/guides/dod.md')
  assert.equal(first.from, 'rewritten')
  // Фрагмент, который нашли оба запроса, помечен `both` и не задвоился.
  const both = snapshot.result.candidates.filter((item) => item.source === 'agent_docs/file-1.md')
  assert.equal(both.length, 1)
  assert.equal(both[0].from, 'both')
  assert.equal(snapshot.result.candidates.length, WIDE_LIMIT)
})

for (const mode of ['rerank', 'rewrite']) {
  test(`режим ${mode}: честный отказ модели «в фрагментах ответа нет» попадает в поле refused`, async () => {
    const rag = await fakeRag()
    const queue = [
      ratings([
        [1, 1],
        [2, 1],
      ]),
      { text: 'В найденных фрагментах ответа нет. Нашлось: про DoD.' },
    ]
    if (mode === 'rewrite') queue.unshift({ text: 'критерии приёмки' })
    const router = fakeRouter(queue)
    const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
    const snapshot = await run(agent, runs, { question: 'сколько стоит билет', mode })
    await rag.close()

    assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
    assert.equal(snapshot.result.refused, true, 'отказ модели потерян')
  })
}

for (const mode of ['rerank', 'rewrite']) {
  test(`режим ${mode}: отказ поиска — отказ запуска, модель не вызывалась ни разу`, async () => {
    const rag = await fakeRag({
      answer: () => ({
        isError: true,
        content: [{ type: 'text', text: 'NO_INDEX: индекс не собран' }],
      }),
    })
    let routerCalls = 0
    const { runs, agent } = build({
      rag,
      fetchImpl: async () => {
        routerCalls += 1
        return routerReply({ text: 'не должно случиться' })
      },
    })
    const snapshot = await run(agent, runs, { question: 'что такое DoD', mode })
    await rag.close()

    assert.equal(snapshot.status, 'failed')
    assert.equal(snapshot.error.code, 'search_refused')
    assert.equal(snapshot.error.paidNothing, true)
    assert.equal(routerCalls, 0, 'модель вызвали после отказа поиска')
    assert.ok(snapshot.error.message.includes('Модель не вызывалась'))
  })
}

/**
 * Второй поиск режима `rewrite` запуск НЕ валит: кандидаты исходного
 * вопроса уже есть, а переписывание уже оплачено. Параметрический тест выше
 * роняет ПЕРВЫЙ поиск — здесь падает именно второй (находки `compliance` и
 * `reviewer` к PR #311, B2).
 */
for (const [name, second, expected] of [
  ['пустая выдача', () => packed({ index: INDEX, results: [] }), 'empty'],
  [
    'отказ службы',
    () => ({ isError: true, content: [{ type: 'text', text: 'DAILY_EXHAUSTED: потолок на сутки' }] }),
    'failed',
  ],
]) {
  test(`режим rewrite: ${name} на втором поиске — запуск идёт дальше по кандидатам исходного вопроса`, async () => {
    const rag = await fakeRag({
      answer: (_name, args) =>
        args.query === 'критерии приёмки' ? second() : packed({ index: INDEX, results: RESULTS }),
    })
    const router = fakeRouter([
      { text: 'критерии приёмки' },
      ratings([
        [1, 2],
        [2, 1],
      ]),
      { text: 'По [1] agent_docs/file-1.md — вот ответ.' },
    ])
    const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
    const snapshot = await run(agent, runs, { question: 'а что там с DoD?', mode: 'rewrite' })
    await rag.close()

    assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
    assert.equal(snapshot.result.rewriteSearch, expected)
    assert.equal(snapshot.result.rewritten, 'критерии приёмки')
    // Кандидаты — все десять от исходного вопроса, ответ собран и оплачен
    // не зря.
    assert.equal(snapshot.result.candidates.length, WIDE_LIMIT)
    assert.ok(snapshot.result.candidates.every((item) => item.from === 'original'))
    assert.equal(router.bodies.length, 3)
    // Случившееся названо в ленте, а не замолчано.
    assert.ok(
      snapshot.events.some((e) => e.level === 'warn' && e.data?.rewriteSearch === expected),
      'предупреждения о втором поиске нет в ленте',
    )
  })
}

test('ноль релевантных: реранкер оплачен, модель ответа не вызывалась, кандидаты показаны', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([ratings(RESULTS.map((_, at) => [at + 1, 0]))])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'сколько стоит билет в Бангкок', mode: 'rerank' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  assert.equal(router.bodies.length, 1, 'модель ответа вызвали при нуле релевантных')
  assert.equal(snapshot.result.outcome, 'unknown_filter')
  assert.equal(snapshot.result.answer, null)
  assert.deepEqual(snapshot.result.sources, [])
  assert.equal(snapshot.result.candidates.length, WIDE_LIMIT)
  assert.ok(snapshot.result.candidates.every((item) => item.kept === false))
})

test('реранкер ответил без оценок — отказ запуска оплаченным вызовом, модель ответа не вызывалась', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([{ text: '{}', json: { нет: 'оценок' } }])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'что такое DoD', mode: 'rerank' })
  await rag.close()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'rerank_invalid')
  assert.equal(snapshot.error.paidNothing, false)
  assert.equal(router.bodies.length, 1)
})

test('ключ RAG_KEY не попадает ни в ответ запуска, ни в события — но службе он уходит', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    ratings([
      [1, 2],
      [2, 1],
    ]),
    { text: 'По [1] agent_docs/file-1.md — вот ответ.' },
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'что такое DoD', mode: 'rerank' })
  await rag.close()

  // Служба ключ получила: иначе проверка зеленела бы и там, где его нет вовсе.
  assert.deepEqual(rag.auth, [`Bearer ${KEY}`])
  for (const text of [JSON.stringify(snapshot.result), JSON.stringify(snapshot.events)])
    assert.ok(!text.includes(KEY), 'ключ RAG_KEY утёк наружу')
  // И в телах JSON-RPC, которые едут на страницу, его тоже нет.
  assert.ok(!JSON.stringify(snapshot.result.rpc).includes(KEY))
})

test('объединение: тождество по source+section, близость максимальная, не больше десяти', () => {
  const a = [
    { source: 'a.md', section: 'раз', score: 0.4, text: 'a' },
    { source: 'b.md', section: 'два', score: 0.3, text: 'b' },
  ]
  const b = [
    { source: 'a.md', section: 'раз', score: 0.9, text: 'a' },
    { source: 'c.md', section: 'три', score: 0.5, text: 'c' },
  ]
  const merged = mergeCandidates(a, b)
  assert.deepEqual(
    merged.map((item) => [item.n, item.source, item.score, item.from]),
    [
      [1, 'a.md', 0.9, 'both'],
      [2, 'c.md', 0.5, 'rewritten'],
      [3, 'b.md', 0.3, 'original'],
    ],
  )
  assert.equal(mergeCandidates(RESULTS, RESULTS.map((r) => ({ ...r, source: `${r.source}x` }))).length, WIDE_LIMIT)
})

test('отбор: пропущенный номер — ноль, чужой номер отброшен, оставшихся не больше пяти', () => {
  const candidates = RESULTS.map((item, at) => ({ ...item, n: at + 1 }))
  const { candidates: marked, kept } = applyRerank(candidates, [
    { n: 99, relevance: 2 },
    ...candidates.map((item) => ({ n: item.n, relevance: 2 })).slice(0, 7),
  ])
  assert.equal(kept.length, KEEP_MAX)
  assert.equal(marked.length, WIDE_LIMIT)
  // Номера 8–10 модель не назвала: у них ноль, и они отсеяны.
  assert.equal(marked[7].relevance, 0)
  assert.equal(marked[7].kept, false)
})

test('переписывание: пустое, слишком длинное и совпавшее с вопросом — не запрос', () => {
  assert.equal(parseRewrite('  ', 'вопрос'), null)
  assert.equal(parseRewrite('я'.repeat(400), 'вопрос'), null)
  assert.equal(parseRewrite(' Вопрос ', 'вопрос'), null)
  assert.equal(parseRewrite('«критерии приёмки DoD»', 'что такое DoD'), 'критерии приёмки DoD')
})

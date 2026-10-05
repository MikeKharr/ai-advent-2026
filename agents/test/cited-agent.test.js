// Агент дня 24 (ADR 2026-10-05-0544, п. 2): ответ по схеме, цитаты
// сверяются механически, четыре исхода.
//
// Предмет файла — то, что ломается ТИХО, а не качество ответов:
//   1) цитата, которой во фрагменте нет, помечается `verified: false`, и
//      признак `quotes_verbatim` от неё краснеет — дословность проверяет код,
//      а не старательность модели;
//   2) отказ поиска обрывает запуск, НЕ оплатив ни одного вызова модели
//      (I-4 по духу: проверка предшествует расходу);
//   3) пустой отбор — ВЫЗОВ МОДЕЛИ «не знаю» с уточняющим вопросом (решение
//      владельца Р5(б)), а не ответ по памяти и не шаблонная строка;
//   4) ответ не по форме (неразобранный, чужой номер источника, ответ там,
//      где фрагментов не было) — отказ запуска, и он оплачен.
//
// Сервер MCP — настоящий `node:http` с настоящим JSON-RPC, как в днях 22–23;
// роутер — поддельный `fetchImpl`, который в части тестов обязан не быть
// вызванным ни разу.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { parseEnv } from '../src/env.js'
import { loadServers } from '../src/mcp/servers.js'
import { ANSWER_SCHEMA, flatten, readCited, verifyQuotes } from '../src/rag/cited.js'
import { WIDE_LIMIT } from '../src/rag/retrieve.js'
import { createRagAgent } from '../src/rag-agent.js'
import { createRuns } from '../src/runs.js'
import { REGISTRY } from './fixtures.js'

const ENTRY = REGISTRY.get('cited-agent')
const KEY = 'rag-key-fake-value-32-bytes-long'
const INDEX = { commit: '4de2d6e', strategy: 'structural', chunks: 3167 }

/** Десять кандидатов по убыванию близости — столько же, сколько просит агент. */
const RESULTS = Array.from({ length: WIDE_LIMIT }, (_, at) => ({
  source: `agent_docs/file-${at + 1}.md`,
  section: `Раздел ${at + 1}`,
  score: Number((0.6 - at / 100).toFixed(3)),
  text: `Во фрагменте ${at + 1} сказано: гейт мержа держит ревьюер номер ${at + 1}.`,
  truncated: false,
}))

const packed = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

/** Поддельная служба `rag`. */
async function fakeRag({ answer = () => packed({ index: INDEX, results: RESULTS }) } = {}) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const rpc = JSON.parse(raw)
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

/** Поддельный роутер, отвечающий ПО ОЧЕРЕДИ: лишний вызов — провал теста. */
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

const ratings = (pairs) => ({ json: { ratings: pairs.map(([n, relevance]) => ({ n, relevance })) } })

/** Ответ по схеме так, как его отдаёт роутер: разобранный объект полем `json`. */
const cited = (fields) => ({
  text: JSON.stringify(fields),
  json: { status: 'answered', answer: '', sources: [], quotes: [], clarification: null, ...fields },
})

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
    pipeline: 'cited',
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

/** Оценки, оставляющие ровно фрагменты 1 и 2. */
const KEEP_TWO = ratings([
  [1, 2],
  [2, 1],
  [3, 0],
  [4, 0],
  [5, 0],
  [6, 0],
  [7, 0],
  [8, 0],
  [9, 0],
  [10, 0],
])

test('режимов два, и режима rag среди них нет', async () => {
  const { agent } = build({ rag: null, fetchImpl: async () => assert.fail('роутер') })
  const described = await agent.describe()
  assert.deepEqual(described.modes, ['rerank', 'rewrite'])
  assert.equal(agent.parseInput({ question: 'что', mode: 'rag' }).ok, false)
  assert.equal(agent.parseInput({ question: 'что', mode: 'norag' }).ok, false)
})

test('ответ по схеме: вызов ушёл со схемой, цитаты подтверждены, checks зелёные', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    KEEP_TWO,
    cited({
      status: 'answered',
      answer: 'Гейт мержа держит ревьюер [1].',
      sources: [{ n: 1, source: 'agent_docs/file-1.md', section: 'Раздел 1' }],
      // Цитата — дословный кусок текста фрагмента 1, но с иным регистром и
      // лишними пробелами: нормализация их прощает, слова — нет.
      quotes: [{ n: 1, text: '  Гейт   мержа   держит   ревьюер  номер 1.' }],
    }),
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'кто держит гейт мержа', mode: 'rerank' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  assert.equal(router.bodies.length, 2)
  const answerBody = router.bodies[1]
  // Форма — требованием к провайдеру, а не просьбой в промпте.
  assert.deepEqual(answerBody.schema, ANSWER_SCHEMA)

  const result = snapshot.result
  assert.equal(result.outcome, 'answered')
  assert.equal(result.status, 'answered')
  assert.equal(result.answer, 'Гейт мержа держит ревьюер [1].')
  assert.deepEqual(result.cited, [
    {
      n: 1,
      source: 'agent_docs/file-1.md',
      section: 'Раздел 1',
      claimedSource: 'agent_docs/file-1.md',
      claimedSection: 'Раздел 1',
    },
  ])
  assert.equal(result.quotes[0].verified, true)
  // Признак отказа у дня 24 — из поля схемы: ответ с цитатами отказом не
  // считается (находка `compliance` к PR #311, B1, в своей форме).
  assert.equal(result.refused, false)
  assert.deepEqual(result.checks, {
    sources_present: true,
    quotes_present: true,
    quotes_verbatim: true,
    cited_exact: true,
  })
  // Отобранные фрагменты с текстами на месте: страница показывает цитату
  // рядом с тем, из чего её проверяли.
  assert.deepEqual(
    result.sources.map((item) => item.n),
    [1, 2],
  )
})

test('МУТАЦИЯ ДОСЛОВНОСТИ: переписанная цитата не подтверждается, quotes_verbatim красный', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    KEEP_TWO,
    cited({
      status: 'answered',
      answer: 'Гейт мержа держит архитектор [1].',
      sources: [{ n: 1, source: 'agent_docs/file-1.md', section: 'Раздел 1' }],
      // Одно слово заменено — во фрагменте 1 стоит «ревьюер», не «архитектор».
      quotes: [{ n: 1, text: 'гейт мержа держит архитектор номер 1.' }],
    }),
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'кто держит гейт мержа', mode: 'rerank' })
  await rag.close()

  const result = snapshot.result
  assert.equal(result.quotes[0].verified, false)
  assert.equal(result.checks.quotes_verbatim, false)
  // Ни одной подтверждённой цитаты при `answered` — исход `unsupported`,
  // а не `answered`: это и есть разница с днём 22, где такой ответ был
  // неотличим от честного.
  assert.equal(result.outcome, 'unsupported')
  assert.ok(
    snapshot.events.some((event) => event.title === 'Цитата не подтверждена'),
    'в ленте нет предупреждения о неподтверждённой цитате',
  )
})

test('цитата из чужого фрагмента не подтверждается: номер цитаты — не украшение', () => {
  const kept = [{ n: 2, text: 'Во фрагменте 2 сказано: гейт мержа держит ревьюер номер 2.' }]
  const checked = verifyQuotes(
    [
      { n: 2, text: 'держит ревьюер номер 2' },
      // Текст дословный, но номер чужой — проверять не по чему.
      { n: 7, text: 'держит ревьюер номер 2' },
      { n: 2, text: '' },
    ],
    kept,
  )
  assert.deepEqual(
    checked.map((item) => item.verified),
    [true, false, false],
  )
})

test('МУТАЦИЯ РАСХОДА: отказ поиска — запуск провален, роутер не вызван ни разу', async () => {
  const rag = await fakeRag({
    answer: () => ({ content: [{ type: 'text', text: 'индекса нет' }], isError: true }),
  })
  const router = fakeRouter([])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'кто держит гейт мержа', mode: 'rewrite' })
  await rag.close()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'search_refused')
  assert.equal(snapshot.error.paidNothing, true)
  // Режим `rewrite` так и тянет поставить переписывание первым — и тогда
  // отказ поиска был бы ОПЛАЧЕН. Ноль вызовов — это и есть I-4 по духу.
  assert.equal(router.bodies.length, 0)
})

test('МУТАЦИЯ ПУСТОГО ОТБОРА: ноль релевантных — вызов «не знаю» без фрагментов и с уточнением', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    ratings(RESULTS.map((_, at) => [at + 1, 0])),
    cited({
      status: 'unknown',
      answer: 'Ответа на это в найденных фрагментах нет.',
      clarification: 'Какую единицу проекта вы имеете в виду — агента, роутер или службу поиска?',
    }),
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'как собрать ракету', mode: 'rerank' })
  await rag.close()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  // Вызовов два: реранкер и формулировка «не знаю». Модель ВЫЗВАНА — это
  // решение владельца Р5(б), а не шаблонная строка дня 23.
  assert.equal(router.bodies.length, 2)
  const unknownBody = router.bodies[1]
  // Входа с фрагментами у неё нет: отвечать по тексту корпуса нечем.
  assert.ok(!unknownBody.input.includes('<fragments>'), 'модели ушёл блок фрагментов')
  assert.ok(unknownBody.input.includes('<rejected>'), 'модели не ушли отброшенные кандидаты')
  for (const item of RESULTS)
    assert.ok(!unknownBody.input.includes(item.text), `текст фрагмента ушёл: ${item.source}`)
  assert.ok(unknownBody.input.includes('agent_docs/file-1.md'))

  const result = snapshot.result
  assert.equal(result.outcome, 'unknown_filter')
  assert.equal(result.status, 'unknown')
  assert.ok(result.clarification.length > 0, 'уточняющего вопроса нет')
  // «Не знаю» обязано быть видно признаком, а не только исходом: иначе
  // страница и мера дня считали бы его обычным ответом.
  assert.equal(result.refused, true)
  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.quotes, [])
  assert.deepEqual(result.checks, {
    sources_present: false,
    quotes_present: false,
    quotes_verbatim: false,
    cited_exact: false,
  })
  assert.equal(result.candidates.length, WIDE_LIMIT)
})

test('пустой отбор и ответ по памяти — отказ формы, и он оплачен', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    ratings(RESULTS.map((_, at) => [at + 1, 0])),
    cited({ status: 'answered', answer: 'Знаю по памяти: ревьюер.' }),
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'как собрать ракету', mode: 'rerank' })
  await rag.close()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'answer_invalid')
  assert.equal(snapshot.error.paidNothing, false)
})

test('неразобранный ответ — отказ запуска без повтора', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([KEEP_TWO, { text: 'не json', json: null }])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'кто держит гейт', mode: 'rerank' })
  await rag.close()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'answer_invalid')
  assert.equal(snapshot.error.paidNothing, false)
  // Повтора нет: ровно два вызова, второй не повторён.
  assert.equal(router.bodies.length, 2)
})

test('источник вне отбора — отказ формы, а не тихая строка на экране', () => {
  const kept = [{ n: 2, text: 'текст фрагмента 2' }]
  assert.throws(
    () =>
      readCited(
        {
          status: 'answered',
          answer: 'ответ',
          sources: [{ n: 9, source: 'agent_docs/file-9.md', section: 'Раздел 9' }],
          quotes: [],
          clarification: null,
        },
        kept,
      ),
    /фрагмент \[9\]/,
  )
})

test('модель сама вернула unknown при найденных фрагментах — исход unknown_model', () => {
  const read = readCited(
    {
      status: 'unknown',
      answer: 'В найденных фрагментах ответа нет.',
      sources: [],
      quotes: [],
      clarification: 'О каком дне речь?',
    },
    [{ n: 1, text: 'текст' }],
  )
  assert.equal(read.outcome, 'unknown_model')
  assert.equal(read.clarification, 'О каком дне речь?')
})

test('нормализация прощает пробелы и регистр и не прощает слов', () => {
  assert.equal(flatten('  Гейт\nМержа  '), 'гейт мержа')
  assert.notEqual(flatten('гейт мержа'), flatten('гейт ревью'))
})

test('МУТАЦИЯ ПУТИ: путь источника берётся из отбора, выдуманный едет рядом и краснит cited_exact', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    KEEP_TWO,
    cited({
      status: 'answered',
      answer: 'Гейт мержа держит ревьюер [1].',
      // Номер настоящий, путь — выдуманный. Без взятия пути из отбора
      // страница показала бы дословную цитату под несуществующим файлом.
      sources: [{ n: 1, source: 'agent_docs/выдумка.md', section: 'Выдуманный раздел' }],
      quotes: [{ n: 1, text: 'гейт мержа держит ревьюер номер 1.' }],
    }),
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'кто держит гейт мержа', mode: 'rerank' })
  await rag.close()

  const result = snapshot.result
  assert.equal(result.cited[0].source, 'agent_docs/file-1.md', 'на экран ушёл путь от модели')
  assert.equal(result.cited[0].section, 'Раздел 1')
  // Заявленное моделью не выброшено: расхождение обязано быть видно.
  assert.equal(result.cited[0].claimedSource, 'agent_docs/выдумка.md')
  assert.equal(result.checks.cited_exact, false)
  // Цитата при этом настоящая, и исход — `answered`: признак расхождения
  // путей не отменяет подтверждённой цитаты, он стоит рядом с ней.
  assert.equal(result.checks.quotes_verbatim, true)
  assert.equal(result.outcome, 'answered')
})

test('смешанные цитаты: одна дословная, одна выдуманная — answered, но quotes_verbatim красный', async () => {
  const rag = await fakeRag()
  const router = fakeRouter([
    KEEP_TWO,
    cited({
      status: 'answered',
      answer: 'Гейт мержа держат ревьюеры [1] и [2].',
      sources: [
        { n: 1, source: 'agent_docs/file-1.md', section: 'Раздел 1' },
        { n: 2, source: 'agent_docs/file-2.md', section: 'Раздел 2' },
      ],
      quotes: [
        { n: 1, text: 'гейт мержа держит ревьюер номер 1.' },
        { n: 2, text: 'гейт мержа держит архитектор номер 2.' },
      ],
    }),
  ])
  const { runs, agent } = build({ rag, fetchImpl: router.fetchImpl })
  const snapshot = await run(agent, runs, { question: 'кто держит гейт мержа', mode: 'rerank' })
  await rag.close()

  const result = snapshot.result
  assert.deepEqual(
    result.quotes.map((item) => item.verified),
    [true, false],
  )
  // Одна подтверждённая цитата есть — исход `answered`; но признак
  // дословности красный, и это видно отдельно от исхода.
  assert.equal(result.outcome, 'answered')
  assert.equal(result.checks.quotes_verbatim, false)
})

// Потолок цитаты после решения владельца 2026-10-05 (ADR 2026-10-05-1013):
// длинная цитата не отвергается — сверяются её первые 300 знаков. Предмет
// этих тестов — обе ветви развилки по исходу сверки: подтвердилась — наружу
// уходит обрезанный текст (иначе страница показала бы непроверенный хвост с
// пометкой «найдена дословно»); не подтвердилась — наружу уходит текст
// модели целиком, иначе пояснение страницы «показана такой, какой её привела
// модель» становится ложью (находка `compliance`, PR #321).
test('дословная цитата длиннее 300 знаков подтверждается, но обрезанной до 300', () => {
  const fragment = `Во фрагменте 1 сказано: ${'слово '.repeat(100)}конец.`
  const quote = fragment.slice(0, 388)
  assert.equal(quote.length, 388, 'цитата должна быть длиннее потолка')

  const checked = verifyQuotes([{ n: 1, text: quote }], [{ n: 1, text: fragment }])
  assert.equal(checked[0].verified, true, 'дословная цитата отвергнута только за длину')
  assert.equal(checked[0].truncated, true)
  // Наружу уходит обрезанный текст, а не присланный моделью: пометка
  // «найдена дословно» относится ровно к тому, что показано.
  assert.equal(checked[0].text, quote.slice(0, 300))
  assert.equal(checked[0].text.length, 300)
})

test('цитата во весь фрагмент целиком наружу не выходит: сверяются и показываются первые 300 знаков', () => {
  const long = `Во фрагменте 1 сказано: ${'слово '.repeat(100)}конец.`
  assert.ok(long.length > 300)
  const checked = verifyQuotes([{ n: 1, text: long }], [{ n: 1, text: long }])
  // Прежнее поведение — `verified: false`. Защита, ради которой стоял
  // потолок («подстрока, равная строке, не доказывает ничего»), держится
  // теперь не отказом, а формой: фрагментом во весь экран цитата быть не
  // может — ни на сверке, ни на странице.
  assert.notEqual(checked[0].text, long)
  assert.equal(checked[0].text.length, 300)
  assert.equal(checked[0].truncated, true)
})

test('НЕподтверждённая длинная цитата показывается целиком и обрезанной не помечается', () => {
  // Выдуманная цитата длиннее потолка: первые 300 знаков во фрагменте не
  // находятся. Показать её обрезанной значило бы соврать пояснением
  // `UNVERIFIED_NOTE` страницы дня 24 — 400 знаков выдумки под подписью
  // «показана такой, какой её привела модель» были бы показаны как 300.
  const fragment = `Во фрагменте 1 сказано: ${'слово '.repeat(100)}конец.`
  const quote = `Этого во фрагменте нет: ${'выдумка '.repeat(50)}`
  assert.ok(quote.length > 300, 'цитата должна быть длиннее потолка')

  const checked = verifyQuotes([{ n: 1, text: quote }], [{ n: 1, text: fragment }])
  assert.equal(checked[0].verified, false)
  assert.equal(checked[0].truncated, false)
  assert.equal(checked[0].text, quote, 'текст модели ушёл наружу не целиком')
  assert.equal(checked[0].text.length, quote.length)
})

test('цитата ровно в потолок не обрезается и обрезанной не помечается', () => {
  const fragment = `Во фрагменте 1 сказано: ${'слово '.repeat(100)}конец.`
  const quote = fragment.slice(0, 300)
  const checked = verifyQuotes([{ n: 1, text: quote }], [{ n: 1, text: fragment }])
  assert.equal(checked[0].verified, true)
  assert.equal(checked[0].truncated, false)
  assert.equal(checked[0].text, quote)
})

test('обрезка считает знаки, а не единицы UTF-16: цитата с эмодзи не рвётся пополам', () => {
  // 299 букв плюс эмодзи из двух единиц UTF-16: 300-й знак — целый эмодзи.
  // Обрезка по `slice` оставила бы половину пары, и дословная цитата
  // перестала бы находиться во фрагменте.
  const quote = `${'я'.repeat(299)}🙂`
  const fragment = `${quote} и дальше текст фрагмента.`
  const checked = verifyQuotes([{ n: 1, text: `${quote} и дальше` }], [{ n: 1, text: fragment }])
  assert.equal(checked[0].verified, true)
  assert.equal(checked[0].text, quote)
  assert.equal(checked[0].truncated, true)
})

test('неизвестный pipeline — отказ сборки, а не тихий откат к режимам дня 22', () => {
  assert.throws(
    () =>
      createRagAgent({
        agent: ENTRY,
        servers: new Map(),
        runs: createRuns(),
        env: envOf(),
        fetchImpl: async () => assert.fail('роутер'),
        log: () => {},
        pipeline: 'citd',
      }),
    /неизвестный pipeline/,
  )
})

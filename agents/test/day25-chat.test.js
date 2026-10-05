// День 25 (ADR 2026-10-05-0544, п. 3): чат по корпусу на машине дня 15.
//
// Предмет файла — три обещания, каждое из которых иначе держалось бы только
// намерением автора:
//   1) ИСТОЧНИКИ ВСЕГДА. У ответа хода есть источники — и в результате
//      запуска, и в `meta` реплики, которая переживёт поток событий;
//   2) СОСТОЯНИЕ ЗАДАЧИ ПЕРЕЖИВАЕТ ХОД и уходит в промпт переписывания
//      СЛЕДУЮЩЕГО хода — то есть цель разговора живёт между ходами, а не
//      внутри одного;
//   3) ОТКАЗ ПОИСКА НЕ ОПЛАЧИВАЕТ ОТВЕТ: роутер не вызывается ни разу (I-4).
//
// Сервер MCP — настоящий `node:http` с настоящим JSON-RPC, как в днях 22–24;
// роутер — поддельный `fetchImpl`, который в части тестов обязан не быть
// вызванным ни разу. Настоящего API не зовёт ни один тест.
//
// Сервер поиска снимается в `t.after`, а не строкой в конце теста: иначе
// УПАВШИЙ тест оставлял бы открытый сокет, прогон не завершался бы вовсе, и
// мутационная проверка показывала бы зависание вместо красного теста.
//
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createInvariants } from '../src/invariants.js'
import { loadServers } from '../src/mcp/servers.js'
import { STAGED15_MAX_TOKENS } from '../src/params.js'
import { createProfilePrompts } from '../src/prompts.js'
import { CHAT_AGENT_ID, createRagChat, RAG_STAGES, TASK_SYSTEM } from '../src/rag/chat.js'
import { WIDE_LIMIT } from '../src/rag/retrieve.js'
import { createRuns } from '../src/runs.js'
import { createSessions } from '../src/sessions.js'
import { createStageLog } from '../src/stage-log.js'
import { createStagedAgent } from '../src/staged.js'
import { ENV, REGISTRY } from './fixtures.js'

const ENTRY = REGISTRY.get(CHAT_AGENT_ID)
const KEY = 'rag-key-fake-value-32-bytes-long'
const INDEX = { commit: '4de2d6e', strategy: 'structural', chunks: 3167 }
const tmp = (name) => join(mkdtempSync(join(tmpdir(), 'day25-')), name)

/** Десять кандидатов: ровно столько, сколько просит этап «Поиск». */
const RESULTS = Array.from({ length: WIDE_LIMIT }, (_, at) => ({
  source: `agent_docs/file-${at + 1}.md`,
  section: `Раздел ${at + 1}`,
  score: Number((0.6 - at / 100).toFixed(3)),
  text: `текст фрагмента ${at + 1} про лимитер и расход`,
  truncated: false,
}))

const packed = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

/** Поддельная служба `rag`: помнит аргументы вызовов инструмента. */
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

const reply = (fields) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    text: '',
    usage: { inputTokens: 400, outputTokens: 40 },
    provider: { model: 'claude-haiku-4-5' },
    truncated: false,
    durationMs: 100,
    ...fields,
  }),
})

const RATINGS = {
  ratings: [
    { n: 1, relevance: 2 },
    { n: 2, relevance: 1 },
    { n: 3, relevance: 0 },
  ],
}

const CITED = {
  status: 'answered',
  answer: 'Лимитер стоит до вызова модели.',
  sources: [
    { n: 1, source: 'agent_docs/file-1.md', section: 'Раздел 1' },
    { n: 2, source: 'agent_docs/file-2.md', section: 'Раздел 2' },
  ],
  quotes: [{ n: 1, text: 'лимитер и расход' }],
  clarification: null,
}

const TASK = {
  goal: 'разобраться, как держится расход',
  constraints: ['без новых зависимостей'],
  terms: [{ term: 'лимитер', meaning: 'слой окон запросов' }],
  clarifications: [],
  open: [],
}

/**
 * Роутер-заглушка: различает ШЕСТЬ вызовов хода по их собственным признакам —
 * схеме и провайдеру, — а не по порядку. Порядок и число вызовов проверяет
 * тест, и угадывание по номеру скрыло бы как раз лишний вызов.
 */
function router({ cited = CITED, task = TASK, ratings = RATINGS, verdict = 'вердикт: принято\nзамечания:' } = {}) {
  const bodies = []
  const impl = async (url, init = {}) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ({ providers: [] }) }
    const body = JSON.parse(init.body)
    bodies.push(body)
    const props = body.schema?.properties ?? {}
    if (props.ratings) return reply({ json: ratings })
    if (props.status) return reply({ json: cited, text: JSON.stringify(cited) })
    if (props.goal) return reply({ json: task })
    if (body.provider === 'kimi-k2.6')
      return reply({ text: verdict, provider: { model: 'kimi-k2.6' } })
    if (body.taskClass === 'summarize' && body.system.includes('переписываешь'))
      return reply({ text: 'лимитер расход окна' })
    return reply({ text: 'тема: продолжить' })
  }
  impl.bodies = bodies
  impl.of = (kind) =>
    bodies.filter((body) => {
      const props = body.schema?.properties ?? {}
      if (kind === 'rerank') return Boolean(props.ratings)
      if (kind === 'answer') return Boolean(props.status)
      if (kind === 'task') return Boolean(props.goal)
      if (kind === 'verify') return body.provider === 'kimi-k2.6'
      if (kind === 'rewrite')
        return body.taskClass === 'summarize' && body.system.includes('переписываешь')
      return body.taskClass === 'summarize' && !body.system.includes('переписываешь')
    })
  return impl
}

/** Агент дня 25 на файловой базе: «после перезапуска» проверяется перезапуском. */
function setup({ rag, fetchImpl = router(), file = tmp('sessions.db') } = {}) {
  const env = { ...ENV, PAUSE_TTL_MINUTES: 60 }
  const sessions = createSessions({
    file,
    ttlMs: env.SESSION_TTL_HOURS * 3600_000,
    profileTtlMs: env.PROFILE_TTL_DAYS * 24 * 3600_000,
    log: () => {},
  })
  const runs = createRuns()
  const { servers } = loadServers(
    { servers: [{ name: 'rag', title: 'Индекс проекта', urlEnv: 'MCP_RAG_URL', keyEnv: 'RAG_KEY' }] },
    { MCP_RAG_URL: rag?.url ?? '', RAG_KEY: KEY },
  )
  const agent = createStagedAgent({
    agent: ENTRY,
    runs,
    sessions,
    stageLog: createStageLog({ file: tmp('stages.csv'), log: () => {} }),
    env,
    fetchImpl,
    log: () => {},
    invariants: createInvariants({ sessions }),
    prompts: createProfilePrompts({ sessions }),
    stages: RAG_STAGES,
    maxOutputTokens: STAGED15_MAX_TOKENS,
    rag: createRagChat({ agent: ENTRY, servers, sessions, env, fetchImpl, log: () => {} }),
  })
  const profile = sessions.createProfile({ name: 'Мика' }).profile
  const sid = sessions.createSession({ profileId: profile.id }).id
  const ask = async (body = {}) => {
    const parsed = agent.parseInput({
      profileId: profile.id,
      sessionId: sid,
      prompt: 'а как там с расходом?',
      reviewRounds: 1,
      ...body,
    })
    assert.ok(parsed.ok, parsed.message)
    const run = runs.create({ agent, input: parsed.input })
    agent.hold(parsed.input.sessionId)
    await agent.execute(run)
    return runs.snapshot(run.id)
  }
  return { env, file, sessions, runs, agent, fetchImpl, profile, sid, ask }
}

// --- Этапы ----------------------------------------------------------------

test('восемь этапов, и «Поиск» стоит до подготовки промпта и вызова модели', async (t) => {
  const rag = await fakeRag()
  t.after(() => rag.close())
  const described = await setup({ rag }).agent.describe()
  assert.deepEqual(
    described.stages.map((s) => s.id),
    ['intake', 'assemble', 'retrieve', 'prepare', 'answer', 'verify', 'replenish', 'deliver'],
  )
  // Шестой правимый промпт профиля виден «Об агенте» и правится своей ручкой.
  assert.deepEqual(
    described.extraPrompts.map((p) => p.promptId),
    ['stage.task'],
  )
  assert.equal(described.extraPrompts[0].prompt, TASK_SYSTEM)
})

// --- Обещание 1: источники всегда ----------------------------------------

test('у ответа хода есть источники и дословная цитата, вызовов модели шесть', async (t) => {
  const rag = await fakeRag()
  t.after(() => rag.close())
  const { ask, fetchImpl, sessions, sid } = setup({ rag })
  const snapshot = await ask()

  assert.equal(snapshot.status, 'succeeded', JSON.stringify(snapshot.error))
  // Источники — то, что ушло модели номерами: реранкер оставил два.
  assert.ok(snapshot.result.sources.length >= 1, 'у ответа хода есть источники')
  assert.deepEqual(
    snapshot.result.sources.map((s) => s.n),
    [1, 2],
  )
  assert.equal(snapshot.result.outcome, 'answered')
  assert.deepEqual(snapshot.result.quotes, [{ n: 1, text: 'лимитер и расход', verified: true }])
  assert.equal(snapshot.result.checks.quotes_verbatim, true)
  // Текст реплики — поле схемы, а не тело JSON целиком.
  assert.equal(snapshot.result.answer, CITED.answer)

  // Те же источники — у СООБЩЕНИЯ: карточка показывает их и после
  // перезагрузки, когда результата запуска уже нет.
  const last = sessions.history(sid).at(-1)
  assert.equal(last.role, 'agent')
  assert.equal(last.meta.rag.sources.length, 2)
  assert.equal(last.meta.rag.outcome, 'answered')

  // Шесть вызовов модели на ход (ADR, п. 4): переписывание, реранкер, ответ,
  // проверка, пополнение, состояние задачи. Ни одного лишнего.
  assert.equal(fetchImpl.bodies.length, 6)
  for (const kind of ['rewrite', 'rerank', 'answer', 'verify', 'replenish', 'task'])
    assert.equal(fetchImpl.of(kind).length, 1, `вызов ${kind} ровно один`)
  // Поиск шёл дважды: по исходной реплике и по переписанному запросу.
  assert.deepEqual(
    rag.calls.map((c) => c.limit),
    [WIDE_LIMIT, WIDE_LIMIT],
  )
})

test('фрагменты и состояние задачи попадают в текст промпта круга дословно', async (t) => {
  const rag = await fakeRag()
  t.after(() => rag.close())
  const { ask, sessions, sid } = setup({ rag })
  const first = await ask()
  // Второй ход: состояние задачи уже есть, и блок <task> обязан быть в промпте.
  const second = await ask()
  assert.equal(second.status, 'succeeded', JSON.stringify(second.error))

  const texts = sessions.runPromptsOf({ runId: second.id, sessionId: sid })
  assert.equal(texts.length, 1, 'одна строка на круг')
  assert.match(texts[0].input, /<fragments>/)
  assert.match(texts[0].input, /текст фрагмента 1/)
  assert.match(texts[0].input, /<task>/)
  assert.match(texts[0].input, /разобраться, как держится расход/)
  // Блоки стоят перед запросом посетителя: вопрос последним — везде.
  assert.ok(texts[0].input.indexOf('<task>') < texts[0].input.indexOf('<request>'))
  assert.ok(texts[0].input.indexOf('<fragments>') < texts[0].input.indexOf('<task>'))
  // В первом ходу блока состояния ещё не было: он появился от хода, а не из
  // воздуха.
  const firstText = sessions.runPromptsOf({ runId: first.id, sessionId: sid })[0]
  assert.equal(firstText.input.includes('<task>'), false)
})

// --- Обещание 2: состояние задачи переживает ход --------------------------

test('состояние задачи переживает ход, перезапуск и уходит в промпт переписывания', async (t) => {
  const rag = await fakeRag()
  t.after(() => rag.close())
  const { ask, fetchImpl, sessions, file, sid } = setup({ rag })
  await ask()

  // Пережило ход: строка в базе, а не поле в памяти процесса.
  const stored = sessions.taskStateOf(sid)
  assert.ok(stored, 'состояние задачи записано')
  assert.equal(JSON.parse(stored.state).goal, TASK.goal)
  assert.equal(stored.round, 1)

  // Пережило перезапуск: та же база, ВТОРОЙ объект хранилища — тот же файл
  // читается заново, а не из памяти первого.
  const again = createSessions({ file, ttlMs: 1e12, profileTtlMs: 1e12, log: () => {} })
  assert.equal(JSON.parse(again.taskStateOf(sid).state).goal, TASK.goal)
  again.close()

  const second = await ask()
  assert.equal(second.status, 'succeeded', JSON.stringify(second.error))

  // И ушло в промпт ПЕРЕПИСЫВАНИЯ следующего хода: иначе поиск второго хода
  // не знал бы, о какой задаче речь, и «а как там с расходом?» искалось бы
  // без цели разговора.
  const rewrites = fetchImpl.of('rewrite')
  assert.equal(rewrites.length, 2)
  assert.equal(rewrites[0].input.includes(TASK.goal), false, 'в первом ходу состояния не было')
  assert.match(rewrites[1].input, /разобраться, как держится расход/)
  assert.match(rewrites[1].input, /лимитер — слой окон запросов/)
  assert.equal(second.result.task.round, 2)
  assert.equal(second.result.task.goal, TASK.goal)
})

test('шестой промпт профиля правит вызов состояния задачи', async (t) => {
  const rag = await fakeRag()
  t.after(() => rag.close())
  const { ask, fetchImpl, sessions, profile } = setup({ rag })
  assert.equal(
    sessions.savePrompt({
      profileId: profile.id,
      promptId: 'stage.task',
      text: 'Веди состояние задачи одной строкой.',
    }).ok,
    true,
  )
  await ask()
  assert.equal(fetchImpl.of('task')[0].system, 'Веди состояние задачи одной строкой.')
})

// --- Обещание 3: отказ поиска не оплачивает ответ -------------------------

test('отказ поиска обрывает ход: роутер не вызван ни разу, ход не оплачен', async (t) => {
  const rag = await fakeRag({
    answer: () => ({ isError: true, content: [{ type: 'text', text: 'NO_INDEX: индекса нет' }] }),
  })
  t.after(() => rag.close())
  const fetchImpl = router()
  const { ask, sessions, sid } = setup({ rag, fetchImpl })
  const snapshot = await ask()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'search_refused')
  assert.match(snapshot.error.message, /Модель не вызывалась/)
  assert.equal(snapshot.error.paidNothing, true)
  // Ни одного вызова роутера: ни переписывания, ни реранкера, ни ответа.
  assert.equal(fetchImpl.bodies.length, 0)
  // Состояния задачи после неоплаченного хода тоже нет.
  assert.equal(sessions.taskStateOf(sid), null)
})

test('поиск недоступен — ход отказан до роутера, даже если фрагменты были бы', async (t) => {
  const fetchImpl = router()
  const { ask } = setup({ rag: null, fetchImpl })
  const snapshot = await ask()
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'search_unavailable')
  assert.equal(fetchImpl.bodies.length, 0)
})

// --- Форма ответа ---------------------------------------------------------

test('ответ со чужим номером источника — отказ формы, повтора вызова нет', async (t) => {
  const rag = await fakeRag()
  t.after(() => rag.close())
  const fetchImpl = router({
    cited: { ...CITED, sources: [{ n: 9, source: 'выдумка.md', section: '—' }] },
  })
  const { ask, sessions, sid } = setup({ rag, fetchImpl })
  const snapshot = await ask()

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'answer_invalid')
  // Вызов оплачен — и это сказано полем, а не умолчанием.
  assert.equal(snapshot.error.paidNothing, false)
  assert.equal(fetchImpl.of('answer').length, 1, 'второго вызова ответа не было')
  // Ни реплики агента, ни состояния задачи от неудавшейся формы не осталось.
  assert.equal(sessions.taskStateOf(sid), null)
})

// --- Уборка ---------------------------------------------------------------

test('«очистить» и удаление профиля уносят состояние задачи', async (t) => {
  const rag = await fakeRag()
  t.after(() => rag.close())
  const { ask, sessions, sid, profile } = setup({ rag })
  await ask()
  assert.ok(sessions.taskStateOf(sid))
  sessions.clear(sid)
  assert.equal(sessions.taskStateOf(sid), null, '«очистить» унесло состояние')

  const other = sessions.createSession({ profileId: profile.id }).id
  assert.equal(
    sessions.saveTaskState({ sessionId: other, profileId: profile.id, state: '{}', round: 1 }),
    true,
  )
  assert.equal(sessions.deleteProfile(profile.id).taskState, 1)
  assert.equal(sessions.taskStateOf(other), null, 'удаление профиля унесло состояние')
})

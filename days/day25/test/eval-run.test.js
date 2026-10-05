// Прогон сценариев против ПОДДЕЛЬНОГО дня: ни одного живого запроса и ни
// одного вызова модели. Предмет — то, из-за чего прогон стоил бы денег зря:
// склад cookie (без него второй ход начал бы новый диалог), проба перед
// деньгами, запись файла после КАЖДОГО хода и разбор кадра `end`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkReport, readFailure, readTurn, summarize } from '../eval/mechanics.mjs'
import { createJar, main, parseEnd, runAll, runTurn, smoke } from '../eval/run.mjs'

const sse = (frames) =>
  frames.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const stream = (text) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })

/** Удачный результат хода: ровно те поля, которые прогон читает. */
const okResult = (over = {}) => ({
  answer: 'Инварианты лежат в agent_docs/invariants.md.',
  outcome: 'answered',
  status: 'answered',
  clarification: null,
  rounds: 1,
  reviewRounds: 1,
  totalTokens: 4200,
  durationMs: 21_000,
  rewritten: 'инварианты продукта держатели',
  sources: [{ n: 1 }, { n: 3 }],
  candidates: [{ n: 1 }, { n: 2 }, { n: 3 }],
  cited: [
    { n: 1, source: 'agent_docs/invariants.md', claimedSource: 'agent_docs/invariants.md' },
    { n: 3, source: 'AGENTS.md', claimedSource: 'agent_docs/AGENTS.md' },
  ],
  quotes: [
    { n: 1, text: 'держит:', verified: true },
    { n: 3, text: 'выдумано', verified: false },
  ],
  checks: {
    sources_present: true,
    quotes_present: true,
    quotes_verbatim: false,
    cited_exact: false,
  },
  index: { commit: 'abc1234', strategy: 'headings', fragments: 900 },
  task: {
    goal: 'понять инварианты',
    constraints: ['только тесты'],
    terms: [],
    clarifications: [],
    open: ['держатель I-14'],
    round: 2,
    stored: true,
  },
  summary: { totalTokens: 4200, durationMs: 21_000 },
  ...over,
})

/**
 * Поддельный день. Запоминает каждый запрос — именно по ним проверяется, что
 * cookie доехала, — и отвечает по сценарию, заданному вызывающим.
 */
function fakeDay({ answer = () => ({ status: 202, body: { runId: 'r1' } }), end = okResult() } = {}) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    seen.push({ path, method: init.method ?? 'GET', cookie: init.headers?.cookie ?? null })
    const json = (status, body, cookies = []) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
        ...(cookies.length > 0 ? {} : {}),
      })
    if (path.endsWith('/healthz')) return json(200, { ok: true })
    if (path.endsWith('/api/profiles')) return json(200, { profiles: [], cap: 5 })
    if (path.endsWith('/api/profile')) {
      return json(200, { profile: { id: 'p1', name: 'замер' } })
    }
    if (path.endsWith('/api/profile/select')) {
      const r = new Response(JSON.stringify({ profile: { id: 'p1' }, sessionId: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
      r.headers.append('set-cookie', 'day25_pid=p1; HttpOnly; Path=/')
      return r
    }
    if (path.endsWith('/api/settings')) return json(200, { settings: { reviewRounds: 1 } })
    if (path.endsWith('/api/session')) {
      const r = new Response(JSON.stringify({ sessionId: 'aaaaaaaa-0000', name: 'диалог 1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
      r.headers.append('set-cookie', 'day25_sid=aaaaaaaa-0000; HttpOnly; Path=/')
      return r
    }
    if (path.endsWith('/api/answer')) {
      const got = answer(seen.filter((s) => s.path.endsWith('/api/answer')).length)
      return json(got.status, got.body)
    }
    if (path.endsWith('/events'))
      return new Response(stream(sse([['event', { stage: 'rag' }], ['end', { status: 'succeeded', result: end }]])), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    return json(404, { error: 'нет такой ручки' })
  }
  return { fetchImpl, seen }
}

test('кадр end разбирается, а служебные кадры пропускаются молча', () => {
  const state = { buffer: '' }
  assert.equal(parseEnd(': ping\n\nevent: event\ndata: {"stage":"rag"}\n\n', state), null)
  const end = parseEnd('event: end\ndata: {"status":"succeeded","result":{"answer":"да"}}\n\n', state)
  assert.equal(end.status, 'succeeded')
  assert.equal(end.result.answer, 'да')
})

test('cookie профиля и диалога уходит в каждый следующий запрос — иначе второй ход начал бы новый диалог', async () => {
  const day = fakeDay()
  const jar = createJar()
  assert.equal((await smoke({ base: 'http://day', jar, fetchImpl: day.fetchImpl })).ok, true)
  const ready = await (await import('../eval/run.mjs')).setup({
    base: 'http://day',
    jar,
    name: 'замер',
    fetchImpl: day.fetchImpl,
  })
  assert.equal(ready.ok, true, ready.why)
  await runTurn({ base: 'http://day', prompt: 'привет', jar, fetchImpl: day.fetchImpl })
  const answer = day.seen.find((s) => s.path.endsWith('/api/answer'))
  assert.match(answer.cookie ?? '', /day25_pid=p1/, 'ход пошёл без cookie профиля')
  // Проверка, что проверка работает: до выбора профиля cookie и не было.
  const health = day.seen.find((s) => s.path.endsWith('/healthz'))
  assert.equal(health.cookie, null, 'cookie взялась не из ответа дня')
})

test('проба не пускает платный прогон, когда мест под профиль нет', async () => {
  const day = fakeDay()
  const full = async (url, init) => {
    if (new URL(url).pathname.endsWith('/api/profiles'))
      return new Response(JSON.stringify({ profiles: [1, 2, 3, 4, 5], cap: 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    return day.fetchImpl(url, init)
  }
  const probe = await smoke({ base: 'http://day', jar: createJar(), fetchImpl: full })
  assert.equal(probe.ok, false)
  assert.match(probe.why, /мест под профиль нет/)
})

test('файл пишется после каждого хода, а не в конце: обрыв не стирает оплаченное', async () => {
  const day = fakeDay()
  const saves = []
  const set = {
    minTurns: 1,
    maxTurns: 15,
    scenarios: [
      { id: 's1', title: 'раз', turns: [{ n: 1, purpose: 'а', prompt: 'один' }, { n: 2, purpose: 'б', prompt: 'два' }] },
      { id: 's2', title: 'два', turns: [{ n: 1, purpose: 'в', prompt: 'три' }] },
    ],
  }
  const done = await runAll({
    base: 'http://day',
    set,
    jar: createJar(),
    note: 'проба',
    save: (report) => saves.push(structuredClone(report)),
    fetchImpl: day.fetchImpl,
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(saves.length, 3, 'записей файла не по одной на ход')
  assert.equal(saves[0].scenarios[0].turns.length, 1, 'первая запись уже несёт первый ход')
  assert.equal(done.scenarios.length, 2)
  assert.equal(done.scenarios[1].sessionName, 'диалог 1', 'сценарий не назвал свой диалог')
})

test('отказ лимитера доезжает до файла и говорит, что денег не стоил', async () => {
  const day = fakeDay({
    // Номер хода считается с единицы: отказ достаётся первому же.
    answer: (nth) =>
      nth === 1 ? { status: 429, body: { error: 'Слишком часто.' } } : { status: 202, body: { runId: 'r1' } },
  })
  const got = await runTurn({ base: 'http://day', prompt: 'раз', jar: createJar(), fetchImpl: day.fetchImpl })
  const record = readFailure({ turn: { n: 1, purpose: 'п', prompt: 'раз' }, failure: got.failure, latencyMs: 12 })
  assert.equal(record.failure.code, 'http_429')
  assert.equal(record.paidNothing, true, '4xx помечен как возможно оплаченный')
  assert.equal(record.outcome, null, 'у отказа появился исход')
})

test('механика хода читается полями, а не домыслом', () => {
  const record = readTurn({ turn: { n: 1, purpose: 'п', prompt: 'раз' }, result: okResult(), latencyMs: 23_000 })
  assert.equal(record.outcome, 'answered')
  assert.equal(record.sources, 2)
  assert.equal(record.quotes, 2)
  assert.equal(record.quotesVerified, 1, 'пометка дословности посчитана не по полю verified')
  assert.equal(record.citedMismatch, 1, 'разошедшийся путь не замечен')
  assert.equal(record.checks.cited_exact, false)
  assert.equal(record.rewritten, true)
  assert.equal(record.task.constraints, 1)
  assert.equal(record.task.stored, true)
  assert.equal(record.indexCommit, 'abc1234')
  assert.equal(record.latencyMs, 23_000)
  // У удачного хода слова о деньгах нет вовсе: домысел пугал бы расходом.
  assert.equal(record.paidNothing, null)
})

test('сменившийся посреди прогона индекс валит сверку, а не усредняется молча', () => {
  const turn = (n, commit) => ({
    ...readTurn({ turn: { n, purpose: 'п', prompt: 'раз' }, result: okResult({ index: { commit } }), latencyMs: 10 }),
  })
  const scenario = (id, commits) => ({
    id,
    title: id,
    sessionName: 'диалог',
    turns: commits.map((c, at) => turn(at + 1, c)),
  })
  const same = Array.from({ length: 10 }, () => 'abc1234')
  const report = {
    ranAt: '2026-10-05T12:00:00.000Z',
    note: 'проба',
    limits: { dailyCap: 50, reviewRounds: 1 },
    index: { commit: 'abc1234', seen: ['abc1234', 'def5678'] },
    scenarios: [scenario('s1', same), scenario('s2', same)],
  }
  const problems = checkReport(report)
  assert.ok(
    problems.some((p) => p.includes('индекс менялся')),
    `смена индекса прошла молча: ${problems.join('; ')}`,
  )
})

test('сводка сценария считает то же, что печатает прогон', () => {
  const turns = [
    readTurn({ turn: { n: 1, purpose: 'п', prompt: 'раз' }, result: okResult(), latencyMs: 20_000 }),
    readFailure({ turn: { n: 2, purpose: 'п', prompt: 'два' }, failure: { code: 'search_failed', message: 'нет' }, latencyMs: 900 }),
  ]
  const s = summarize(turns)
  assert.equal(s.turns, 2)
  assert.equal(s.failed, 1)
  assert.equal(s.outcomes.answered, 1)
  assert.equal(s.quotesVerified, 1)
  // Отказ в среднее время не входит: он вернулся за секунду и занижал бы его.
  assert.equal(s.latencyMs, 20_000)
})

test('--check на отсутствующем файле падает, а не молчит', async () => {
  const lines = []
  const code = await main({
    argv: ['--check', '--out', '/нет/такого/eval.json'],
    log: (line) => lines.push(String(line)),
  })
  assert.equal(code, 1)
  assert.ok(lines.some((l) => l.includes('сверять нечего')), lines.join(' | '))
})

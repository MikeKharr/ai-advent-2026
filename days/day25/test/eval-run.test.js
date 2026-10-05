// Прогон сценариев против ПОДДЕЛЬНОГО дня: ни одного живого запроса и ни
// одного вызова модели. Предмет — то, из-за чего прогон стоил бы денег зря:
// склад cookie (без него второй ход начал бы новый диалог), проба перед
// деньгами, запись файла после КАЖДОГО хода и разбор кадра `end`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, checkReport, readFailure, readTurn, summarize } from '../eval/mechanics.mjs'
import {
  createJar,
  DAY_LIMITS,
  EVAL_HEADER,
  main,
  parseEnd,
  readEvalKey,
  runAll,
  runTurn,
  smoke,
  teardown,
} from '../eval/run.mjs'
import { parseEnv } from '../env.js'

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
    seen.push({
      path,
      method: init.method ?? 'GET',
      cookie: init.headers?.cookie ?? null,
      key: init.headers?.[EVAL_HEADER] ?? null,
      body: init.body ?? null,
    })
    const json = (status, body, cookies = []) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
        ...(cookies.length > 0 ? {} : {}),
      })
    if (path.endsWith('/healthz')) return json(200, { ok: true })
    if (path.endsWith('/api/profiles')) return json(200, { profiles: [], cap: 5 })
    if (path.endsWith('/api/profile')) {
      return init.method === 'DELETE'
        ? json(200, { removed: { rules: 0, facts: 0 } })
        : json(200, { profile: { id: 'p1', name: 'замер' } })
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
  // Суточный потолок в отчёте — ДНЕВНОЙ, а не вписанный в прогон числом:
  // вторая копия разошлась бы с настоящим молча.
  assert.equal(saves[0].limits.dailyCap, parseEnv({}).env.MAX_DAILY_CALLS)
})

test('прогон целиком убирает свой профиль: мест под профиль у дня пять', async () => {
  // ПРЕДМЕТ — `main`, а не `teardown`: уборка обязана стоять в самом прогоне.
  // Без этого теста вызов можно было бы убрать из `main`, и четыре прогона
  // заняли бы все пять мест (находка `reviewer` к PR #325).
  const day = fakeDay()
  const dir = mkdtempSync(join(tmpdir(), 'day25-sweep-'))
  const set = join(dir, 'scenarios.json')
  writeFileSync(
    set,
    JSON.stringify({
      minTurns: 1,
      maxTurns: 15,
      scenarios: [
        { id: 's1', title: 'раз', turns: [{ n: 1, purpose: 'а', prompt: 'один' }] },
        { id: 's2', title: 'два', turns: [{ n: 1, purpose: 'б', prompt: 'два' }] },
      ],
    }),
  )
  try {
    const lines = []
    await main({
      argv: ['--scenarios', set, '--out', join(dir, 'eval.json'), '--base', 'http://day'],
      fetchImpl: day.fetchImpl,
      sleep: async () => {},
      readKey: () => null,
      log: (line) => lines.push(String(line)),
    })
    const gone = day.seen.find((s) => s.method === 'DELETE' && s.path.endsWith('/api/profile'))
    assert.ok(gone, `прогон не удалил свой профиль: ${lines.join(' | ')}`)
    assert.ok(lines.some((l) => l.includes('удалён')), `об уборке не сказано: ${lines.join(' | ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test('объявленное смешение индекса проходит, молчаливое — нет, вранье в объявлении — нет', () => {
  // Решение владельца 2026-10-05: смешанный индекс не выбрасывает оплаченный
  // замер, но ПРОХОДИТ только объявленным. Три ветви, и каждая проверена:
  // молчание — красное, объявление с причиной — зелёное, объявление,
  // расходящееся с ходами, — красное. Без третьей «объявить» значило бы
  // «написать что угодно».
  const turn = (n, commit) =>
    readTurn({
      turn: { n, purpose: 'п', prompt: 'раз' },
      result: okResult({ index: { commit } }),
      latencyMs: 10,
    })
  const scenarios = () => [
    { id: 's1', title: 's1', sessionName: 'диалог', turns: Array.from({ length: 12 }, (_, at) => turn(at + 1, 'aaa1111')) },
    { id: 's2', title: 's2', sessionName: 'диалог', turns: Array.from({ length: 12 }, (_, at) => turn(at + 1, at < 2 ? 'aaa1111' : 'bbb2222')) },
  ]
  const bounds = { minTurns: 12 }

  const silent = buildReport({
    ranAt: '2026-10-05T16:07:00.000Z',
    note: 'проба',
    limits: { dailyCap: 50, reviewRounds: 1 },
    params: {},
    scenarios: scenarios(),
  })
  assert.equal(silent.index.mixedAccepted, undefined, 'объявление появилось без причины')
  assert.ok(
    checkReport(silent, bounds).some((p) => p.includes('индекс менялся')),
    'молчаливое смешение прошло',
  )

  const declared = buildReport({
    ranAt: '2026-10-05T16:07:00.000Z',
    note: 'проба',
    limits: { dailyCap: 50, reviewRounds: 1 },
    params: {},
    scenarios: scenarios(),
    mixedReason: 'выкатка пришлась на окно прогона',
  })
  assert.deepEqual(checkReport(declared, bounds), [], 'объявленное смешение не прошло')
  assert.deepEqual(declared.index.mixedAccepted.turns.bbb2222, [
    's2/3', 's2/4', 's2/5', 's2/6', 's2/7', 's2/8', 's2/9', 's2/10', 's2/11', 's2/12',
  ])

  // Пустая причина объявлением не считается: принять смешение можно только
  // сказав, почему.
  const blank = buildReport({
    ranAt: '2026-10-05T16:07:00.000Z',
    note: 'проба',
    limits: { dailyCap: 50, reviewRounds: 1 },
    params: {},
    scenarios: scenarios(),
    mixedReason: '   ',
  })
  assert.ok(
    checkReport(blank, bounds).some((p) => p.includes('индекс менялся')),
    'пустая причина сошла за объявление',
  )

  // Объявление, расходящееся с ходами: карту правят руками — так уже бывало.
  const lying = structuredClone(declared)
  lying.index.mixedAccepted.turns.bbb2222 = ['s2/3']
  assert.ok(
    checkReport(lying, bounds).some((p) => p.includes('расходится с ходами')),
    'вранье в объявлении прошло молча',
  )
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

test('пустая цель задачи с хода 2 валит сверку — второе механическое обещание ADR, п. 3.5', () => {
  // Обещание ADR, п. 3.5: цель непуста с хода 2 и далее. Проверка обязана
  // краснеть на её пустоте, иначе замер прошёл, а мерить было нечего.
  //
  // ЧЕГО ЭТА ПРОВЕРКА НЕ ЛОВИЛА — дефекта потолка TASK_ANSWER_TOKENS. На
  // прогоне 2026-10-05T11:38Z шестой вызов обрывался на 13 ходах из 18, но
  // цель в результате оставалась прежней (состояние несёт предыдущее, а не
  // пустое), и нарушений этого правила в том файле было НОЛЬ. Дефект показывал
  // признак `stored` — 5 из 18. Прежняя редакция этого комментария утверждала
  // обратное; утверждение снято, а не оставлено красивым.
  const turn = (n, goal) =>
    readTurn({
      turn: { n, purpose: 'п', prompt: 'раз' },
      result: okResult({ task: { ...okResult().task, goal } }),
      latencyMs: 10,
    })
  const scenario = (id, goals) => ({
    id,
    title: id,
    sessionName: 'диалог',
    turns: goals.map((goal, at) => turn(at + 1, goal)),
  })
  const report = (goals) => {
    const scenarios = [scenario('s1', goals), scenario('s2', goals)]
    return {
      ranAt: '2026-10-05T12:00:00.000Z',
      note: 'проба',
      limits: { dailyCap: 50, reviewRounds: 1 },
      index: { commit: 'abc1234', seen: ['abc1234'] },
      scenarios: scenarios.map((s) => ({ ...s, summary: summarize(s.turns) })),
    }
  }
  const full = Array.from({ length: 12 }, () => 'цель')
  assert.deepEqual(checkReport(report(full), { minTurns: 12 }), [], 'целая цель валит сверку')

  // Ход 1 без цели — ЗАКОННО: до первого ответа состояния не существует.
  const firstEmpty = [...full]
  firstEmpty[0] = ''
  assert.deepEqual(
    checkReport(report(firstEmpty), { minTurns: 12 }),
    [],
    'пустая цель на ходе 1 посчитана нарушением',
  )

  // Ход 5 без цели — нарушение, и оно названо.
  const fifthEmpty = [...full]
  fifthEmpty[4] = ''
  const problems = checkReport(report(fifthEmpty), { minTurns: 12 })
  assert.ok(
    problems.some((p) => p.includes('ход 5') && p.includes('цель задачи пуста')),
    `пустая цель с хода 2 прошла молча: ${problems.join('; ')}`,
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

test('пределы дня берутся у дня, а не стоят второй копией в прогоне', () => {
  // Разойдясь, две копии дали бы в отчёте не то число, под которым прогон шёл.
  const { env } = parseEnv({})
  assert.equal(DAY_LIMITS.MAX_DAILY_CALLS, env.MAX_DAILY_CALLS)
  assert.equal(DAY_LIMITS.RATE_LIMIT_PER_HOUR, env.RATE_LIMIT_PER_HOUR)
})

test('ключ оператора читается из файла, а отсутствие файла ошибкой не считается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'day25-key-'))
  const file = join(dir, 'eval.key')
  try {
    assert.equal(readEvalKey({ file }), null, 'нет файла — должно быть null, а не исключение')
    writeFileSync(file, '  секрет-прогона\n')
    assert.equal(readEvalKey({ file }), 'секрет-прогона', 'ключ не обрезан по краям')
    writeFileSync(file, '   \n')
    assert.equal(readEvalKey({ file }), null, 'пустой файл — не ключ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ключ уходит заголовком только на создание хода, а не на чтения', async () => {
  const day = fakeDay()
  const jar = createJar()
  await smoke({ base: 'http://day', jar, fetchImpl: day.fetchImpl })
  await runTurn({ base: 'http://day', prompt: 'раз', jar, fetchImpl: day.fetchImpl, key: 'к-1' })
  const answer = day.seen.find((s) => s.path.endsWith('/api/answer'))
  assert.equal(answer.key, 'к-1', 'ключ не доехал до платной ручки')
  // Лишний заголовок на каждой ручке — лишний путь утечки: окна снимаются у
  // платной, и только ей он и нужен.
  for (const seen of day.seen.filter((s) => !s.path.endsWith('/api/answer')))
    assert.equal(seen.key, null, `ключ ушёл на ${seen.path}`)
})

test('--rounds больше одного без ключа оператора не начинает прогон вовсе', async () => {
  // Окно часа (30 слотов на адрес) не пустит 24 хода по два слота, и узнать
  // это на пятнадцатом ходе — значит заплатить за четырнадцать впустую.
  const day = fakeDay()
  const dir = mkdtempSync(join(tmpdir(), 'day25-rounds-'))
  try {
    const lines = []
    const code = await main({
      argv: ['--rounds', '2', '--out', join(dir, 'eval.json'), '--base', 'http://day'],
      fetchImpl: day.fetchImpl,
      sleep: async () => {},
      readKey: () => null,
      log: (line) => lines.push(String(line)),
    })
    assert.equal(code, 1, 'прогон начался без ключа при пределе кругов 2')
    assert.ok(lines.some((l) => l.includes('окно часа')), lines.join(' | '))
    // Главное утверждение: НИ ОДНОГО запроса к дню, то есть денег не потрачено.
    assert.equal(day.seen.length, 0, `прогон успел сходить в день: ${day.seen.map((s) => s.path)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('прогон, которому слотов не хватит по потолку дня, не начинается вовсе', async () => {
  // 24 хода × 3 круга = 72 слота против потолка 50: такой прогон не дойдёт до
  // конца ни при каком стечении обстоятельств, и платить за первые его две
  // трети незачем. Ключ оператора тут не помогает — он снимает окна минуты и
  // часа, а суточный потолок остаётся (находка `reviewer` к PR #325).
  const day = fakeDay()
  const dir = mkdtempSync(join(tmpdir(), 'day25-cap-'))
  try {
    const lines = []
    const code = await main({
      argv: ['--rounds', '3', '--out', join(dir, 'eval.json'), '--base', 'http://day'],
      fetchImpl: day.fetchImpl,
      sleep: async () => {},
      // Ключ ЕСТЬ: иначе отказал бы запрет `--rounds` без ключа, и проверено
      // было бы не то.
      readKey: () => 'к-1',
      log: (line) => lines.push(String(line)),
    })
    assert.equal(code, 1, 'прогон начался, хотя слотов не хватит по потолку')
    assert.ok(
      lines.some((l) => l.includes('суточный потолок дня')),
      `причина не названа вслух: ${lines.join(' | ')}`,
    )
    // Главное утверждение: НИ ОДНОГО запроса к дню, то есть денег не потрачено.
    assert.equal(day.seen.length, 0, `прогон успел сходить в день: ${day.seen.map((s) => s.path)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('прогон, которому слотов хватает, проверку потолка проходит', async () => {
  // Проверка, что проверка выше не запрещает всё подряд: 24 хода × 2 круга =
  // 48 слотов против 50 — проходит, и прогон доходит до дня.
  const day = fakeDay()
  const dir = mkdtempSync(join(tmpdir(), 'day25-cap-ok-'))
  try {
    const lines = []
    await main({
      argv: ['--rounds', '2', '--out', join(dir, 'eval.json'), '--base', 'http://day'],
      fetchImpl: day.fetchImpl,
      sleep: async () => {},
      readKey: () => 'к-1',
      log: (line) => lines.push(String(line)),
    })
    assert.ok(day.seen.length > 0, `прогон не дошёл до дня: ${lines.join(' | ')}`)
    assert.equal(
      lines.some((l) => l.includes('суточный потолок дня')),
      false,
      `проверка потолка отказала законному прогону: ${lines.join(' | ')}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('готовый файл не затирается без --force, и запросов к дню при этом нет', async () => {
  // ДЕРЖАТЕЛЬ ПРАВИЛА О ДЕНЬГАХ: без него повтор прогона тихо стирает
  // оплаченный файл и тратит столько же ещё раз.
  const day = fakeDay()
  const dir = mkdtempSync(join(tmpdir(), 'day25-force-'))
  const file = join(dir, 'eval.json')
  writeFileSync(file, '{"уже":"лежит"}\n')
  try {
    const lines = []
    const code = await main({
      argv: ['--out', file, '--base', 'http://day'],
      fetchImpl: day.fetchImpl,
      sleep: async () => {},
      readKey: () => null,
      log: (line) => lines.push(String(line)),
    })
    assert.equal(code, 1, 'повтор прогона прошёл без --force')
    assert.ok(lines.some((l) => l.includes('нужен --force')), lines.join(' | '))
    assert.equal(day.seen.length, 0, 'прогон сходил в день, хотя файл уже лежал')
    assert.equal(readFileSync(file, 'utf8'), '{"уже":"лежит"}\n', 'лежавший файл изменён')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('профиль прогона удаляется за собой: мест под профиль пять', async () => {
  const day = fakeDay()
  const jar = createJar()
  const swept = await teardown({ base: 'http://day', jar, profileId: 'p1', fetchImpl: day.fetchImpl })
  assert.equal(swept.ok, true, swept.why)
  const gone = day.seen.find((s) => s.method === 'DELETE' && s.path.endsWith('/api/profile'))
  assert.ok(gone, 'удаления профиля не было')
  assert.match(String(gone.body), /"id":"p1"/, 'удалён не тот профиль')
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

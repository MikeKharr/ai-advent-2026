import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRuns, STAGES, STATUSES } from '../src/runs.js'

const AGENT = { id: 'news-analyst', version: '1.0.0' }

test('запуск: очередь → выполняется с первым событием, номера с единицы', () => {
  const runs = createRuns({ now: () => 1_000 })
  const run = runs.create({ agent: AGENT, input: { sphere: 'x' } })
  assert.equal(run.status, 'queued')

  const first = runs.emit(run.id, { stage: 'received', title: 'Получил запрос' })
  assert.equal(first.seq, 1)
  assert.equal(first.status, 'running', 'статус в событии — на момент события')
  assert.equal(run.status, 'running')
  assert.deepEqual(first.agent, AGENT)
  assert.equal(first.at, '1970-01-01T00:00:01.000Z')
  assert.equal(first.level, 'info')
  assert.equal(first.parentRunId, null)
  assert.equal(first.toolCallId, null)
  assert.equal(first.attempt, null)
  assert.equal(first.durationMs, null)

  const second = runs.emit(run.id, {
    stage: 'tool_call',
    title: 'x',
    toolCallId: 't1',
    durationMs: 12.6,
  })
  assert.equal(second.seq, 2)
  assert.equal(second.toolCallId, 't1')
  assert.equal(second.durationMs, 13)
})

test('контракт: стадии и статусы названы шире, чем нужно сегодня', () => {
  for (const s of ['planning', 'cancelled']) {
    assert.ok(STAGES.includes(s) || STATUSES.includes(s), `${s} зарезервирован`)
  }
  const runs = createRuns()
  const run = runs.create({ agent: AGENT, input: {} })
  assert.throws(() => runs.emit(run.id, { stage: 'thinking', title: 'x' }), /не в контракте/)
  assert.throws(
    () => runs.emit(run.id, { stage: 'guard', level: 'fatal', title: 'x' }),
    /не в контракте/,
  )
  assert.throws(() => runs.emit(run.id, { stage: 'guard' }), /без заголовка/)
})

test('подписка: сначала накопленные события, затем живые, затем end', () => {
  const runs = createRuns()
  const run = runs.create({ agent: AGENT, input: {} })
  runs.emit(run.id, { stage: 'received', title: 'a' })
  runs.emit(run.id, { stage: 'tool_call', title: 'b' })

  const got = []
  const off = runs.subscribe(run.id, (m) => got.push(m))
  assert.deepEqual(
    got.map((m) => m.event.title),
    ['a', 'b'],
    'накопленные пришли сразу',
  )

  runs.emit(run.id, { stage: 'guard', title: 'c' })
  runs.finish(run.id, {
    status: 'succeeded',
    result: { answer: 'x' },
    event: { stage: 'done', title: 'd' },
  })
  assert.deepEqual(
    got.map((m) => (m.type === 'event' ? m.event.title : 'END')),
    ['a', 'b', 'c', 'd', 'END'],
  )
  const end = got.at(-1)
  assert.equal(end.status, 'succeeded')
  assert.deepEqual(end.result, { answer: 'x' })
  assert.equal(
    got.at(-2).event.status,
    'succeeded',
    'терминальное событие несёт терминальный статус',
  )
  assert.equal(run.status, 'succeeded')
  assert.equal(run.listeners.size, 0, 'после end слушатели сняты')
  off()
})

test('подписка на готовый запуск: накопленное и сразу end', () => {
  const runs = createRuns()
  const run = runs.create({ agent: AGENT, input: {} })
  runs.finish(run.id, {
    status: 'failed',
    error: { code: 'x', message: 'y', paidNothing: true },
    event: { stage: 'error', level: 'error', title: 'z' },
  })
  const got = []
  runs.subscribe(run.id, (m) => got.push(m))
  assert.deepEqual(
    got.map((m) => m.type),
    ['event', 'end'],
  )
  assert.equal(got[1].error.code, 'x')
  assert.throws(() => runs.emit(run.id, { stage: 'guard', title: 'late' }), /уже завершён/)
})

test('отписка останавливает доставку', () => {
  const runs = createRuns()
  const run = runs.create({ agent: AGENT, input: {} })
  const got = []
  const off = runs.subscribe(run.id, (m) => got.push(m))
  off()
  runs.emit(run.id, { stage: 'received', title: 'a' })
  assert.equal(got.length, 0)
})

test('снимок без входа и без слушателей', () => {
  const runs = createRuns({ now: () => 5_000 })
  const run = runs.create({ agent: AGENT, input: { sphere: 'тайна', params: {} } })
  runs.emit(run.id, { stage: 'received', title: 'a' })
  const snap = runs.snapshot(run.id)
  assert.equal(snap.status, 'running')
  assert.equal(snap.events.length, 1)
  assert.equal(snap.createdAt, '1970-01-01T00:00:05.000Z')
  assert.equal(JSON.stringify(snap).includes('тайна'), false, 'вход — текст пользователя')
  assert.equal(runs.snapshot('нет'), null)
})

test('уборка: готовые запуски старше TTL уходят, незавершённые остаются', () => {
  let t = 0
  const runs = createRuns({ now: () => t, ttlMs: 100 })
  const done = runs.create({ agent: AGENT, input: {} })
  const live = runs.create({ agent: AGENT, input: {} })
  runs.finish(done.id, { status: 'succeeded', result: {}, event: { stage: 'done', title: 'd' } })
  runs.emit(live.id, { stage: 'received', title: 'a' })

  t = 50
  assert.equal(runs.sweep(), 0)
  t = 100
  assert.equal(runs.sweep(), 1)
  assert.equal(runs.get(done.id), null)
  assert.ok(runs.get(live.id), 'незавершённый живёт до терминального события')
})

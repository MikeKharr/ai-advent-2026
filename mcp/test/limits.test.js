import assert from 'node:assert/strict'
import test from 'node:test'
import { createLimiter } from '../src/limits.js'

const env = { RATE_LIMIT_PER_MIN: 3, RATE_LIMIT_PER_HOUR: 5, REFUSALS_PER_HOUR: 2 }

test('минутное окно закрывается и открывается через минуту', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.deepEqual(limiter.reserve('1.1.1.1').reason, 'minute')

  t += 61_000
  assert.equal(limiter.reserve('1.1.1.1').ok, true)
})

test('часовое окно считает поверх минутного', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.reserve('2.2.2.2').ok, true)
    t += 61_000
  }
  assert.equal(limiter.reserve('2.2.2.2').reason, 'hour')
})

test('пачка берётся целиком или не берётся вовсе', () => {
  const limiter = createLimiter(env, { now: () => 1_000_000 })
  assert.equal(limiter.reserve('3.3.3.3', 4).ok, false)
  // Ни одного слота при отказе не занято: следующие три проходят.
  assert.equal(limiter.reserve('3.3.3.3', 3).ok, true)
})

test('окна на адрес независимы', () => {
  const limiter = createLimiter(env, { now: () => 1_000_000 })
  for (let i = 0; i < 3; i += 1) limiter.reserve('4.4.4.4')
  assert.equal(limiter.reserve('5.5.5.5').ok, true)
})

test('адрес не живёт дольше часового окна (I-10)', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })
  limiter.reserve('6.6.6.6')
  assert.equal(limiter.stats().trackedIps, 1)

  t += 3_600_001
  limiter.reserve('7.7.7.7')
  assert.equal(limiter.stats().trackedIps, 1)
})

test('окно отказов исчерпывается и истекает через час', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  assert.equal(limiter.refusalsExhausted('8.8.8.8'), false)
  limiter.noteRefusal('8.8.8.8')
  assert.equal(limiter.refusalsExhausted('8.8.8.8'), false)
  limiter.noteRefusal('8.8.8.8')
  assert.equal(limiter.refusalsExhausted('8.8.8.8'), true)

  t += 3_600_001
  assert.equal(limiter.refusalsExhausted('8.8.8.8'), false)
})

test('окно отказов не трогает рабочие окна и наоборот', () => {
  const limiter = createLimiter(env, { now: () => 1_000_000 })

  limiter.noteRefusal('9.9.9.9')
  limiter.noteRefusal('9.9.9.9')
  assert.equal(limiter.refusalsExhausted('9.9.9.9'), true)
  // Отказы по ключу не съедают слоты вызовов инструментов.
  assert.equal(limiter.reserve('9.9.9.9', 3).ok, true)
})

test('окно отказов на адрес независимо', () => {
  const limiter = createLimiter(env, { now: () => 1_000_000 })
  limiter.noteRefusal('1.2.3.4')
  limiter.noteRefusal('1.2.3.4')
  assert.equal(limiter.refusalsExhausted('1.2.3.4'), true)
  assert.equal(limiter.refusalsExhausted('5.6.7.8'), false)
})

test('адрес отказов не живёт дольше часового окна (I-10)', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })
  limiter.noteRefusal('4.4.4.4')
  assert.equal(limiter.stats().refusedIps, 1)

  t += 3_600_001
  limiter.refusalsExhausted('5.5.5.5')
  assert.equal(limiter.stats().refusedIps, 0)
})

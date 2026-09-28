// Единственное отличие лимитера дня 20 от копии дня 16 — суточный потолок.
// Проверяется именно оно: окна на адрес доказаны тестами дня 16, и повторять
// их здесь значило бы проверять копию вместо добавления.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter } from '../limits.js'

const env = { RATE_LIMIT_PER_MIN: 1000, RATE_LIMIT_PER_HOUR: 1000, MAX_DAILY_CALLS: 3 }

test('суточный потолок не обходится сменой адреса', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 8, 28, 10) })
  assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.reserve('2.2.2.2').ok, true)
  assert.equal(limiter.reserve('3.3.3.3').ok, true)
  const denied = limiter.reserve('4.4.4.4')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'daily')
})

test('счётчик обнуляется на границе суток UTC, а не через 24 часа после первого вызова', () => {
  let t = Date.UTC(2026, 8, 28, 23, 30)
  const limiter = createLimiter(env, { now: () => t })
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.reserve('1.1.1.1').ok, false)
  t = Date.UTC(2026, 8, 29, 0, 1) // тридцать одна минута спустя, но новые сутки
  assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.stats().callsToday, 1)
})

test('отказ по суткам не обещает секунд до повтора — их неоткуда взять', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 8, 28, 10) })
  for (let i = 0; i < 3; i += 1) limiter.reserve('1.1.1.1')
  assert.equal(limiter.reserve('1.1.1.1').retryAfterSec, null)
})

// Лимитер дня 19 — копия days/day16/limits.js. Копия строки защиты копией
// держателя не сопровождается сама: тест дня 16 не краснеет при правке
// days/day19/limits.js — это разные файлы. Поэтому здесь свои держатели
// часового окна (RATE_LIMIT_PER_HOUR) и срока жизни адреса (sweep, I-10).
// Минутное окно держит `days/day19/test/server.test.js` исполнением.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter } from '../limits.js'

const env = { RATE_LIMIT_PER_MIN: 3, RATE_LIMIT_PER_HOUR: 5 }
const clock = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, tick: (ms) => (t += ms) }
}

test('часовое окно называет свои секунды, а не минутные', () => {
  const c = clock()
  const limiter = createLimiter(env, { now: c.now })
  // Пять запросов вразбивку, чтобы минутное окно нигде не сработало.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.reserve('a').ok, true)
    c.tick(61_000)
  }
  const denied = limiter.reserve('a')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'hour')
  // Первая отметка стоит на 5×61 = 305 с назад; час минус это — 3295 с.
  assert.equal(denied.retryAfterSec, 3295)
})

test('окна у адресов свои; хранение адреса не переживает окно (I-10)', () => {
  const c = clock()
  const limiter = createLimiter(env, { now: c.now })
  for (let i = 0; i < 3; i += 1) limiter.reserve('a')
  assert.equal(limiter.reserve('a').ok, false)
  assert.equal(limiter.reserve('b').ok, true, 'чужой адрес не наказан')
  assert.equal(limiter.stats().trackedIps, 2)
  c.tick(60 * 60_000 + 1)
  limiter.reserve('c')
  assert.equal(limiter.stats().trackedIps, 1, 'адреса старше часа стёрты')
})

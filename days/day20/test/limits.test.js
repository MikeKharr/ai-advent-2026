// Лимитер дня 20 — копия days/day16/limits.js плюс суточный потолок. Держатели
// здесь и у добавления, и у копии: тест дня 16 не краснеет при правке
// days/day20/limits.js — это разные файлы, и «доказано тестами дня 16» для
// окон на адрес было бы неправдой.

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

// Окна на адрес: суточный потолок им не мешает — он здесь заведомо недостижим.
const windows = { RATE_LIMIT_PER_MIN: 3, RATE_LIMIT_PER_HOUR: 5, MAX_DAILY_CALLS: 1000 }
const clock = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, tick: (ms) => (t += ms) }
}

test('часовое окно называет свои секунды, а не минутные', () => {
  const c = clock()
  const limiter = createLimiter(windows, { now: c.now })
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
  const limiter = createLimiter(windows, { now: c.now })
  for (let i = 0; i < 3; i += 1) limiter.reserve('a')
  assert.equal(limiter.reserve('a').ok, false)
  assert.equal(limiter.reserve('b').ok, true, 'чужой адрес не наказан')
  assert.equal(limiter.stats().trackedIps, 2)
  c.tick(60 * 60_000 + 1)
  limiter.reserve('c')
  assert.equal(limiter.stats().trackedIps, 1, 'адреса старше часа стёрты')
})

// Окна записей и чтений (ADR 2026-09-29-1600, п. 2). Они РАЗНЫЕ и своих
// отметок друг другу не отдают — иначе загрузка страницы съедала бы право
// очистить переписку.
const seam = {
  RATE_LIMIT_PER_MIN: 1000,
  RATE_LIMIT_PER_HOUR: 1000,
  RATE_LIMIT_WRITES_PER_HOUR: 2,
  RATE_LIMIT_READS_PER_HOUR: 3,
  MAX_DAILY_CALLS: 1000,
}

test('три окна считают порознь: исчерпанное не трогает соседние', () => {
  const limiter = createLimiter(seam, { now: () => 1_700_000_000_000 })
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserveRead('a').ok, true)
  assert.equal(limiter.reserveRead('a').ok, false, 'окно чтений не закрылось')
  assert.equal(limiter.reserveWrite('a').ok, true, 'чтения отняли право писать')
  assert.equal(limiter.reserve('a').ok, true, 'чтения отняли право запускать')
})

test('окно записей называет себя и свои секунды, а не окно запусков', () => {
  const c = clock()
  const limiter = createLimiter(seam, { now: c.now })
  assert.equal(limiter.reserveWrite('a').ok, true)
  c.tick(1000)
  assert.equal(limiter.reserveWrite('a').ok, true)
  const denied = limiter.reserveWrite('a')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'writes')
  assert.match(denied.message, /изменений переписки/)
  // Первая отметка стоит секунду назад: час минус это — 3599 с.
  assert.equal(denied.retryAfterSec, 3599)
})

test('окно чтений называет себя, а не окно записей', () => {
  const limiter = createLimiter(seam, { now: () => 1_700_000_000_000 })
  for (let i = 0; i < 3; i += 1) limiter.reserveRead('a')
  const denied = limiter.reserveRead('a')
  assert.equal(denied.reason, 'reads')
  assert.match(denied.message, /чтений страницы/)
})

test('отметки записей и чтений тоже не переживают своё окно (I-10)', () => {
  const c = clock()
  const limiter = createLimiter(seam, { now: c.now })
  limiter.reserveWrite('a')
  limiter.reserveRead('b')
  assert.deepEqual([limiter.stats().writeIps, limiter.stats().readIps], [1, 1])
  c.tick(60 * 60_000 + 1)
  limiter.reserve('c')
  assert.deepEqual([limiter.stats().writeIps, limiter.stats().readIps], [0, 0], 'адреса старше часа стёрты')
})

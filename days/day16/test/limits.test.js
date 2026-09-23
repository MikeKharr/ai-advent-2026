// Лимитер дня 16. Предмет — не «отказывает после N», а ЧИСЛО СЕКУНД в отказе:
// строка состояния страницы обязана назвать, когда можно повторить
// (раскладка 2026-09-23-1242, пп. 6.3 и 17.3). Число выводится из момента,
// когда освободится место, — из самой ранней отметки в окне, а не из размера окна.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter } from '../limits.js'

const env = { RATE_LIMIT_PER_MIN: 3, RATE_LIMIT_PER_HOUR: 5 }
const clock = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, tick: (ms) => (t += ms) }
}

test('минутное окно пускает ровно предел и отказывает следующему', () => {
  const c = clock()
  const limiter = createLimiter(env, { now: c.now })
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve('a').ok, true, `запрос ${i + 1}`)
  const denied = limiter.reserve('a')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'minute')
})

test('секунды до повтора считаются от САМОЙ РАННЕЙ отметки окна, а не от последней', () => {
  const c = clock()
  const limiter = createLimiter(env, { now: c.now })
  limiter.reserve('a') // t+0  — эта отметка уйдёт первой и освободит место
  c.tick(10_000)
  limiter.reserve('a') // t+10 с
  c.tick(10_000)
  limiter.reserve('a') // t+20 с
  c.tick(5_000) // прошло 25 с от первой
  const denied = limiter.reserve('a')
  assert.equal(denied.ok, false)
  // Первая отметка выпадет из минуты через 60 − 25 = 35 с. Если считать от
  // последней, получится 55 — посетитель прождёт лишние 20 с зря.
  assert.equal(denied.retryAfterSec, 35)
})

test('через названное число секунд запрос действительно проходит', () => {
  const c = clock()
  const limiter = createLimiter(env, { now: c.now })
  for (let i = 0; i < 3; i += 1) limiter.reserve('a')
  c.tick(7_000)
  const denied = limiter.reserve('a')
  assert.equal(denied.ok, false)
  // Ровно на секунду раньше — ещё отказ; на названной секунде — проход.
  c.tick((denied.retryAfterSec - 1) * 1000)
  assert.equal(limiter.reserve('a').ok, false, 'до названного срока места ещё нет')
  c.tick(1_000)
  assert.equal(limiter.reserve('a').ok, true, 'на названной секунде место есть')
})

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

test('на самой границе окна секунда целая, а не ноль: держит округление вверх', () => {
  const c = clock()
  const limiter = createLimiter(env, { now: c.now })
  for (let i = 0; i < 3; i += 1) limiter.reserve('a')
  // 1 мс до выпадения самой ранней отметки — тесней границы не бывает:
  // при `t - x < MINUTE` отметка на 60 000 мс в окно уже не попадает.
  // Округление вниз дало бы «повторите через 0 с» — приглашение к повтору,
  // который снова откажет.
  c.tick(59_999)
  const denied = limiter.reserve('a')
  assert.equal(denied.ok, false)
  assert.equal(denied.retryAfterSec, 1)
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

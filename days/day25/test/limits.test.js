// Лимитер дня 13 — модульно, на управляемых часах. Проверяется не «работает
// вообще», а два свойства, которые день 13 добавил к дню 10 и которые держат
// деньги: суточный потолок остаётся ЖЁСТКИМ при многослотовом резерве (I-5) и
// резерв выдаётся либо целиком, либо никак.
//
// Почему это отдельный файл, а не ещё один интеграционный тест: суточная ветка
// устроена как `callsToday + need > MAX_DAILY_CALLS`, и чтобы дойти до неё
// через сервер, пришлось бы сделать полсотни запусков. `createLimiter`
// принимает и окружение, и часы, поэтому граница проверяется в лоб.
//
// Лимитер дня 13 — СВОЙ файл, не общий с днём 11: у дня 11 суточная ветка
// написана как `callsToday >= limit` (слот всегда один), и сравнивать их
// нельзя. Правки здесь сданного дня не касаются.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter } from '../limits.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Окружение с широкими окнами: мешать должен ровно тот предел, что проверяем. */
const env = (over = {}) => ({
  MAX_DAILY_CALLS: 50,
  RATE_LIMIT_PER_MIN: 50,
  RATE_LIMIT_PER_HOUR: 50,
  RATE_LIMIT_WRITES_PER_HOUR: 50,
  ...over,
})

/** Часы, которые двигает тест: без них суточную границу не достать. */
const clock = (start = Date.parse('2026-09-22T10:00:00.000Z')) => {
  let t = start
  return { now: () => t, tick: (ms) => { t += ms } }
}

/* ---------- I-5: суточный потолок жёсткий ---------- */

test('израсходовано 4 из 5, профиль на 3 круга — отказ, счётчик не сдвинулся', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 5 }), { now: c.now })

  assert.equal(limiter.reserve('10.0.0.1', 4).ok, true)
  assert.equal(limiter.stats().callsToday, 4)

  // Трёх слотов до потолка не хватает: 4 + 3 > 5.
  const denied = limiter.reserve('10.0.0.2', 3)
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'daily')
  assert.match(denied.message, /[Сс]уточный лимит/)

  // Главное: частичной выдачи нет — ни одного слота из трёх не занято.
  assert.equal(limiter.stats().callsToday, 4, 'отказ не должен занимать слоты')
})

test('потолок берётся ровно, а следующий слот уже не выдаётся', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 5 }), { now: c.now })

  assert.equal(limiter.reserve('10.0.1.1', 4).ok, true)
  assert.equal(limiter.reserve('10.0.1.2', 1).ok, true, 'пятый слот — ровно потолок')
  assert.equal(limiter.stats().callsToday, 5)

  const over = limiter.reserve('10.0.1.3', 1)
  assert.equal(over.ok, false)
  assert.equal(over.reason, 'daily')
  assert.equal(limiter.stats().callsToday, 5)
})

test('суточный потолок общий для всех адресов: сменой адреса не обходится', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 4 }), { now: c.now })

  assert.equal(limiter.reserve('10.0.2.1', 2).ok, true)
  assert.equal(limiter.reserve('10.0.2.2', 2).ok, true)
  const fresh = limiter.reserve('10.0.2.99', 1)
  assert.equal(fresh.ok, false, 'новый адрес суточный потолок не обнуляет')
  assert.equal(fresh.reason, 'daily')
})

test('суточный счётчик обнуляется на новых сутках, а не по окну', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 3 }), { now: c.now })

  assert.equal(limiter.reserve('10.0.3.1', 3).ok, true)
  assert.equal(limiter.reserve('10.0.3.2', 1).ok, false)

  // Через два часа сутки те же — потолок держится.
  c.tick(2 * HOUR)
  assert.equal(limiter.reserve('10.0.3.3', 1).ok, false, 'два часа — это не новые сутки')

  // Следующий день по UTC.
  c.tick(24 * HOUR)
  assert.equal(limiter.reserve('10.0.3.4', 3).ok, true)
  assert.equal(limiter.stats().callsToday, 3)
})

/* ---------- либо все слоты, либо ни одного ---------- */

test('минутное окно: три круга не влезают в остаток, частичной выдачи нет', () => {
  const c = clock()
  const limiter = createLimiter(env({ RATE_LIMIT_PER_MIN: 4 }), { now: c.now })

  assert.equal(limiter.reserve('10.1.0.1', 3).ok, true)
  const denied = limiter.reserve('10.1.0.1', 3)
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'minute')
  assert.equal(limiter.stats().callsToday, 3, 'отказ минутного окна слотов не занимает')

  // Один слот в остатке ещё есть: предел считается слотами, а не сообщениями.
  assert.equal(limiter.reserve('10.1.0.1', 1).ok, true)
})

test('часовое окно отказывает целиком и своим словом', () => {
  const c = clock()
  const limiter = createLimiter(env({ RATE_LIMIT_PER_MIN: 3, RATE_LIMIT_PER_HOUR: 5 }), {
    now: c.now,
  })

  // По три слота с разносом больше минуты: минутное окно не мешает.
  assert.equal(limiter.reserve('10.2.0.1', 3).ok, true)
  c.tick(MINUTE + 1000)
  const denied = limiter.reserve('10.2.0.1', 3)
  assert.equal(denied.ok, false, '3 + 3 > 5 за час')
  assert.equal(denied.reason, 'hour')
  assert.equal(limiter.stats().callsToday, 3)

  // Двух хватает: граница ровная, а не «почти».
  assert.equal(limiter.reserve('10.2.0.1', 2).ok, true)
  assert.equal(limiter.stats().callsToday, 5)
})

test('часовое окно отпускает по сроку, суточный потолок — нет', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 6, RATE_LIMIT_PER_HOUR: 3 }), {
    now: c.now,
  })

  assert.equal(limiter.reserve('10.3.0.1', 3).ok, true)
  assert.equal(limiter.reserve('10.3.0.1', 1).ok, false, 'часовое окно выбрано')

  c.tick(HOUR + 1000)
  assert.equal(limiter.reserve('10.3.0.1', 3).ok, true, 'через час окно адреса свободно')
  // А суточный счётчик за это время не уменьшился: 3 + 3 = 6, потолок выбран.
  assert.equal(limiter.stats().callsToday, 6)
  assert.equal(limiter.reserve('10.3.0.9', 1).reason, 'daily')
})

/* ---------- возврат слотов ---------- */

test('вернуть больше, чем занято, нельзя — ни адресу, ни суткам', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 5 }), { now: c.now })

  assert.equal(limiter.reserve('10.4.0.1', 2).ok, true)
  assert.equal(limiter.stats().callsToday, 2)

  // Пометка агента «кругов было ноль» не должна чинить счётчик чужих запусков.
  limiter.release('10.4.0.1', 99)
  assert.equal(limiter.stats().callsToday, 0, 'счётчик не уходит ниже нуля')
  assert.equal(limiter.stats().trackedIps, 0, 'адрес без слотов не хранится дольше нужного')

  // И потолок после этого прежний, а не раздутый возвратом.
  assert.equal(limiter.reserve('10.4.0.2', 5).ok, true)
  assert.equal(limiter.reserve('10.4.0.3', 1).reason, 'daily')
})

test('возврат лишних кругов освобождает ровно столько, сколько вернули', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 10, RATE_LIMIT_PER_MIN: 4 }), {
    now: c.now,
  })

  assert.equal(limiter.reserve('10.5.0.1', 3).ok, true)
  // Круг был один — два слота назад.
  limiter.release('10.5.0.1', 2)
  assert.equal(limiter.stats().callsToday, 1)

  // В минутном окне снова свободно три из четырёх.
  assert.equal(limiter.reserve('10.5.0.1', 3).ok, true)
  assert.equal(limiter.reserve('10.5.0.1', 1).ok, false, 'больше, чем вернули, не появилось')
})

/* ---------- негодные значения ---------- */

test('негодное число слотов считается одним, а не нулём и не дырой', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 3 }), { now: c.now })

  for (const bad of [0, -5, 2.5, NaN, undefined, null, 'три']) {
    const before = limiter.stats().callsToday
    const r = limiter.reserve('10.6.0.1', bad)
    assert.equal(r.ok, true, `значение ${JSON.stringify(bad)}`)
    assert.equal(
      limiter.stats().callsToday,
      before + 1,
      `значение ${JSON.stringify(bad)} должно стоить ровно один слот`,
    )
    limiter.release('10.6.0.1', 1)
  }
})

/* ---------- окно записей профиля ---------- */

test('окно записей своё: оно не тратит и не чинит суточный потолок', () => {
  const c = clock()
  const limiter = createLimiter(env({ MAX_DAILY_CALLS: 2, RATE_LIMIT_WRITES_PER_HOUR: 2 }), {
    now: c.now,
  })

  assert.equal(limiter.reserveWrite('10.7.0.1').ok, true)
  assert.equal(limiter.reserveWrite('10.7.0.1').ok, true)
  const denied = limiter.reserveWrite('10.7.0.1')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'writes')
  // Записи модель не зовут — суточный счётчик вызовов они не двигают.
  assert.equal(limiter.stats().callsToday, 0)
  assert.equal(limiter.reserve('10.7.0.1', 2).ok, true)
})

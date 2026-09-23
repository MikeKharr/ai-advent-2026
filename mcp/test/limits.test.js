import assert from 'node:assert/strict'
import test from 'node:test'
import { createLimiter } from '../src/limits.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const env = { RATE_LIMIT_PER_MIN: 3, RATE_LIMIT_PER_HOUR: 5, REFUSAL_SIGNAL_PER_HOUR: 2 }

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

test('сигнал о переборе — ровно на том отказе, что перешёл порог', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  assert.deepEqual(limiter.noteRefusal('8.8.8.8'), { count: 1, signal: false })
  assert.deepEqual(limiter.noteRefusal('8.8.8.8'), { count: 2, signal: true })
  // Дальше счёт не идёт и сигнала нет: порог отвечен, а хранить сверх него
  // нечего — именно на этом росте служба и истощалась.
  assert.deepEqual(limiter.noteRefusal('8.8.8.8'), { count: 2, signal: false })
})

test('окно отказов истекает через час и сигнал может прозвучать снова', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  limiter.noteRefusal('8.8.8.8')
  assert.equal(limiter.noteRefusal('8.8.8.8').signal, true)

  t += 3_600_001
  assert.deepEqual(limiter.noteRefusal('8.8.8.8'), { count: 1, signal: false })
})

test('отказы не съедают слоты вызовов инструментов', () => {
  const limiter = createLimiter(env, { now: () => 1_000_000 })

  limiter.noteRefusal('9.9.9.9')
  limiter.noteRefusal('9.9.9.9')
  assert.equal(limiter.reserve('9.9.9.9', 3).ok, true)
})

test('счётчик отказов на адрес независим', () => {
  const limiter = createLimiter(env, { now: () => 1_000_000 })
  limiter.noteRefusal('1.2.3.4')
  assert.equal(limiter.noteRefusal('1.2.3.4').signal, true)
  assert.equal(limiter.noteRefusal('5.6.7.8').signal, false)
})

test('адрес отказов не живёт дольше часового окна (I-10)', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })
  limiter.noteRefusal('4.4.4.4')
  assert.equal(limiter.stats().refusedIps, 1)

  t += 3_600_001
  limiter.noteRefusal('5.5.5.5')
  assert.equal(limiter.stats().refusedIps, 1)
})

test('поток отказов не растёт: хранимых отметок не больше порога', () => {
  const limiter = createLimiter(env, { now: () => 1_000_000 })

  // Десять порогов подряд с одного адреса.
  for (let i = 0; i < env.REFUSAL_SIGNAL_PER_HOUR * 10; i += 1) limiter.noteRefusal('7.7.7.7')

  // Не «примерно столько» и не «меньше некоторого», а ровно порог: любая
  // форма, копящая отметки дальше, делает цену одного отказа линейной по
  // накопленному, а поток отказов — квадратичным. Это и было вето по PR #220.
  assert.equal(limiter.stats().refusalMarks, env.REFUSAL_SIGNAL_PER_HOUR)
  assert.equal(limiter.stats().refusedIps, 1)
})

test('насыщенное окно отказов истекает и считает заново', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  for (let i = 0; i < 50; i += 1) limiter.noteRefusal('7.7.7.7')
  assert.equal(limiter.stats().refusalMarks, env.REFUSAL_SIGNAL_PER_HOUR)

  t += 3_600_001
  assert.deepEqual(limiter.noteRefusal('7.7.7.7'), { count: 1, signal: false })
  assert.equal(limiter.stats().refusalMarks, 1)
})

test('замолчавший адрес убирается полным обходом, не позже минуты после окна', () => {
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  limiter.noteRefusal('6.6.6.6')
  assert.equal(limiter.stats().refusedIps, 1)

  // Час с минутой спустя первый же чужой запрос убирает замолчавший адрес.
  t += HOUR + MINUTE + 1
  limiter.noteRefusal('1.1.1.1')
  assert.equal(limiter.stats().refusedIps, 1)
  assert.equal(limiter.stats().refusalMarks, 1)
})

test('полный обход не чаще раза в минуту — этим куплена постоянная цена запроса', () => {
  // Предмет проверки — сам дроссель, а не его следствие. Тест про «не позже
  // минуты после окна» снятие дросселя НЕ нарушает: без дросселя адрес
  // убирается раньше, то есть следствие остаётся верным. Поэтому здесь
  // утверждается обратное: в окно между устареванием и следующим обходом
  // отметка ЕЩЁ на месте. Иначе единственная строка, которой куплена
  // постоянная цена запроса, охранялась бы одним комментарием — а её как раз
  // и захочется убрать тому, кто прочтёт про «час плюс минута» и сочтёт это
  // расхождением с I-10.
  let t = 1_000_000
  const limiter = createLimiter(env, { now: () => t })

  limiter.noteRefusal('A') // обход прошёл, отметка времени обхода — t
  t += HOUR - 30_000
  limiter.noteRefusal('B') // с обхода прошёл почти час: обход прошёл снова, A ещё жив

  t += 30_001 // A устарел, но с последнего обхода прошло лишь 30 с
  limiter.noteRefusal('B')
  assert.equal(limiter.stats().refusedIps, 2, 'полный обход зовётся чаще раза в минуту')

  t += 30_000 // минута с обхода истекла — замолчавший адрес убран
  limiter.noteRefusal('B')
  assert.equal(limiter.stats().refusedIps, 1)
})

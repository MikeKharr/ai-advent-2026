// Лимитер дня 24 — копия days/day20/limits.js без окна записей, плюс возврат
// суточного слота (решение владельца Р8(б), ADR 2026-10-05-0544). Держатели
// здесь свои: тест дня 20 не краснеет при правке days/day24/limits.js — это
// разные файлы, и «доказано тестами дня 20» было бы неправдой.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter } from '../limits.js'

const env = { RATE_LIMIT_PER_MIN: 1000, RATE_LIMIT_PER_HOUR: 1000, MAX_DAILY_CALLS: 3 }

test('суточный потолок не обходится сменой адреса', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 4, 10) })
  assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.reserve('2.2.2.2').ok, true)
  assert.equal(limiter.reserve('3.3.3.3').ok, true)
  const denied = limiter.reserve('4.4.4.4')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'daily')
  assert.match(denied.message, /Суточный предел вопросов/)
})

test('счётчик обнуляется на границе суток UTC, а не через 24 часа после первого вызова', () => {
  let t = Date.UTC(2026, 9, 4, 23, 30)
  const limiter = createLimiter(env, { now: () => t })
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.reserve('1.1.1.1').ok, false)
  t = Date.UTC(2026, 9, 5, 0, 1) // тридцать одна минута спустя, но новые сутки
  assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.stats().callsToday, 1)
})

test('отказ по суткам не обещает секунд до повтора — их неоткуда взять', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 4, 10) })
  for (let i = 0; i < 3; i += 1) limiter.reserve('1.1.1.1')
  assert.equal(limiter.reserve('1.1.1.1').retryAfterSec, null)
})

// Окна на адрес: суточный потолок им не мешает — он здесь заведомо недостижим.
const windows = { RATE_LIMIT_PER_MIN: 3, RATE_LIMIT_PER_HOUR: 5, MAX_DAILY_CALLS: 1000 }
const clock = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, tick: (ms) => (t += ms) }
}

test('минутное окно называет себя и свои секунды', () => {
  const c = clock()
  const limiter = createLimiter(windows, { now: c.now })
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve('a').ok, true)
  const denied = limiter.reserve('a')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'minute')
  assert.equal(denied.retryAfterSec, 60)
})

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

// Два окна (ADR 2026-09-29-1600, п. 2): запуски и чтения. Они РАЗНЫЕ и своих
// отметок друг другу не отдают — иначе чтение потока событий съедало бы право
// задать следующий вопрос.
const seam = {
  RATE_LIMIT_PER_MIN: 1000,
  RATE_LIMIT_PER_HOUR: 1000,
  RATE_LIMIT_READS_PER_HOUR: 3,
  MAX_DAILY_CALLS: 1000,
}

test('два окна считают порознь: исчерпанное не трогает соседнее', () => {
  const limiter = createLimiter(seam, { now: () => 1_700_000_000_000 })
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserveRead('a').ok, true)
  assert.equal(limiter.reserveRead('a').ok, false, 'окно чтений не закрылось')
  assert.equal(limiter.reserve('a').ok, true, 'чтения отняли право задать вопрос')
})

test('окно чтений называет себя и свои секунды, а не окно запусков', () => {
  const c = clock()
  const limiter = createLimiter(seam, { now: c.now })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.reserveRead('a').ok, true)
    c.tick(1000)
  }
  const denied = limiter.reserveRead('a')
  assert.equal(denied.reason, 'reads')
  assert.match(denied.message, /чтений страницы/)
  // Первая отметка стоит три секунды назад: час минус это — 3597 с.
  assert.equal(denied.retryAfterSec, 3597)
})

test('отметки чтений тоже не переживают своё окно (I-10)', () => {
  const c = clock()
  const limiter = createLimiter(seam, { now: c.now })
  limiter.reserveRead('b')
  assert.equal(limiter.stats().readIps, 1)
  c.tick(60 * 60_000 + 1)
  limiter.reserve('c')
  assert.equal(limiter.stats().readIps, 0, 'адреса старше часа стёрты')
})

// Окна записей у дня НЕТ, и это не упущение копии: ручки, правящей общую базу
// сервиса, у дня 22 не бывает (сессий и переписки нет). Если такую ручку
// однажды заведут, `reserveWrite` не окажется под рукой «на всякий случай» —
// окно придётся завести осознанно.
test('окна записей у лимитера дня нет', () => {
  const limiter = createLimiter(seam, { now: () => 1_700_000_000_000 })
  assert.equal(limiter.reserveWrite, undefined)
})

// ВОЗВРАТ СУТОЧНОГО СЛОТА (решение владельца Р8(б), ADR 2026-10-05-0544, п. 6).
// Порядок «лимитер до сервиса» занимает слот до разбора тела, поэтому пустой
// вопрос стоил денег, которых никто не потратил. Возврат чинит именно это — и
// ровно это: окна на адрес он не трогает.

test('возвращённый суточный слот снова доступен, и потолок не обойдён', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 4, 10) })
  const slot = limiter.reserve('1.1.1.1')
  assert.equal(slot.ok, true)
  assert.equal(limiter.stats().callsToday, 1)
  assert.equal(limiter.release(slot), true)
  assert.equal(limiter.stats().callsToday, 0)
  // Потолок остался потолком: три запуска после возврата всё так же упираются.
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.reserve('1.1.1.1').ok, false)
})

test('слот возвращается ОДИН раз: вторым вызовом чужого в минус не списать', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 4, 10) })
  const mine = limiter.reserve('1.1.1.1')
  limiter.reserve('2.2.2.2')
  assert.equal(limiter.stats().callsToday, 2)
  assert.equal(limiter.release(mine), true)
  // Второй вызов — мимо: иначе одна ручка с двумя ветвями отказа списала бы
  // слот соседа.
  assert.equal(limiter.release(mine), false)
  assert.equal(limiter.stats().callsToday, 1)
  // Чего лимитер не выдавал, слотом не становится: ручка вне окна (`open`)
  // получает `slot === null`, и возврат по нему списал бы чужой слот.
  for (const bad of [null, undefined, {}, { ok: false, reason: 'daily' }])
    assert.equal(limiter.release(bad), false, JSON.stringify(bad))
  assert.equal(limiter.stats().callsToday, 1)
})

test('после полуночи слот не возвращается: счётчик уже чужой', () => {
  let t = Date.UTC(2026, 9, 4, 23, 59)
  const limiter = createLimiter(env, { now: () => t })
  const slot = limiter.reserve('1.1.1.1')
  t = Date.UTC(2026, 9, 5, 0, 1)
  limiter.reserve('1.1.1.1') // новые сутки, счётчик уже обнулён и равен 1
  assert.equal(limiter.stats().callsToday, 1)
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ: вернись слот вчерашних суток, сегодняшний счётчик ушёл
  // бы в ноль, и сутки получили бы лишний платный запуск.
  assert.equal(limiter.release(slot), false)
  assert.equal(limiter.stats().callsToday, 1)
})

test('возврат суточного слота НЕ возвращает окна на адрес: они про частоту', () => {
  const tight = { RATE_LIMIT_PER_MIN: 2, RATE_LIMIT_PER_HOUR: 100, MAX_DAILY_CALLS: 1000 }
  const limiter = createLimiter(tight, { now: () => Date.UTC(2026, 9, 4, 10) })
  const a = limiter.reserve('1.1.1.1')
  const b = limiter.reserve('1.1.1.1')
  limiter.release(a)
  limiter.release(b)
  // Запрос БЫЛ сделан, и залп пустых тел обязан упираться в минутное окно так
  // же, как залп настоящих вопросов, — иначе возврат слота сам стал бы дырой.
  const third = limiter.reserve('1.1.1.1')
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'minute')
})

// ПОМЕТКА `spent` — ТО, ЧЕМ ГРАНИЦА ДЕРЖИТСЯ КОДОМ. Знает факт обращения к
// сервису только обработчик, решает по нему лимитер: помеченный слот не
// отпускается, сколько бы раз возврат ни звали.
test('помеченный слот не возвращается, а снятая пометка возвращает его снова', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 4, 10) })
  const slot = limiter.reserve('1.1.1.1')
  // Свежий слот помечен не бывает: иначе первый же отказ дня съедал бы потолок.
  assert.equal(slot.spent, false)
  slot.spent = true
  assert.equal(limiter.release(slot), false, 'обращение состоялось, а слот вернули')
  assert.equal(limiter.stats().callsToday, 1)
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ: 400 сервиса приходит до создания запуска, обработчик
  // снимает пометку — и слот возвращается (решение владельца 2026-10-05).
  slot.spent = false
  assert.equal(limiter.release(slot), true)
  assert.equal(limiter.stats().callsToday, 0)
})

// Счётчик не уходит в минус даже при чужом слоте тех же суток: возврат мимо
// своего резерва — дефект вызывающего, но дыры в потолке он не делает.
test('возврат не загоняет суточный счётчик ниже нуля', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 4, 10) })
  const slot = limiter.reserve('1.1.1.1')
  assert.equal(limiter.release(slot), true)
  assert.equal(limiter.stats().callsToday, 0)
  assert.equal(limiter.release({ ok: true, day: '2026-10-04', spent: false, returned: false }), false)
  assert.equal(limiter.stats().callsToday, 0)
})

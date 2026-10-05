// Лимитер дня 23 — копия days/day20/limits.js без окна записей, плюс возврат
// слота на 4xx (ADR 2026-10-05-0544, Р8(б)). Держатели
// здесь свои: тест дня 20 не краснеет при правке days/day22/limits.js — это
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

// ——— возврат слота суточного потолка (ADR 2026-10-05-0544, Р8(б)) ———
//
// Сквозная проверка через живой сервер — `test/slot-return.test.js`. Здесь
// границы возврата: что он отдаёт, чего НЕ отдаёт и когда отказывается.

test('возврат отдаёт суточный слот — и его можно занять снова', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 5, 10) })
  const slot = limiter.reserve('1.1.1.1')
  assert.equal(limiter.stats().callsToday, 1)
  assert.equal(limiter.release(slot), true)
  assert.equal(limiter.stats().callsToday, 0, 'слот не вернулся')
  // Потолок от этого не исчез: три запуска по-прежнему его исчерпывают.
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.reserve('1.1.1.1').ok, true)
  assert.equal(limiter.reserve('1.1.1.1').ok, false)
})

test('ОТМЕТКИ ОКОН НА АДРЕС возврат НЕ отдаёт — иначе поток 4xx стал бы бесплатным', () => {
  // Минутное окно по единице: если возврат отдавал бы и отметку адреса,
  // второй запрос с того же адреса прошёл бы.
  const tight = { RATE_LIMIT_PER_MIN: 1, RATE_LIMIT_PER_HOUR: 1000, MAX_DAILY_CALLS: 100 }
  const limiter = createLimiter(tight, { now: () => Date.UTC(2026, 9, 5, 10) })
  const slot = limiter.reserve('1.1.1.1')
  assert.equal(slot.ok, true)
  assert.equal(limiter.release(slot), true)
  const second = limiter.reserve('1.1.1.1')
  assert.equal(second.ok, false, 'возврат отдал и отметку окна на адрес')
  assert.equal(second.reason, 'minute')
})

test('возврат идемпотентен: второй вызов счётчик не трогает', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 5, 10) })
  limiter.reserve('1.1.1.1')
  const slot = limiter.reserve('2.2.2.2')
  assert.equal(limiter.release(slot), true)
  assert.equal(limiter.release(slot), false, 'тот же слот вернулся дважды')
  assert.equal(limiter.stats().callsToday, 1, 'счётчик уехал ниже занятого')
})

test('возврат не касается ни отказа, ни чужого слота, ни мусора', () => {
  const limiter = createLimiter(env, { now: () => Date.UTC(2026, 9, 5, 10) })
  for (let i = 0; i < 3; i += 1) limiter.reserve('1.1.1.1')
  const denied = limiter.reserve('1.1.1.1')
  assert.equal(denied.ok, false)
  // Отказ слота не занимал — возвращать нечего. Иначе потолок отпускал бы
  // сам себя: каждый отказ 429 дарил бы запуск.
  assert.equal(limiter.release(denied), false)
  assert.equal(limiter.stats().callsToday, 3)
  for (const junk of [null, undefined, {}, { ok: true }, 'слот', 7])
    assert.equal(limiter.release(junk), false, String(junk))
  assert.equal(limiter.stats().callsToday, 3)
})

test('слот ЧУЖИХ СУТОК не возвращается: иначе он дарил бы запуск следующему дню', () => {
  let t = Date.UTC(2026, 9, 5, 23, 59)
  const limiter = createLimiter(env, { now: () => t })
  const slot = limiter.reserve('1.1.1.1')
  assert.equal(limiter.stats().callsToday, 1)
  t = Date.UTC(2026, 9, 6, 0, 1) // новые сутки: счётчик уже обнулён
  assert.equal(limiter.release(slot), false, 'слот прошлых суток уменьшил счётчик новых')
  assert.equal(limiter.stats().callsToday, 0)
})

test('слот чтения суточный счётчик не трогает ни при занятии, ни при возврате', () => {
  const limiter = createLimiter(
    { ...env, RATE_LIMIT_READS_PER_HOUR: 10 },
    { now: () => Date.UTC(2026, 9, 5, 10) },
  )
  limiter.reserve('1.1.1.1')
  const read = limiter.reserveRead('1.1.1.1')
  assert.equal(read.ok, true)
  assert.equal(limiter.release(read), false, 'возврат чтения уменьшил суточный счётчик')
  assert.equal(limiter.stats().callsToday, 1)
})

// Именные ключи модели без встроенных отказов: модуль сверки
// (ADR 2026-10-07-1349, п. 2, п. 7).
//
// ЧЕСТНАЯ ГРАНИЦА про `timingSafeEqual`: тест ниже держит ПРИСУТСТВИЕ пути
// сравнения через `timingSafeEqual` — читает исходник модуля и проверяет, что
// импорт и вызов на месте. Времени он не измеряет и измерить не может: на
// тестовой машине разброс планировщика перекрывает разницу в наносекундах.
// Выдавать эту проверку за измерение времени было бы неправдой. То же — у
// «сверки без короткого замыкания»: тест держит отсутствие `break`/`return`
// внутри цикла и ПОВЕДЕНИЕ (совпадает и первое имя, и последнее), а не
// постоянство числа сравнений во времени.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createModelKeys, MODEL_KEY_HEADER, parseModelKeys, safeEqual } from '../src/model-keys.js'

const here = dirname(fileURLToPath(import.meta.url))

const MIKE = 'M'.repeat(32)
const GUEST = 'G'.repeat(32)
const ENTRIES = [
  { name: 'mike', value: MIKE },
  { name: 'guest1', value: GUEST },
]

const request = (value) => ({ headers: value === undefined ? {} : { [MODEL_KEY_HEADER]: value } })

// --- Разбор MODEL_KEYS ----------------------------------------------------

test('MODEL_KEYS разбирается в пары имя:значение', () => {
  const { entries, notes } = parseModelKeys(`mike:${MIKE},guest1:${GUEST}`)
  assert.deepEqual(entries, ENTRIES)
  assert.deepEqual(notes, [])
})

test('пустая и отсутствующая MODEL_KEYS — ни одной записи', () => {
  for (const raw of ['', '   ', undefined, null]) {
    assert.deepEqual(parseModelKeys(raw).entries, [], JSON.stringify(raw))
  }
})

test('негодная запись отбрасывается с замечанием, годные рядом с ней живут', () => {
  const { entries, notes } = parseModelKeys(`безДвоеточия,ПЛОХОЕ-ИМЯ:${MIKE},short:abc,mike:${MIKE}`)
  assert.deepEqual(
    entries.map((e) => e.name),
    ['mike'],
    'уцелела только годная запись: опечатка в чужом ключе не уносит свой',
  )
  assert.deepEqual(notes.map((n) => n.event), [
    'model_key_malformed',
    'model_key_bad_name',
    'model_key_too_short',
  ])
  // Значения в замечания не попадают: они идут в журнал процесса.
  assert.equal(JSON.stringify(notes).includes(MIKE), false)
  assert.equal(JSON.stringify(notes).includes('abc'), false)
})

test('повторённое имя: вторая запись отброшена, первая действует', () => {
  const { entries, notes } = parseModelKeys(`mike:${MIKE},mike:${GUEST}`)
  assert.deepEqual(entries, [{ name: 'mike', value: MIKE }])
  assert.equal(notes[0].event, 'model_key_duplicate_name')
})

// --- Выключенная возможность ----------------------------------------------

test('пустая MODEL_KEYS — возможности нет вовсе: любой заголовок отказ', () => {
  const keys = createModelKeys({ entries: [] })
  assert.equal(keys.enabled, false)
  for (const value of ['', MIKE, 'что угодно']) {
    const out = keys.check({ req: request(value), remote: 'a' })
    assert.equal(out.ok, false, JSON.stringify(value))
    assert.equal(out.status, 403)
    assert.equal(out.code, 'bad_model_key')
  }
})

test('пустой заголовок при пустой переменной не совпадает: сравнения пустых строк нет', () => {
  const keys = createModelKeys({ entries: [] })
  assert.equal(keys.check({ req: request(''), remote: 'a' }).ok, false)
  // Отрицательный контроль: при настроенных ключах пустой заголовок — тоже
  // отказ, а не «ключа нет». Иначе опечатка рождала бы открытый профиль (Б8).
  const live = createModelKeys({ entries: ENTRIES })
  const out = live.check({ req: request(''), remote: 'a' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'bad_model_key')
})

// --- Сверка ---------------------------------------------------------------

test('без заголовка имени нет и отказа нет: это путь открытого профиля', () => {
  const keys = createModelKeys({ entries: ENTRIES })
  assert.deepEqual(keys.check({ req: request(undefined), remote: 'a' }), { ok: true, name: null })
  assert.equal(keys.presented(request(undefined)), false)
  assert.equal(keys.presented(request('')), true, 'пустая строка — заголовок предъявлен')
})

test('верное значение даёт имя своего ключа — и первое, и последнее в списке', () => {
  const keys = createModelKeys({ entries: ENTRIES })
  // Оба конца списка: сверка идёт по всем записям, и совпадение последней
  // обязано находиться так же, как совпадение первой.
  assert.deepEqual(keys.check({ req: request(MIKE), remote: 'a' }), { ok: true, name: 'mike' })
  assert.deepEqual(keys.check({ req: request(GUEST), remote: 'a' }), { ok: true, name: 'guest1' })
})

test('чужое значение — 403 bad_model_key, и ни имени, ни значения в ответе', () => {
  const keys = createModelKeys({ entries: ENTRIES })
  const presented = 'ОЧЕНЬ-СЕКРЕТНОЕ-ЗНАЧЕНИЕ'
  const out = keys.check({ req: request(presented), remote: 'a' })
  assert.equal(out.status, 403)
  assert.equal(out.code, 'bad_model_key')
  const dump = JSON.stringify(out)
  assert.equal(dump.includes(presented), false, 'предъявленного значения в ответе нет')
  assert.equal(dump.includes(MIKE), false, 'настоящего значения тоже нет')
  assert.equal(dump.includes('mike'), false, 'и имени нет: отказ не называет имён')
})

test('модуль сверяет через timingSafeEqual и не замыкается на совпадении', () => {
  const source = readFileSync(join(here, '..', 'src', 'model-keys.js'), 'utf8')
  assert.match(source, /import \{ timingSafeEqual \} from 'node:crypto'/)
  assert.match(source, /timingSafeEqual\(ba, bb\)/)
  // Цикл сверки без выхода изнутри: ни `break`, ни `return` между `for` и
  // его закрытием. Это строка, а не измерение времени (см. шапку файла).
  const loop = source.slice(
    source.indexOf('for (const entry of entries)'),
    source.indexOf('if (matched === null)'),
  )
  assert.notEqual(loop, '', 'цикл сверки на месте')
  assert.equal(/\bbreak\b/.test(loop), false, 'короткого замыкания в цикле нет')
  assert.equal(/\breturn\b/.test(loop), false, 'выхода из цикла нет')
  // Поведение того же пути: без него проверка исходника держала бы мёртвую строку.
  assert.equal(safeEqual(MIKE, MIKE), true)
  assert.equal(safeEqual(MIKE, `${MIKE}x`), false)
  assert.equal(safeEqual(MIKE, 'M'), false)
  assert.equal(safeEqual(null, MIKE), false)
})

// --- Окно неудачных попыток -----------------------------------------------

test('после N отказов за минуту адрес получает 429 ДО сверки ключа', () => {
  let clock = 1_000_000
  const keys = createModelKeys({ entries: ENTRIES, failsPerMin: 3, now: () => clock })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(keys.check({ req: request('чужой'), remote: 'x' }).status, 403)
  }
  // Четвёртая попытка — с ВЕРНЫМ ключом. Если бы окно стояло после сверки,
  // она прошла бы: именно это и различает две гипотезы.
  const out = keys.check({ req: request(MIKE), remote: 'x' })
  assert.equal(out.status, 429)
  assert.equal(out.code, 'too_many_attempts')
  assert.equal(Number(out.headers['retry-after']) > 0, true)

  // Окно на АДРЕС: сосед не наказан за чужой залп.
  assert.deepEqual(keys.check({ req: request(MIKE), remote: 'y' }), { ok: true, name: 'mike' })

  // По истечении минуты окно снимается.
  clock += 61_000
  assert.deepEqual(keys.check({ req: request(MIKE), remote: 'x' }), { ok: true, name: 'mike' })
})

// --- Суточный потолок на имя (решение владельца 8) ------------------------

test('2001-й запуск имени — 429 с датой сброса, 2000 проходят', () => {
  let clock = Date.UTC(2026, 9, 8, 9, 0, 0)
  const keys = createModelKeys({ entries: ENTRIES, dailyCap: 2000, now: () => clock })
  for (let i = 0; i < 2000; i += 1) {
    assert.equal(keys.charge('mike').ok, true, `запуск ${i + 1}`)
  }
  assert.equal(keys.used('mike'), 2000)
  const out = keys.charge('mike')
  assert.equal(out.ok, false)
  assert.equal(out.status, 429)
  assert.equal(out.code, 'model_key_daily_cap')
  assert.equal(out.resetAt, '2026-10-09T00:00:00.000Z', 'сброс — следующие сутки UTC')
  // Потолок на ИМЯ, а не на весь ключ: сосед по MODEL_KEYS не наказан.
  assert.equal(keys.charge('guest1').ok, true)
  // Новые сутки — счётчик с нуля.
  clock += 24 * 3600_000
  assert.equal(keys.used('mike'), 0)
  assert.equal(keys.charge('mike').ok, true)
})

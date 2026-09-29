// Поверхность управления: модуль ключа (ADR 2026-09-28-1820, п. 2, ▲).
//
// Ключ — единственная преграда: сеть владелец решил не закрывать, зная цену.
// Поэтому каждое свойство здесь имеет держатель, а не комментарий.
//
// ЧЕСТНАЯ ГРАНИЦА про `timingSafeEqual`: тест ниже держит ПРИСУТСТВИЕ пути
// сравнения через `timingSafeEqual` — читает исходник модуля и проверяет, что
// импорт и вызов на месте. Времени он не измеряет и измерить не может: на
// тестовой машине разброс планировщика перекрывает разницу в наносекундах.
// Выдавать эту проверку за измерение времени было бы неправдой.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createControlKey, FORBIDDEN_KEY_HEADER, safeEqual } from '../src/control/key.js'
import { CONTROL_KEY_MIN_CHARS, parseEnv } from '../src/env.js'

const here = dirname(fileURLToPath(import.meta.url))
const KEY = 'K'.repeat(44)

const request = (headers = {}) => ({ headers, socket: { remoteAddress: '10.0.0.7' } })
const address = (search = '') => new URL(`http://agents:8086/control/profiles${search}`)

const bearerReq = (value) => request({ authorization: `Bearer ${value}` })

// --- Форма предъявления: только `Authorization: Bearer` --------------------

test('годный ключ в заголовке Bearer проходит', () => {
  const key = createControlKey({ key: KEY, failsPerMin: 10 })
  assert.deepEqual(key.check({ req: bearerReq(KEY), url: address(), remote: 'a' }), { ok: true })
})

test('ключ в строке адреса — 401, даже если значение верное', () => {
  const key = createControlKey({ key: KEY, failsPerMin: 10 })
  // Отрицательный контроль: тот же верный ключ и в заголовке тоже. Без него
  // зелёный результат удовлетворяла бы и гипотеза «пустой Bearer не подошёл».
  const out = key.check({ req: bearerReq(KEY), url: address(`?key=${KEY}`), remote: 'a' })
  assert.equal(out.ok, false)
  assert.equal(out.status, 401)
  assert.equal(out.code, 'unauthorized')
})

test('ключ в своём заголовке X-Control-Key — 401, даже если значение верное', () => {
  const key = createControlKey({ key: KEY, failsPerMin: 10 })
  const req = request({ authorization: `Bearer ${KEY}`, [FORBIDDEN_KEY_HEADER]: KEY })
  const out = key.check({ req, url: address(), remote: 'a' })
  assert.equal(out.ok, false)
  assert.equal(out.status, 401)
})

test('401 несёт WWW-Authenticate: Bearer realm="control"', () => {
  const key = createControlKey({ key: KEY, failsPerMin: 10 })
  const out = key.check({ req: bearerReq('чужой'), url: address(), remote: 'a' })
  assert.equal(out.headers['www-authenticate'], 'Bearer realm="control"')
})

test('ответ отказа не содержит предъявленного значения ни в одном поле', () => {
  const key = createControlKey({ key: KEY, failsPerMin: 10 })
  const presented = 'ОЧЕНЬ-СЕКРЕТНОЕ-ЗНАЧЕНИЕ'
  const out = key.check({ req: bearerReq(presented), url: address(), remote: 'a' })
  assert.equal(JSON.stringify(out).includes(presented), false)
  // И настоящего ключа тоже нет: 401 не должен рассказывать, с чем сравнивали.
  assert.equal(JSON.stringify(out).includes(KEY), false)
})

// --- Сравнение постоянного времени: держатель ПРИСУТСТВИЯ пути -------------

test('модуль ключа импортирует timingSafeEqual и сравнивает через него', () => {
  const source = readFileSync(join(here, '..', 'src', 'control', 'key.js'), 'utf8')
  assert.match(source, /import \{ timingSafeEqual \} from 'node:crypto'/)
  assert.match(source, /timingSafeEqual\(ba, bb\)/)
  // Поведение того же пути: равные строки равны, разные — нет, разная длина
  // не бросает. Без этого проверка исходника держала бы мёртвую строку.
  assert.equal(safeEqual(KEY, KEY), true)
  assert.equal(safeEqual(KEY, `${KEY}x`), false)
  assert.equal(safeEqual(KEY, 'K'), false)
  assert.equal(safeEqual(null, KEY), false)
})

// --- Окно неудачных попыток -----------------------------------------------

test('после N отказов за минуту адрес получает 429 до конца окна, до сравнения ключа', () => {
  let clock = 1_000_000
  const key = createControlKey({ key: KEY, failsPerMin: 3, now: () => clock })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(key.check({ req: bearerReq('чужой'), url: address(), remote: 'x' }).status, 401)
  }
  // Четвёртая попытка — с ВЕРНЫМ ключом. Если бы окно стояло после сравнения,
  // она прошла бы: именно это и различает две гипотезы.
  const out = key.check({ req: bearerReq(KEY), url: address(), remote: 'x' })
  assert.equal(out.status, 429)
  assert.equal(out.code, 'too_many_attempts')
  assert.equal(Number(out.headers['retry-after']) > 0, true)

  // Окно на АДРЕС: сосед не наказан за чужой залп.
  assert.deepEqual(key.check({ req: bearerReq(KEY), url: address(), remote: 'y' }), { ok: true })

  // По истечении минуты окно снимается.
  clock += 61_000
  assert.deepEqual(key.check({ req: bearerReq(KEY), url: address(), remote: 'x' }), { ok: true })
})

// --- Выключенная поверхность ----------------------------------------------

test('без ключа поверхность выключена: 503 control_disabled, а не 401', () => {
  const key = createControlKey({ key: null, failsPerMin: 10 })
  const out = key.check({ req: bearerReq(KEY), url: address(), remote: 'a' })
  assert.equal(out.status, 503)
  assert.equal(out.code, 'control_disabled')
  assert.equal(key.enabled, false)
})

// --- Разбор окружения: три причины выключения, каждая со своей записью -----

const parse = (extra) =>
  parseEnv({ AGENT_KEY: 'ключ-сервиса', ROUTER_APP_KEY: 'ключ-приложения', STORE_FILE: '', ...extra })

test('CONTROL_KEY короче предела считается незаданным и называет причину', () => {
  const short = 'k'.repeat(CONTROL_KEY_MIN_CHARS - 1)
  const { env, errors, notes } = parse({ CONTROL_KEY: short })
  assert.equal(env.CONTROL_KEY, null)
  // Сервис при этом ПОДНИМАЕТСЯ: дни 6–20 живут в том же процессе.
  assert.deepEqual(errors, [])
  assert.equal(notes.some((n) => n.event === 'control_key_too_short'), true)
  // Отрицательный контроль: ключ годной длины остаётся на месте.
  assert.equal(parse({ CONTROL_KEY: 'k'.repeat(CONTROL_KEY_MIN_CHARS) }).env.CONTROL_KEY.length, CONTROL_KEY_MIN_CHARS)
})

test('CONTROL_KEY, равный AGENT_KEY, обнуляется записью control_key_same_as_agent', () => {
  const same = 'A'.repeat(44)
  const { env, errors, notes } = parse({ AGENT_KEY: same, CONTROL_KEY: same })
  assert.equal(env.CONTROL_KEY, null)
  assert.deepEqual(errors, [])
  const note = notes.find((n) => n.event === 'control_key_same_as_agent')
  assert.notEqual(note, undefined)
  // Само значение в замечание не попадает: записи уходят в журнал процесса.
  assert.equal(note.message.includes(same), false)
})

test('CONTROL_KEY, равный ROUTER_APP_KEY, обнуляется записью control_key_same_as_app', () => {
  const same = 'B'.repeat(44)
  const { env, notes } = parse({ ROUTER_APP_KEY: same, CONTROL_KEY: same })
  assert.equal(env.CONTROL_KEY, null)
  const note = notes.find((n) => n.event === 'control_key_same_as_app')
  assert.notEqual(note, undefined)
  assert.equal(note.message.includes(same), false)
})

test('несовпадающий ключ годной длины поверхность включает', () => {
  const { env, notes } = parse({ CONTROL_KEY: KEY })
  assert.equal(env.CONTROL_KEY, KEY)
  assert.equal(notes.some((n) => String(n.event).startsWith('control_key_')), false)
})

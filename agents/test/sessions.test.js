// Хранилище диалогов. Требует Node 24 (там `node:sqlite` без флага) или
// Node 22 с `--experimental-sqlite`.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSessions, isSessionId } from '../src/sessions.js'

const HOUR = 3600_000
const open = (opts = {}) =>
  createSessions({ file: ':memory:', ttlMs: 30 * HOUR, log: () => {}, ...opts })

test('переписка сохраняется и читается в порядке разговора', () => {
  const s = open()
  s.append({ sessionId: 'a', role: 'user', text: 'что нового в финтехе', tokens: 12 })
  s.append({
    sessionId: 'a',
    role: 'agent',
    text: 'Вот дайджест',
    tokens: 40,
    runId: 'r1',
    meta: { model: 'claude-haiku-4-5', articles: 30 },
  })
  const history = s.history('a')
  assert.deepEqual(
    history.map((m) => m.role),
    ['user', 'agent'],
  )
  assert.equal(history[1].meta.model, 'claude-haiku-4-5')
  assert.equal(history[1].runId, 'r1')
  assert.match(history[0].at, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(s.history('нет такой'), [], 'чужая сессия пуста')
  s.close()
})

test('переписка переживает перезапуск: файл на томе, а не память процесса', () => {
  const dir = mkdtempSync(join(tmpdir(), 'day7-db-'))
  const file = join(dir, 'nested', 'sessions.db')
  const first = createSessions({ file, ttlMs: 30 * HOUR, log: () => {} })
  first.append({ sessionId: 'a', role: 'user', text: 'помнишь меня?', tokens: 10 })
  first.close()

  const second = createSessions({ file, ttlMs: 30 * HOUR, log: () => {} })
  assert.equal(second.history('a')[0].text, 'помнишь меня?')
  second.close()
})

test('хвост набирается целыми сообщениями и укладывается в бюджет', () => {
  const s = open()
  for (let i = 1; i <= 5; i++)
    s.append({ sessionId: 'a', role: i % 2 ? 'user' : 'agent', text: `реплика ${i}`, tokens: 100 })

  const tail = s.tail('a', 250)
  assert.equal(tail.tokens, 200, 'третье сообщение не влезло целиком — не берём половину')
  assert.deepEqual(
    tail.messages.map((m) => m.text),
    ['реплика 4', 'реплика 5'],
    'взяты самые свежие, порядок восстановлен',
  )
  assert.equal(s.tail('a', 10_000).messages.length, 5, 'широкий бюджет берёт всё')
  assert.equal(s.tail('a', 250).dropped, 3, 'три прежние реплики не поместились')
  assert.deepEqual(
    s.tail('a', 50),
    { messages: [], tokens: 0, dropped: 5 },
    'не влезает ничего — пусто, но выпавшие посчитаны',
  )
  s.close()
})

test('записи об ошибках в контекст не идут', () => {
  // Текст ошибки написали мы, а не модель: подавать его как реплику агента
  // значит учить модель на собственных сообщениях об отказе.
  const s = open()
  s.append({ sessionId: 'a', role: 'user', text: 'вопрос', tokens: 10 })
  s.append({
    sessionId: 'a',
    role: 'agent',
    text: 'Модель не ответила: таймаут',
    tokens: 10,
    meta: { error: true },
  })
  s.append({ sessionId: 'a', role: 'user', text: 'ещё раз', tokens: 10 })

  assert.deepEqual(
    s.tail('a', 1000).messages.map((m) => m.text),
    ['вопрос', 'ещё раз'],
  )
  assert.equal(s.history('a').length, 3, 'в чате ошибка видна, в контексте — нет')
  s.close()
})

test('очистка удаляет переписку сессии и не трогает соседнюю', () => {
  const s = open()
  s.append({ sessionId: 'a', role: 'user', text: 'моё', tokens: 10 })
  s.append({ sessionId: 'b', role: 'user', text: 'чужое', tokens: 10 })
  assert.equal(s.clear('a'), 1)
  assert.deepEqual(s.history('a'), [])
  assert.equal(s.history('b').length, 1)
  assert.equal(s.stats().sessions, 1)
  s.close()
})

test('срок хранения: сессия без активности 30 часов удаляется целиком', () => {
  let t = 1_000_000
  const s = open({ now: () => t })
  s.append({ sessionId: 'старая', role: 'user', text: 'давно', tokens: 10 })
  t += 20 * HOUR
  s.append({ sessionId: 'живая', role: 'user', text: 'недавно', tokens: 10 })

  t += 11 * HOUR // старой 31 час, живой 11
  assert.equal(s.sweep(), 1)
  assert.deepEqual(s.history('старая'), [])
  assert.equal(s.history('живая').length, 1)
  assert.equal(s.stats().messages, 1)
  s.close()
})

test('новое сообщение продлевает жизнь сессии', () => {
  let t = 1_000_000
  const s = open({ now: () => t })
  s.append({ sessionId: 'a', role: 'user', text: 'раз', tokens: 10 })
  t += 29 * HOUR
  s.append({ sessionId: 'a', role: 'user', text: 'два', tokens: 10 })
  t += 29 * HOUR // с первого сообщения 58 часов, с последнего — 29
  assert.equal(s.sweep(), 0)
  assert.equal(s.history('a').length, 2)
  s.close()
})

test('форма идентификатора сессии проверяется', () => {
  assert.equal(isSessionId('00000000-0000-4000-8000-000000000000'), true)
  assert.equal(isSessionId('../../etc/passwd'), false)
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId(42), false)
})

test('роль чужого вида в базу не попадает', () => {
  const s = open()
  assert.throws(
    () => s.append({ sessionId: 'a', role: 'system', text: 'x', tokens: 1 }),
    /CHECK|constraint/i,
  )
  s.close()
})

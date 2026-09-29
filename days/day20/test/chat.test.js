// Правила разговора дня 20 исполнением (days/day20/public/chat.js). DOM здесь
// не поднимается: единственная функция с DOM в модуле отделена и не ввозится.
//
// Предмет файла — то, чего у экрана НЕ должно быть: подставленных значений на
// месте отсутствующих полей и склейки кругов разных ходов в один.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clockOf, countLine, lastRounds, messageTitle, NO_TIME, parseChat, parseMessage } from '../public/chat.js'

const agent = (text, meta) => ({ role: 'agent', text, at: '2026-09-29T11:07:00.000Z', meta })

test('реплики разбираются по ролям, чужая роль становится ответом агента, а не пропадает', () => {
  const out = parseChat({ messages: [{ role: 'user', text: 'раз' }, { role: 'system', text: 'два' }] })
  assert.deepEqual(out.map((m) => m.role), ['user', 'agent'])
  assert.equal(out[1].text, 'два')
})

test('тела ответа нет вовсе — переписка пустая, а не выдуманная', () => {
  assert.deepEqual(parseChat(null), [])
  assert.deepEqual(parseChat({ messages: 'нет' }), [])
})

test('времени у реплики нет — так и говорится, нуля вместо неизвестного не ставится', () => {
  assert.equal(clockOf(null), NO_TIME)
  assert.equal(clockOf('не дата'), NO_TIME)
  assert.match(messageTitle(parseMessage({ role: 'user', text: 'раз' })), /вы · время не записано/)
})

test('число вызовов хода стоит в подписи ответа; не записано — строки нет, а не «0»', () => {
  assert.match(messageTitle(parseMessage(agent('итог', { calls: 3 }))), /вызовов: 3/)
  const unknown = messageTitle(parseMessage(agent('итог', {})))
  assert.ok(!unknown.includes('вызовов'), unknown)
  // Ноль вызовов — это ЗАПИСАННЫЙ ноль, и он показывается: модель ответила
  // без инструментов, и это факт хода, а не отсутствие данных.
  assert.match(messageTitle(parseMessage(agent('итог', { calls: 0 }))), /вызовов: 0/)
})

test('отказавший ход подписан отказом, а не числом вызовов', () => {
  assert.match(messageTitle(parseMessage(agent('', { error: true, calls: 2 }))), /ход не дал ответа/)
})

test('слова кругов из переписки разбираются так же, как живое событие', () => {
  const m = parseMessage(agent('итог', { rounds: [{ round: 1, text: 'смотрю', chosen: [{ server: 'mcpnews', tool: 'news.search' }] }] }))
  assert.equal(m.rounds.length, 1)
  assert.equal(m.rounds[0].round, 1)
  assert.deepEqual(m.rounds[0].chosen, [{ server: 'mcpnews', tool: 'news.search' }])
})

test('лента хода берёт круги ПОСЛЕДНЕГО ответа: склейка ходов выдала бы за один ход то, чего не было', () => {
  const messages = parseChat({
    messages: [
      { role: 'user', text: 'раз' },
      agent('первый', { rounds: [{ round: 1, text: 'ход один' }] }),
      { role: 'user', text: 'два' },
      agent('второй', { rounds: [{ round: 1, text: 'ход два' }] }),
    ],
  })
  const rounds = lastRounds(messages)
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].text, 'ход два')
})

test('ответов агента в переписке нет — восстанавливать нечего, и это пустой список', () => {
  assert.deepEqual(lastRounds(parseChat({ messages: [{ role: 'user', text: 'раз' }] })), [])
})

test('счётчик считает реплики, а не ходы', () => {
  assert.equal(countLine([]), 'сообщений: 0')
  assert.equal(countLine([1, 2, 3]), 'сообщений: 3')
})

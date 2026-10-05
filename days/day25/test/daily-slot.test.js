// Решение владельца Р8(б) (ADR 2026-10-05-0544, п. 6): слот суточного потолка
// берётся ДО разбора тела — порядок «лимитер до сервиса» (I-4) сохранён, — а
// отказ 4xx его ВОЗВРАЩАЕТ: модель не вызывалась, платить не за что. В дне 22
// пустой вопрос стоил слота, и это был пункт «Владельцу» в бэклоге.
//
// Почему суточный потолок, а не окно минуты: окно минуты заживает само,
// суточный — нет. Шесть негодных тел подряд при потолке три должны кончиться
// тем, что законный ход ВСЁ РАВНО проходит.
//
// Улика различает гипотезы: один и тот же код 429 пришёл бы и от окна минуты,
// поэтому минута и час здесь заведомо недостижимы, а текст отказа сверяется
// дословно — «Суточный лимит…». Второй тест держит обратное утверждение:
// ОПЛАЧЕННЫЙ ход слот тратит, то есть потолок вообще работает.
//
// Мутация, на которой тест краснеет: убрать `run?.settle()` из `dispatch`
// (`days/day25/server.js`) — строка в блоке `finally`, исполняется на каждом
// запросе под платным окном.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const PID = '11111111-1111-4111-8111-111111111111'

/** @type {string[]} журнал стенда: сюда попадает только то, что дошло до сервиса. */
const seen = []

const agents = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk
  seen.push(`${req.method} ${req.url.split('?')[0]}`)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, draft: { variants: ['правило'], ticket: 't' } }))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key-secret-daily-do-not-leak'
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Минута и час заведомо недостижимы: отказ, если он придёт, обязан быть
// суточным, иначе тест мерил бы не то окно.
process.env.RATE_LIMIT_PER_MIN = '1000'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '1000'
process.env.MAX_DAILY_CALLS = '3'

const { server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const draft = (body) =>
  fetch(`${base}/api/invariants/draft`, {
    method: 'POST',
    headers: {
      'x-forwarded-for': '10.8.0.1',
      cookie: `day25_pid=${PID}`,
      'content-type': 'application/json',
    },
    body,
  })

test('отказ 4xx возвращает слот суточного потолка: шесть негодных тел при потолке три', async () => {
  seen.length = 0
  for (let i = 0; i < 6; i += 1) {
    const res = await draft('это не JSON')
    assert.equal(res.status, 400, `запрос ${i + 1}: негодное тело ответило не 400`)
    const body = await res.json()
    assert.equal(body.error, 'тело не JSON')
  }
  // До сервиса не дошло ничего: отказ формы тела разбирается у нас, и денег
  // он не стоил. Это и отличает «слот вернули» от «слот потратили, но сервис
  // промолчал».
  assert.deepEqual(seen, [], `негодное тело всё-таки ушло в сервис: ${JSON.stringify(seen)}`)

  const ok = await draft(JSON.stringify({ text: 'ответ короче пяти строк' }))
  assert.equal(ok.status, 200, 'законный ход не прошёл: шесть отказов 4xx съели суточный потолок')
  assert.deepEqual(seen, [`POST /v1/profiles/${PID}/invariants/draft`])
})

test('оплаченный ход слот тратит: суточный потолок три кончается на четвёртом', async () => {
  // Один слот уже израсходован тестом выше.
  for (let i = 0; i < 2; i += 1) {
    const res = await draft(JSON.stringify({ text: 'ещё одно правило' }))
    assert.equal(res.status, 200, `ход ${i + 2} из трёх не прошёл`)
  }
  seen.length = 0
  const over = await draft(JSON.stringify({ text: 'четвёртое правило' }))
  assert.equal(over.status, 429)
  const body = await over.json()
  assert.equal(body.error, 'Суточный лимит запросов к модели исчерпан. Попробуйте завтра.')
  assert.deepEqual(seen, [], 'отказ суточного потолка дошёл до сервиса')
})

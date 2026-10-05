// Единственная пометка на слоте, которая у дня есть: `ctx.run.refund()` у
// ответа 200 ручки паузы «запуск уже завершился».
//
// ПРЕДМЕТ. «Продолжить» у запуска с прерванным вызовом берёт слот суточного
// потолка под повтор вызова — слот до работы, как велит I-4. Но если к этому
// моменту запуск уже кончился сам, служба отвечает 409, повтора НЕ БЫЛО, и
// платить не за что. Ответ при этом обязан быть 200: это объяснение, а не
// отказ (требование владельца 2026-09-22), — поэтому правило «4xx возвращает
// слот» здесь слепо, и слово службы доносит пометка.
//
// Канон дня 23 такого случая не знает: ручки паузы у него нет вовсе. Значит
// держатель нужен здесь, иначе пометку снимут как «лишнюю» (ровно это и
// случилось бы: у дня 23 она названа мёртвой).
//
// УЛИКА РАЗЛИЧАЕТ ГИПОТЕЗЫ: суточный потолок — единица, окна частоты заведомо
// недостижимы, и текст отказа сверяется дословно. Без возврата первое же
// нажатие съедает весь суточный потолок, и это видно И на втором нажатии, И на
// законном ходе после него.
//
// Мутация, на которой тест краснеет: убрать `ctx.run.refund()` из `finished()`
// (`days/day25/server.js`) — строка исполняется на каждом таком нажатии.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const PID = '11111111-1111-4111-8111-111111111111'
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const RUN = '00000000-0000-4000-8000-0000000000dd'

/** @type {string[]} журнал стенда: что дошло до службы. */
const seen = []

const agents = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk
  const [path] = req.url.split('?')
  seen.push(`${req.method} ${path}`)
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  if (path === `/v1/profiles/${PID}`)
    return json(200, {
      ok: true,
      // Предел кругов — один: ход занимает ровно один слот, и арифметика
      // суточного потолка в единицу остаётся читаемой.
      profile: { id: PID, name: 'стенд', stagedSettings: { reviewRounds: 1 } },
    })
  // Диалог с ПРЕРВАННЫМ вызовом: именно он заставляет ручку паузы взять слот.
  if (path === `/v1/sessions/${SID}`)
    return json(200, {
      ok: true,
      messages: [],
      run: { id: RUN, status: 'running', state: 'answer', paused: true, interruptedCall: true },
      task: null,
    })
  // Служба говорит: запуск уже завершился. Повтора вызова не было.
  if (path === `/v1/runs/${RUN}/pause`)
    return json(409, { ok: false, code: 'finished', message: 'Запуск уже завершён' })
  if (path === '/v1/runs') return json(202, { ok: true, runId: RUN })
  return json(200, { ok: true, sessionId: SID })
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key-secret-resume-do-not-leak'
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
process.env.RATE_LIMIT_PER_MIN = '1000'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '1000'
process.env.MAX_DAILY_CALLS = '1'

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

const headers = {
  'x-forwarded-for': '10.11.0.1',
  cookie: `day25_pid=${PID}; day25_sid=${SID}`,
  'content-type': 'application/json',
}
const resume = () =>
  fetch(`${base}/api/run/pause`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ paused: false }),
  })

test('«Продолжить» у завершившегося запуска не стоит суточного слота', async () => {
  // Два нажатия при суточном потолке 1: без возврата второе упёрлось бы в
  // потолок, а объяснение «запуск уже завершился» превратилось бы в отказ.
  for (let i = 0; i < 2; i += 1) {
    const res = await resume()
    assert.equal(res.status, 200, `нажатие ${i + 1} отказано`)
    const body = await res.json()
    assert.equal(body.finished, true)
    assert.equal(body.message, 'Запуск уже завершился. Чем он кончился — смотрите в переписке.')
  }
  // И потолок по-прежнему цел: законный ход проходит.
  seen.length = 0
  const asked = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'что держит порядок лимитера?' }),
  })
  assert.equal(asked.status, 202, 'нажатия на объяснение съели суточный потолок')
  assert.equal((await asked.json()).reserved, 1)
  assert.ok(seen.includes('POST /v1/runs'), `до службы запуск не дошёл: ${JSON.stringify(seen)}`)
})

test('а оплаченный ход слот тратит: суточный потолок единица', async () => {
  // Обратное утверждение: возврат не сломал сам потолок. Один ход уже
  // состоялся тестом выше, второй обязан упереться — его словами.
  seen.length = 0
  const over = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'ещё раз' }),
  })
  assert.equal(over.status, 429)
  assert.equal(
    (await over.json()).error,
    'Суточный лимит запросов к модели исчерпан. Попробуйте завтра.',
  )
  // Отказ суточного потолка приходит после бесплатного чтения настроек и до
  // создания запуска: `POST /v1/runs` в журнале стенда нет.
  assert.equal(seen.includes('POST /v1/runs'), false, JSON.stringify(seen))
})

// ВОЗВРАТ СУТОЧНОГО СЛОТА — через живой http, по наблюдаемому поведению, а не
// по внутреннему счётчику: наружу его не отдаёт никто (`/healthz` счётчиков не
// печатает намеренно). Поэтому предмет наблюдения — сколько платных запусков
// день ещё примет после отказов 4xx.
//
// Файл отдельный, потому что суточный потолок разбирается при загрузке модуля
// сервера: здесь он маленький (3), а в `server.test.js` заведомо недостижимый.
// Каждый файл `node --test` запускает своим процессом, поэтому два потолка
// уживаются.
//
// Стенд ≠ прод: подменён ТОЛЬКО сервис агентов. Что запрос дошёл именно до
// стенда, доказывает его журнал `seen`, а не код ответа.
//
// Решение — ADR 2026-10-05-0544, п. 6 (развилка Р8, вариант «б»).

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const KEY = 'agent-key-secret-day24-do-not-leak'
const DAILY = 3

/** @type {{url:string,body:string}[]} журнал стенда */
const seen = []
let next = { status: 202, body: { runId: 'run-24' } }

const agents = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  seen.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') })
  res.writeHead(next.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(next.body))
})
await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Окна на адрес заведомо недостижимы: предмет здесь — суточный потолок.
process.env.RATE_LIMIT_PER_MIN = '1000'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_READS_PER_HOUR = '1000'
process.env.MAX_DAILY_CALLS = String(DAILY)

const { server } = await import('../server.js')
let base = ''
let ip = 0
const head = () => ({ 'content-type': 'application/json', 'x-forwarded-for': `10.24.0.${(ip += 1)}` })

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const ask = (body) =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: head(),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('отказы 4xx не съедают суточный потолок, а 502 и 202 — съедают', async () => {
  seen.length = 0
  // Четыре отказа РАЗНЫХ ветвей обработчика, и у каждой свой `reject`: тело не
  // JSON, пустой вопрос, слишком длинный вопрос, отказ формы от сервиса.
  const refused = [
    await ask('{не json'),
    await ask({ question: '   ' }),
    await ask({ question: 'я'.repeat(601) }),
  ]
  for (const res of refused) assert.equal(res.status, 400, await res.clone().text())
  next = { status: 400, body: { message: 'Поле question пустое' } }
  const fromService = await ask({ question: 'вопрос' })
  assert.equal(fromService.status, 400)
  // Улика стенда: до него дошёл ровно один из четырёх отказов — тот, который
  // отказал он сам. Три первых не доехали, и платить за них было не за что.
  assert.equal(seen.length, 1, JSON.stringify(seen))

  // 502 слот НЕ возвращает: там сервис агентов мог дойти до вызова модели, и
  // утверждать обратное день не вправе. Это и различающий случай: вернись слот
  // и здесь, удачных запусков ниже поместилось бы на один больше.
  next = { status: 500, body: { code: 'oops' } }
  const broken = await ask({ question: 'вопрос' })
  assert.equal(broken.status, 502)

  // ГЛАВНОЕ: четыре отказа 4xx потолка не тронули, а один 502 — съел слот.
  // Значит, запусков осталось DAILY − 1, и ни одним больше.
  next = { status: 202, body: { runId: 'run-24' } }
  for (let i = 0; i < DAILY - 1; i += 1) {
    const res = await ask({ question: `вопрос ${i}` })
    assert.equal(res.status, 202, `запуск ${i + 1} из ${DAILY - 1} отказан после отказов 4xx`)
  }
  // А удачные запуски потолок съели — возврат не отменил его вовсе.
  const over = await ask({ question: 'лишний' })
  assert.equal(over.status, 429)
  const body = await over.json()
  assert.match(body.error, /Суточный предел вопросов/)
  // У суточного отказа секунд до повтора нет и взяться им неоткуда.
  assert.equal(body.retryAfterSec, null)
})

// ВОЗВРАТ СУТОЧНОГО СЛОТА — через живой http, по наблюдаемому поведению, а не
// по внутреннему счётчику: наружу его не отдаёт никто (`/healthz` счётчиков не
// печатает намеренно). Поэтому предмет наблюдения — сколько платных запусков
// день ещё примет после отказов, наступивших до вызова модели.
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
const DAILY = 4

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

test('отказы ДО вызова модели потолка не съедают, а 502 и 202 — съедают', async () => {
  seen.length = 0
  // Три отказа РАЗНЫХ ветвей обработчика, и все три — ДО сервиса: тело не
  // JSON, пустой вопрос, слишком длинный вопрос.
  const refused = [
    await ask('{не json'),
    await ask({ question: '   ' }),
    await ask({ question: 'я'.repeat(601) }),
  ]
  for (const res of refused) assert.equal(res.status, 400, await res.clone().text())
  // Улика стенда: до него не дошёл НИ ОДИН из трёх. Это и есть граница
  // возврата: платить было не за что, потому что ничего не ушло.
  assert.equal(seen.length, 0, JSON.stringify(seen))

  // ЧЕТВЁРТЫЙ ОТКАЗ ДО ВЫЗОВА МОДЕЛИ — 400 самого сервиса агентов. Он приходит
  // ДО создания запуска (сервис разбирает вход раньше, чем заводит запуск), и
  // слот возвращает тоже: граница проведена по РАСХОДУ, а не по тому, уходил
  // ли запрос из процесса (решение владельца 2026-10-05). Улика стенда: запись
  // в его журнале появилась, то есть запрос до него дошёл — и всё равно не
  // стоил слота.
  next = { status: 400, body: { message: 'Поле question пустое' } }
  const fromService = await ask({ question: 'вопрос' })
  assert.equal(fromService.status, 400)
  assert.equal(seen.length, 1, 'запрос до стенда не дошёл — проверка проверила не то')

  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ: 502 слот НЕ возвращает — там сервис мог дойти до
  // вызова модели, и утверждать обратное день не вправе.
  next = { status: 500, body: { code: 'oops' } }
  const broken = await ask({ question: 'вопрос' })
  assert.equal(broken.status, 502)
  assert.equal(seen.length, 2)

  // ГЛАВНОЕ: четыре отказа до вызова модели потолка не тронули, а один 502 —
  // съел слот. Значит, запусков осталось DAILY − 1, и ни одним больше.
  next = { status: 202, body: { runId: 'run-24' } }
  for (let i = 0; i < DAILY - 1; i += 1) {
    const res = await ask({ question: `вопрос ${i}` })
    assert.equal(res.status, 202, `запуск ${i + 1} из ${DAILY - 1} отказан после отказов до вызова`)
  }
  // А удачные запуски потолок съели — возврат не отменил его вовсе.
  const over = await ask({ question: 'лишний' })
  assert.equal(over.status, 429)
  const body = await over.json()
  assert.match(body.error, /Суточный предел вопросов/)
  // У суточного отказа секунд до повтора нет и взяться им неоткуда.
  assert.equal(body.retryAfterSec, null)
})

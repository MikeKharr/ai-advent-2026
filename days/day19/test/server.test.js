// Интеграционный тест: настоящий сервер дня против ПОДДЕЛЬНОГО сервиса агентов
// на локальном порту. Предмет проверки:
//
//   1. ключ AGENT_KEY не появляется ни в одном ответе (I-1), а до сервиса
//      агентов доходит — и это видно по ЖУРНАЛУ стенда, не по коду ответа;
//   2. поток событий уходит на страницу насквозь, байт в байт: тела JSON-RPC
//      внутри стадии `rpc` и есть предмет показа;
//   3. слот лимитера берётся ДО обращения к сервису (I-4);
//   4. идентификатор запуска из URL не уходит в сервис не проверенным.
//
// Стенд НЕ пересказывает представление автора о сервисе: он записывает всё,
// что получил, и отдаёт то, что ему велено, — иначе тест проверял бы согласие
// заглушки с кодом, а не код.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

// Ключ только из ASCII: значение заголовка — ByteString.
const KEY = 'agent-key-secret-7c1b-do-not-leak'

/** @type {{method:string,url:string,headers:object,body:string}[]} журнал стенда */
const seen = []
let runsReply = { status: 202, body: JSON.stringify({ runId: 'run-abc' }) }
/** Точные байты потока событий, которые стенд отдаст на /events. */
let eventsBody = ''
let eventsStatus = 200

const agents = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString() })

  if (req.url.endsWith('/events')) {
    if (eventsStatus !== 200) {
      res.writeHead(eventsStatus, { 'content-type': 'application/json' })
      return res.end('{"error":"нет"}')
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(eventsBody)
    return res.end()
  }
  res.writeHead(runsReply.status, { 'content-type': 'application/json' })
  res.end(runsReply.body)
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
process.env.RATE_LIMIT_PER_MIN = '3'
process.env.RATE_LIMIT_PER_HOUR = '6'
process.env.MAX_DAILY_CALLS = '5'

const { env, server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const post = (task, ip = '10.0.0.1') =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ task }),
  })

test('/healthz зелёный при заданном ключе и не печатает сам ключ', async () => {
  const res = await fetch(`${base}/healthz`)
  const text = await res.text()
  assert.equal(res.status, 200)
  assert.ok(!text.includes(KEY), 'ключ в /healthz')
})

test('запуск создаётся: стенд ВИДЕЛ запрос с ключом — свидетельство из его журнала', async () => {
  seen.length = 0
  const res = await post('fintech', '10.0.0.2')
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { runId: 'run-abc' })

  // Улика — запись стенда, а не код ответа: код 202 стенд отдал бы и без ключа.
  const entry = seen.find((s) => s.url === '/v1/runs')
  assert.ok(entry, 'сервис агентов запроса не видел')
  assert.equal(entry.headers.authorization, `Bearer ${KEY}`)
  assert.equal(JSON.parse(entry.body).agent, env.AGENT_ID)
  assert.equal(JSON.parse(entry.body).input.task, 'fintech')
})

test('ключ не появляется ни в одном ответе /api/* (I-1)', async () => {
  const bodies = [await (await post('fintech', '10.0.0.3')).text(), await (await fetch(`${base}/api/runs/run-abc/events`)).text()]
  for (const body of bodies) assert.ok(!body.includes(KEY), `ключ утёк: ${body.slice(0, 120)}`)
})

test('пустое и слишком длинное задание до сервиса не доходят', async () => {
  seen.length = 0
  assert.equal((await post('   ', '10.0.0.4')).status, 400)
  assert.equal((await post('x'.repeat(601), '10.0.0.4')).status, 400)
  assert.equal(seen.length, 0, 'отвергнутый запрос всё-таки ушёл в сервис агентов')
})

test('слот берётся ДО обращения к сервису: четвёртый запрос за минуту не доходит', async () => {
  seen.length = 0
  const codes = []
  for (let i = 0; i < 4; i += 1) codes.push((await post('fintech', '10.0.0.9')).status)
  assert.deepEqual(codes, [202, 202, 202, 429])
  assert.equal(seen.filter((s) => s.url === '/v1/runs').length, 3, 'отказ лимитера всё-таки дошёл до сервиса')
})

test('поток событий уходит насквозь: те же байты, включая сырые тела JSON-RPC', async () => {
  eventsBody =
    'event: event\ndata: {"stage":"rpc","data":{"server":"mcpnews","method":"tools/call","request":{"a":1},"response":{"b":"ц"},"status":200,"ms":12}}\n\n' +
    'event: end\ndata: {"status":"succeeded"}\n\n'
  const res = await fetch(`${base}/api/runs/run-abc/events`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  assert.equal(await res.text(), eventsBody)
})

test('идентификатор запуска вне [A-Za-z0-9-] в сервис не уходит', async () => {
  seen.length = 0
  const res = await fetch(`${base}/api/runs/..%2Fadmin/events`)
  assert.equal(res.status, 404)
  assert.equal(seen.length, 0, 'битый идентификатор всё-таки ушёл в сервис агентов')
})

test('сервис ответил 404 на поток — день говорит «запуск не найден», а не выдумывает поток', async () => {
  eventsStatus = 404
  const res = await fetch(`${base}/api/runs/run-zzz/events`)
  eventsStatus = 200
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'Запуск не найден')
})

test('страница отдаётся статикой и подключает style.css', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.ok((await res.text()).includes('<link rel="stylesheet" href="style.css">'))
})

// Интеграционный тест дня 18 против ПОДДЕЛЬНОГО сервиса агентов. Предмет:
//
//   1. ключ AGENT_KEY не появляется ни в одном ответе (I-1), а до сервиса
//      доходит — свидетельство берётся из ЖУРНАЛА стенда, не из кода ответа;
//   2. тело сводки уходит на страницу как есть, байт в байт: свой конверт
//      сверху сделал бы предметом показа обёртку;
//   3. ручки «запустить» у дня нет ни под каким методом — «когда» решает
//      планировщик (ADR 2026-09-28-0736, п. 6);
//   4. поток событий идёт насквозь.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { after, before, test } from 'node:test'

const KEY = 'agent-key-secret-7c1b-do-not-leak'

/** @type {{method:string,url:string,headers:object}[]} журнал стенда */
const seen = []
let digestReply = { status: 200, body: '{"job":{"enabled":true},"runs":[]}' }
let eventsBody = ''

const agents = http.createServer(async (req, res) => {
  for await (const _ of req) void _
  seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })
  if (req.url.endsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(eventsBody)
    return res.end()
  }
  res.writeHead(digestReply.status, { 'content-type': 'application/json' })
  res.end(digestReply.body)
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
process.env.RATE_LIMIT_PER_MIN = '3'
process.env.RATE_LIMIT_PER_HOUR = '6'

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

const get = (path, ip = '10.0.0.1') => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip } })

test('/healthz зелёный и не печатает ключ', async () => {
  const res = await get('/healthz')
  assert.equal(res.status, 200)
  assert.ok(!(await res.text()).includes(KEY))
})

test('сводка уходит на страницу теми же байтами; стенд видел ключ', async () => {
  seen.length = 0
  digestReply = { status: 200, body: '{"runs":[{"id":"run-1","summary":"ц"}],"startsToday":1}' }
  const res = await get('/api/digest', '10.0.0.2')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), digestReply.body)
  const entry = seen.find((s) => s.url === '/v1/jobs/digest')
  assert.ok(entry, 'сервис агентов запроса не видел')
  assert.equal(entry.headers.authorization, `Bearer ${KEY}`)
})

test('ключ не появляется ни в одном ответе /api/* (I-1)', async () => {
  const bodies = [await (await get('/api/digest', '10.0.0.3')).text(), await (await get('/api/runs/run-1/events')).text()]
  for (const body of bodies) assert.ok(!body.includes(KEY), `ключ утёк: ${body.slice(0, 120)}`)
})

test('сервис ответил отказом — день не выдумывает пустую сводку', async () => {
  digestReply = { status: 500, body: '{"error":"нет"}' }
  const res = await get('/api/digest', '10.0.0.4')
  digestReply = { status: 200, body: '{"runs":[]}' }
  assert.equal(res.status, 502)
  assert.ok(!(await res.text()).includes('"runs"'), 'вместо отказа отдана пустая сводка')
})

test('ручки запуска у дня нет ни под каким методом', async () => {
  // Держатель по измерению ПУТИ. Перебор литеральных путей держал бы только
  // те три, что в нём написаны: живой `POST /api/run` прошёл бы мимо. Поэтому
  // утверждение о ПОЛНОМ наборе маршрутов диспетчера, вычитанном из исходника:
  // новый маршрут — это новое сравнение пути, новая проверка метода или чтение
  // `req.url` мимо `url.pathname`, и любое из трёх ломает утверждение.
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const routes = [...source.matchAll(/url\.pathname(?:\s*===\s*'([^']*)'|\.match\((\/[^\n]*?\/)\))/g)].map(
    (m) => m[1] ?? m[2],
  )
  assert.deepEqual(
    routes.sort(),
    ['/', '/api/digest', '/healthz', '/^\\/api\\/runs\\/([^/]+)\\/events$/'].sort(),
    'набор маршрутов дня изменился — новый путь заводится сознательно, а не попутно',
  )
  const methods = [...source.matchAll(/req\.method\s*[!=]==\s*'([A-Z]+)'/g)].map((m) => m[1])
  assert.deepEqual(methods, ['GET', 'GET'], 'маршрут отвечает не только на GET')
  // Без этого утверждения набор выше обходится разбором `req.url` напрямую.
  assert.equal(source.match(/req\.url/g).length, 1, 'путь берётся мимо url.pathname')

  // То же исполнением: по каждому сегодняшнему маршруту все неидемпотентные
  // методы — ни 202, ни единого обращения к сервису агентов.
  seen.length = 0
  for (const path of ['/', '/healthz', '/api/digest', '/api/runs/run-1/events'])
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}${path}`, { method })
      assert.notEqual(res.status, 202, `${method} ${path} что-то запустил`)
    }
  assert.equal(seen.length, 0, 'попытка запуска всё-таки дошла до сервиса агентов')
})

test('слот берётся до обращения к сервису: четвёртое чтение за минуту не доходит', async () => {
  seen.length = 0
  const codes = []
  for (let i = 0; i < 4; i += 1) codes.push((await get('/api/digest', '10.0.0.9')).status)
  assert.deepEqual(codes, [200, 200, 200, 429])
  assert.equal(seen.filter((s) => s.url === '/v1/jobs/digest').length, 3)
})

test('адрес берётся из ХВОСТА X-Forwarded-For: подделка головы окно не обходит', async () => {
  const ip = '10.0.0.11'
  for (let i = 0; i < 3; i += 1) await get('/api/digest', ip)
  // Caddy ДОПИСЫВАЕТ реальный адрес в конец: голову подделывает сам клиент.
  const res = await fetch(`${base}/api/digest`, { headers: { 'x-forwarded-for': `9.9.9.9, ${ip}` } })
  assert.equal(res.status, 429, 'подделанная голова X-Forwarded-For дала новое окно')
})

test('поток событий уходит насквозь: те же байты, включая сырые тела JSON-RPC', async () => {
  eventsBody = 'event: event\ndata: {"stage":"rpc","data":{"server":"mcpstore","request":{"a":1}}}\n\nevent: end\ndata: {"status":"succeeded"}\n\n'
  const res = await get('/api/runs/run-1/events')
  assert.equal(await res.text(), eventsBody)
})

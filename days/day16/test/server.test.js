// Интеграционный тест дня 16: настоящий сервер дня против поддельной службы
// MCP на локальном порту. Предмет проверки — ровно то, что раскладка
// (2026-09-23-1242, п. 17) потребовала от сервера дня:
//
//   1. два признака проб — «послать GET» и «не подставлять ключ»;
//   2. тело ответа службы уходит на страницу как есть, байт в байт;
//   3. отказ лимитера несёт число секунд до повтора;
//
// и то, что требует I-1: ключ не появляется ни в одном ответе /api/*.
//
// Поддельная служба НЕ пересказывает представление автора о протоколе: она
// записывает всё, что получила, и отдаёт то, что ей велено телом запроса, —
// иначе тест проверял бы согласие заглушки с кодом, а не код
// (agent_docs/guides/verification.md, случай page-contract дня 15).

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

// Ключ только из ASCII: значение заголовка — ByteString, и ключ с кириллицей
// уронил бы fetch до отправки. Настоящий MCP_KEY тоже ASCII (deploy/mcp.env).
const KEY = 'mcp-key-secret-9f3a-do-not-leak'

/** @type {{method:string,headers:object,body:string}[]} что увидела служба */
const seen = []
/** 'reply' — ответить как велено; 'hang' — молчать; 'destroy' — оборвать соединение. */
let mode = 'reply'
/** Что служба отдаст следующим ответом: код, тип и ТОЧНЫЕ байты тела. */
let reply = { status: 200, type: 'application/json', body: '{"ok":true}' }

const mcp = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  seen.push({
    method: req.method,
    headers: { ...req.headers },
    body: Buffer.concat(chunks).toString(),
  })
  if (mode === 'destroy') return res.destroy()
  if (mode === 'hang') return // ответа не будет вовсе
  res.writeHead(reply.status, { 'content-type': reply.type })
  res.end(reply.body)
})

await new Promise((resolve) => mcp.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.MCP_KEY = KEY
process.env.MCP_URL = `http://127.0.0.1:${mcp.address().port}/mcp`
process.env.MCP_TIMEOUT_MS = '400'
process.env.RATE_LIMIT_PER_MIN = '3'
process.env.RATE_LIMIT_PER_HOUR = '6'

const { server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => mcp.close(resolve))
})

/** Каждый тест берёт свой адрес: окна лимитера не должны течь между тестами. */
const rpc = (payload, ip) =>
  fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })

const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

test('заголовки к службе — ровно те, что страница показывает строкой соединения', async () => {
  mode = 'reply'
  reply = { status: 200, type: 'application/json', body: '{"ok":true}' }
  await rpc({ rpc: CALL }, '10.0.0.1')
  const sent = seen.at(-1)
  assert.equal(sent.method, 'POST')
  assert.equal(sent.headers.accept, 'application/json, text/event-stream')
  assert.equal(sent.headers['content-type'], 'application/json')
  assert.equal(sent.headers['mcp-protocol-version'], '2025-11-25')
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`)
  assert.equal(sent.body, JSON.stringify(CALL), 'конверт уходит как собрала страница')
})

test('тело ответа службы доходит до страницы байт в байт, вместе с кодом', async () => {
  // Нарочно неканоничные байты: лишние пробелы, необычный порядок полей,
  // не-ASCII. Любая переупаковка (JSON.parse → JSON.stringify) их изменит,
  // и предметом показа станет обёртка, а не ответ службы.
  const exact = '{  "result" : {"город":"Сингапур",\n  "t": 29.4} ,"id":1,"jsonrpc":"2.0"}'
  mode = 'reply'
  reply = { status: 200, type: 'application/json', body: exact }
  const r = await rpc({ rpc: CALL }, '10.0.0.2')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-rpc-outcome'), 'upstream')
  assert.equal(await r.text(), exact)
  assert.equal(r.headers.get('x-rpc-bytes'), String(Buffer.byteLength(exact)))
  assert.ok(Number(r.headers.get('x-rpc-ms')) >= 0)
})

test('код отказа службы доходит как её код, а не как 200 с признаком в теле', async () => {
  for (const status of [401, 405, 406, 415, 400, 500]) {
    mode = 'reply'
    reply = { status, type: 'application/json', body: `{"code":${status}}` }
    const r = await rpc({ rpc: CALL }, `10.0.1.${status % 200}`)
    assert.equal(r.status, status)
    assert.equal(r.headers.get('x-rpc-outcome'), 'upstream')
    assert.equal(await r.text(), `{"code":${status}}`)
  }
})

test('признак «не подставлять ключ» снимает Authorization и больше ничего', async () => {
  mode = 'reply'
  reply = { status: 401, type: 'application/json', body: '{"error":"unauthorized"}' }
  const r = await rpc({ rpc: CALL, noKey: true }, '10.0.0.3')
  const sent = seen.at(-1)
  assert.equal(sent.headers.authorization, undefined, 'ключ не ушёл — это и есть проба на 401')
  assert.equal(sent.method, 'POST')
  assert.equal(sent.headers.accept, 'application/json, text/event-stream')
  assert.equal(sent.headers['mcp-protocol-version'], '2025-11-25')
  assert.equal(sent.body, JSON.stringify(CALL))
  assert.equal(r.status, 401)
})

test('признак «послать GET» меняет метод и не шлёт тела; ключ при этом на месте', async () => {
  mode = 'reply'
  reply = { status: 405, type: 'application/json', body: '{"error":"method not allowed"}' }
  const r = await rpc({ http: 'GET' }, '10.0.0.4')
  const sent = seen.at(-1)
  assert.equal(sent.method, 'GET')
  assert.equal(sent.body, '')
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`, '405 должен приходить из метода, а не из отсутствия ключа')
  assert.equal(sent.headers['content-type'], undefined, 'Content-Type без тела не шлётся')
  assert.equal(r.status, 405)
  assert.equal(r.headers.get('x-rpc-outcome'), 'upstream')
})

test('иной метод, кроме POST и GET, сервер дня не отправляет', async () => {
  const before = seen.length
  for (const http of ['DELETE', 'PUT', 'get', 1, null]) {
    const r = await rpc({ http, rpc: CALL }, '10.0.0.5')
    assert.equal(r.status, 400)
    assert.equal(r.headers.get('x-rpc-outcome'), 'rejected')
  }
  assert.equal(seen.length, before, 'до службы ни один из них не дошёл')
})

test('молчание службы — «ответа нет», и это отличимо от её отказа', async () => {
  mode = 'hang'
  const r = await rpc({ rpc: CALL }, '10.0.0.6')
  assert.equal(r.status, 502)
  assert.equal(r.headers.get('x-rpc-outcome'), 'unreachable')
  assert.equal(r.headers.get('x-rpc-reason'), 'timeout')
})

test('обрыв соединения — тоже «ответа нет», с другой причиной', async () => {
  mode = 'destroy'
  const r = await rpc({ rpc: CALL }, '10.0.0.7')
  assert.equal(r.status, 502)
  assert.equal(r.headers.get('x-rpc-outcome'), 'unreachable')
  assert.equal(r.headers.get('x-rpc-reason'), 'network')
})

test('отказ лимитера несёт число секунд до повтора — и не доходит до службы', async () => {
  mode = 'reply'
  reply = { status: 200, type: 'application/json', body: '{"ok":true}' }
  const ip = '10.0.0.8'
  for (let i = 0; i < 3; i += 1) assert.equal((await rpc({ rpc: CALL }, ip)).status, 200)
  const before = seen.length
  const r = await rpc({ rpc: CALL }, ip)
  assert.equal(r.status, 429)
  assert.equal(r.headers.get('x-rpc-outcome'), 'limited')
  const seconds = Number(r.headers.get('retry-after'))
  assert.ok(seconds >= 1 && seconds <= 60, `секунды до повтора: ${seconds}`)
  assert.equal((await r.json()).retryAfterSec, seconds, 'то же число в теле — из него страница строит строку')
  assert.equal(seen.length, before, 'запрос до службы не дошёл')
})

test('адрес берётся из ХВОСТА X-Forwarded-For: подделка головы окно не обходит', async () => {
  mode = 'reply'
  const ip = '10.0.0.9'
  for (let i = 0; i < 3; i += 1) await rpc({ rpc: CALL }, ip)
  const r = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.9, ${ip}` },
    body: JSON.stringify({ rpc: CALL }),
  })
  assert.equal(r.status, 429)
})

test('ключ не появляется ни в одном ответе сервера дня (I-1)', async () => {
  mode = 'reply'
  // Служба, ответившая ключом, — единственный источник, из которого он мог бы
  // просочиться наружу; проверяется, что сервер дня ничего своего не дописывает.
  reply = { status: 200, type: 'application/json', body: '{"ok":true}' }
  const answers = [
    await fetch(`${base}/healthz`),
    await fetch(`${base}/`),
    await fetch(`${base}/console.js`),
    await fetch(`${base}/app.js`),
    await rpc({ rpc: CALL }, '10.0.0.10'),
    await rpc({ http: 'GET' }, '10.0.0.11'),
    await rpc('{не json', '10.0.0.12'),
  ]
  for (const r of answers) {
    const dump = `${[...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await r.text()}`
    assert.equal(dump.includes(KEY), false, `ключ виден в ответе ${r.url}`)
    assert.equal(dump.includes('MCP_KEY'), false)
  }
})

test('страница и её модули отдаются исполняемыми типами', async () => {
  const page = await fetch(`${base}/`)
  assert.match(page.headers.get('content-type'), /text\/html/)
  for (const name of ['app.js', 'console.js']) {
    const r = await fetch(`${base}/${name}`)
    assert.equal(r.status, 200, `${name} не отдаётся`)
    assert.match(
      r.headers.get('content-type'),
      /javascript/,
      `модуль ${name} с типом ${r.headers.get('content-type')} браузер не исполнит, и страница будет мертва`,
    )
  }
})

test('за пределы public выйти нельзя', async () => {
  const r = await fetch(`${base}/../server.js`, { redirect: 'manual' })
  assert.equal((await r.text()).includes('MCP_KEY'), false)
})

test('/healthz говорит о конфигурации и о лимитере, но не о ключе', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.equal(body.limiter.perMin, 3)
})

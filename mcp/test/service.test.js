// Контракт эндпоинта: ключ, метод, детерминированный список, лимитер до
// исполнения. Каждый тест назван так, чтобы было видно, какой дефект он ловит.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { KEY, rpc, RPC_HEADERS, startService, toolPayload } from './helpers.js'

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

test('запрос без ключа получает 401 и не исполняется', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, LIST, { key: null })
  assert.equal(res.status, 401)
  const body = res.json()
  assert.equal(body.error.message, 'unauthorized')
})

test('чужой ключ той же длины получает 401', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, LIST, { key: 'x'.repeat(KEY.length) })
  assert.equal(res.status, 401)
})

test('401 приходит ДО чтения тела: тело не отправлено, ответ есть', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  // Заголовки обещают тело, но байты не пишутся и запрос не завершается.
  // Если бы ключ проверялся после `readBody`, ответа не было бы вовсе —
  // обработчик ждал бы события `end`, которого не будет.
  const { port } = new URL(service.base)
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { ...RPC_HEADERS, 'content-length': '4096' },
      },
      (res) => {
        resolve(res.statusCode)
        req.destroy()
      },
    )
    req.on('error', () => {})
    req.write('{"jsonrpc":') // начало тела, конца не будет
    setTimeout(() => reject(new Error('ответа нет: тело читается до проверки ключа')), 2000)
  })
  assert.equal(status, 401)
})

test('GET на эндпоинт — 405', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, null, { method: 'GET' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')
  // Транспорт SDK на GET тоже отвечает 405 — по одному коду эти гипотезы
  // неразличимы. Различает их то, что сессия не собиралась вовсе: GET не
  // доходит до транспорта.
  assert.equal(service.built.sessions, 0)
})

test('DELETE на эндпоинт — 405', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, null, { method: 'DELETE' })
  assert.equal(res.status, 405)
  assert.equal(service.built.sessions, 0)
})

test('tools/list детерминирован: те же три имени в том же порядке', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const first = (await rpc(service.base, LIST)).json()
  const second = (await rpc(service.base, LIST)).json()

  const names = first.result.tools.map((tool) => tool.name)
  assert.deepEqual(names, ['clock.now', 'weather.current', 'wiki.summary'])
  assert.deepEqual(second.result.tools.map((tool) => tool.name), names)
  assert.deepEqual(second.result.tools, first.result.tools)
})

test('clock.now отвечает без сети', async (t) => {
  const service = await startService({
    fetchImpl: () => assert.fail('clock.now не должен ходить в сеть'),
  })
  t.after(() => service.close())

  const res = await rpc(service.base, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'clock.now', arguments: {} },
  })
  const payload = toolPayload(res.json())
  assert.equal(payload.iso, '2026-09-23T12:00:00.000Z')
  assert.equal(payload.timezone, 'UTC')
})

test('лимитер срабатывает ДО исполнения: отказанный вызов в сеть не ходит', async (t) => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(JSON.stringify({ title: 'Т', extract: 'т', titles: { canonical: 'Т' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const service = await startService({ envSource: { RATE_LIMIT_PER_MIN: '1' }, fetchImpl })
  t.after(() => service.close())

  const call = (id) =>
    rpc(service.base, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'wiki.summary', arguments: { title: 'Тест' } },
    })

  assert.equal((await call(1)).status, 200)
  assert.equal(calls, 1)

  const second = await call(2)
  assert.equal(second.status, 429)
  const body = second.json()
  assert.equal(body.error.code, -32002)
  // Главное утверждение теста: исполнения не было, значит проверка
  // предшествовала вызову, а не следовала за ним.
  assert.equal(calls, 1)
})

test('лимитер не трогает tools/list: отказ не должен запирать протокол', async (t) => {
  const service = await startService({ envSource: { RATE_LIMIT_PER_MIN: '1' } })
  t.after(() => service.close())

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await rpc(service.base, { ...LIST, id: i })).status, 200)
  }
})

test('пачка из трёх вызовов берёт три слота разом', async (t) => {
  const service = await startService({
    envSource: { RATE_LIMIT_PER_MIN: '2' },
    fetchImpl: () => assert.fail('пачка не должна исполниться'),
  })
  t.after(() => service.close())

  const batch = [1, 2, 3].map((id) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'clock.now', arguments: {} },
  }))
  const res = await rpc(service.base, batch)
  assert.equal(res.status, 429)
})

test('/healthz открыт без ключа и называет инструменты', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await fetch(`${service.base}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.tools, ['clock.now', 'weather.current', 'wiki.summary'])
})

test('чужой путь — 404, а не эндпоинт MCP', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await fetch(`${service.base}/`, { headers: { authorization: `Bearer ${KEY}` } })
  assert.equal(res.status, 404)
})

test('битый JSON — ошибка разбора, а не падение процесса', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const { port } = new URL(service.base)
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { ...RPC_HEADERS, authorization: `Bearer ${KEY}` },
      },
      (res) => resolve(res.statusCode),
    )
    req.on('error', reject)
    req.end('{не json')
  })
  assert.equal(status, 400)
})

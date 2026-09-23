// Контракт эндпоинта: ключ, метод, детерминированный список, лимитер до
// исполнения. Каждый тест назван так, чтобы было видно, какой дефект он ловит.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { KEY, rpc, RPC_HEADERS, shape, startService, toolPayload } from './helpers.js'

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

test('запрос без ключа — 404 с пустым телом и без признаков протокола', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, LIST, { key: null })
  assert.equal(res.status, 404)
  // Три утверждения, а не одно: прежний JSON-RPC прошёл бы проверку «404».
  assert.equal(res.text(), '')
  assert.equal(res.headers['content-length'], '0')
  assert.equal(res.headers['content-type'], undefined)
  // Причина отказа остаётся у службы, а не уходит прохожему.
  assert.deepEqual(
    service.logs.map((entry) => entry.code),
    ['unauthorized'],
  )
})

test('чужой ключ той же длины — тот же 404 с пустым телом', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, LIST, { key: 'x'.repeat(KEY.length) })
  assert.equal(res.status, 404)
  assert.equal(res.text(), '')
  assert.equal(res.headers['content-type'], undefined)
})

test('эндпоинт без ключа неотличим от несуществующего пути', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const secret = await rpc(service.base, LIST, { key: null })
  const nowhere = await rpc(service.base, LIST, { key: null, path: '/no-such-path' })
  // Сверяются целиком: код, тело и все заголовки, кроме меняющихся от
  // запроса к запросу. Любая лишняя строка в одном из ответов — снова
  // подсказка, что по одному из адресов что-то есть.
  assert.deepEqual(shape(secret), shape(nowhere))
})

test('404 приходит ДО чтения тела: тело не отправлено, ответ есть', async (t) => {
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
  assert.equal(status, 404)
})

test('годный ключ работает как прежде: список инструментов приходит', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, LIST)
  assert.equal(res.status, 200)
  assert.deepEqual(
    res.json().result.tools.map((tool) => tool.name),
    ['clock.now', 'weather.current', 'wiki.summary'],
  )
})

test('исчерпанное окно отказов НЕ закрывает службу для годного ключа', async (t) => {
  const service = await startService({ envSource: { REFUSAL_SIGNAL_PER_HOUR: '3' } })
  t.after(() => service.close())

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await rpc(service.base, LIST, { key: 'wrong-key' })).status, 404)
  }

  // Порог перейдён, окно давно «исчерпано» — и это ничего не запрещает:
  // ключ сверяется всегда. Обратное (404 не глядя) било бы ровно по тем, у
  // кого ключ есть: у перебирающего годного ключа нет по определению.
  const good = await rpc(service.base, LIST)
  assert.equal(good.status, 200)
  assert.deepEqual(
    good.json().result.tools.map((tool) => tool.name),
    ['clock.now', 'weather.current', 'wiki.summary'],
  )

  // А негодный по-прежнему получает 404 с пустым телом.
  const bad = await rpc(service.base, LIST, { key: 'wrong-key' })
  assert.equal(bad.status, 404)
  assert.equal(bad.text(), '')
})

test('сигнал о переборе пишется один раз за окно, а не на каждый отказ', async (t) => {
  const service = await startService({ envSource: { REFUSAL_SIGNAL_PER_HOUR: '3' } })
  t.after(() => service.close())

  for (let i = 0; i < 7; i += 1) await rpc(service.base, LIST, { key: 'wrong-key' })

  const bursts = service.logs.filter((entry) => entry.event === 'refusal_burst')
  assert.equal(bursts.length, 1, 'сигнал, повторяющийся на каждом запросе, — уже не сигнал')
  assert.equal(bursts[0].count, 3)
  // Сами отказы при этом записаны все семь: сигнал их не заменяет.
  assert.equal(service.logs.filter((entry) => entry.code === 'unauthorized').length, 7)
})

test('счётчик отказов — на адрес, а не общий на всех', async (t) => {
  const service = await startService({ envSource: { REFUSAL_SIGNAL_PER_HOUR: '2' } })
  t.after(() => service.close())

  const bursts = () => service.logs.filter((entry) => entry.event === 'refusal_burst')

  for (let i = 0; i < 2; i += 1)
    await rpc(service.base, LIST, { key: 'wrong-key', ip: '203.0.113.7' })
  assert.equal(bursts().length, 1)

  // Сосед перебирает сам и переходит СВОЙ порог: при общем счётчике его
  // отказы были бы третьим и четвёртым и сигнала не дали бы вовсе.
  for (let i = 0; i < 2; i += 1)
    await rpc(service.base, LIST, { key: 'wrong-key', ip: '198.51.100.9' })
  assert.equal(bursts().length, 2)
  assert.deepEqual(
    bursts().map((entry) => entry.count),
    [2, 2],
  )

  // И работа с годным ключом с любого адреса не затронута.
  assert.equal((await rpc(service.base, LIST, { ip: '203.0.113.7' })).status, 200)
})

test('счётчик отказов не трогает работу с годным ключом', async (t) => {
  const service = await startService({ envSource: { REFUSAL_SIGNAL_PER_HOUR: '2' } })
  t.after(() => service.close())

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await rpc(service.base, { ...LIST, id: i })).status, 200)
  }
  assert.equal(service.logs.length, 0)
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

test('публичный /healthz — только признак живости', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await fetch(`${service.base}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  // Выкатке и healthcheck контейнера нужен только код 200: оба смотрят на
  // `%{http_code}` и на `r.ok`, в тело не заглядывает ни один.
  assert.deepEqual(body, { ok: true })
  // Отдельно — то, чего в ответе быть не должно, по существу, а не по форме:
  // ни имени инструмента, ни числа лимитера, ни признака, пользуется ли
  // службой кто-то сейчас.
  const text = JSON.stringify(body)
  for (const leak of ['clock.now', 'weather.current', 'wiki.summary', 'trackedIps', 'perMinute', 'perHour'])
    assert.ok(!text.includes(leak), `публичный /healthz не должен называть ${leak}`)
})

test('/healthz с годным ключом отдаёт прежний полный ответ', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await fetch(`${service.base}/healthz`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.tools, ['clock.now', 'weather.current', 'wiki.summary'])
  assert.equal(body.limits.perMinute, 10)
  assert.equal(body.limits.perHour, 100)
  assert.equal(body.limits.refusalSignalPerHour, 60)
  assert.equal(typeof body.limits.trackedIps, 'number')
})

test('чужой путь — 404 с пустым телом даже с годным ключом', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await fetch(`${service.base}/`, { headers: { authorization: `Bearer ${KEY}` } })
  assert.equal(res.status, 404)
  assert.equal(await res.text(), '')
  assert.equal(res.headers.get('content-type'), null)
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

// Контракт протокола: форма ответа, детерминированный список, отказ
// инструмента через `isError`, а отказ запроса — через `error`.
// Форма обязана совпадать с `mcpnews`: её разбирает один и тот же клиент
// (`payloadOf` в `agents/src/mcp/pipeline.js`).

import assert from 'node:assert/strict'
import test from 'node:test'
import { PROTOCOL_VERSION } from '../src/rpc.js'
import { call, ok, rawPost, recorder, rpc, startService } from './helpers.js'

test('initialize отдаёт ревизию 2025-11-25 и способность tools', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const body = (await rpc(service.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json()
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.id, 1)
  // Ревизия сверяется с БУКВОЙ, а не с константой модуля: иначе тест повторял
  // бы за кодом и молча принял бы любую подмену ревизии.
  assert.equal(body.result.protocolVersion, '2025-11-25')
  assert.equal(PROTOCOL_VERSION, '2025-11-25')
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } })
  assert.equal(body.result.serverInfo.name, 'ai-advent-2026-translate')
})

test('notifications/initialized — 202 без тела, ответа JSON-RPC нет', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const res = await rpc(service.base, { jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res.status, 202)
  assert.equal(res.text(), '')
})

test('ping отвечает пустым результатом', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const body = (await rpc(service.base, { jsonrpc: '2.0', id: 7, method: 'ping' })).json()
  assert.deepEqual(body, { jsonrpc: '2.0', id: 7, result: {} })
})

test('tools/list детерминирован: те же имена в том же порядке со схемой', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const first = (await rpc(service.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
  const second = (await rpc(service.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()

  assert.deepEqual(
    first.result.tools.map((t2) => t2.name),
    ['text.translate'],
  )
  assert.deepEqual(first.result.tools, second.result.tools)
  // Схема — часть контракта: без неё модель не построит вызов.
  assert.equal(first.result.tools[0].inputSchema.type, 'object')
  // Язык источника НЕ обязателен — это следствие прогона: `Autodetect`
  // у поставщика работает (README, «Поведение поставщика», п. 2).
  assert.deepEqual(first.result.tools[0].inputSchema.required, ['text', 'to'])
})

test('ответ инструмента — JSON строкой в content[0].text, как у mcpnews', async (t) => {
  const { fetchImpl } = recorder([ok('fintech startups')])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'text.translate', { text: 'финтех стартапы', from: 'ru', to: 'en' })).json()
  // Форму разбирает `payloadOf` клиента: `structuredContent` не даём вовсе,
  // первый блок — типа text, а в нём строка с JSON. Разойдись эта форма с
  // `mcpnews` — цепочка читала бы наш ответ как простой текст.
  assert.equal(body.result.structuredContent, undefined)
  assert.equal(body.result.content[0].type, 'text')
  assert.equal(typeof body.result.content[0].text, 'string')
  assert.deepEqual(JSON.parse(body.result.content[0].text), {
    text: 'fintech startups',
    from: 'ru',
    to: 'en',
    detected: false,
    translated: true,
    chars: 15,
  })
})

test('неизвестный метод — -32601, а не падение', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const body = (await rpc(service.base, { jsonrpc: '2.0', id: 3, method: 'tools/nope' })).json()
  assert.equal(body.error.code, -32601)
  assert.equal(body.result, undefined)
})

test('неизвестный инструмент — -32602 (ошибка запроса, не инструмента)', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'text.invent', {})).json()
  assert.equal(body.error.code, -32602)
})

test('негодный JSON — -32700 и код 400', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const res = await rawPost(service.base, '{ не json')
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.text()).error.code, -32700)
})

test('GET на /mcp — 405 с заголовком allow: без сессий потока нет', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const res = await rpc(service.base, undefined, { method: 'GET' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('тело больше 64 КБ до разбора не доходит', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  // Валидный JSON — отказ обязан прийти от потолка, а не от разбора.
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(70 * 1024) })
  const res = await rawPost(service.base, huge)
  assert.notEqual(res.status, 200, 'тело сверх потолка не должно быть обработано')
})

test('/healthz открыт и называет инструменты', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const res = await rpc(service.base, undefined, { method: 'GET', path: '/healthz' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true, tools: ['text.translate'] })
})

test('путь мимо /mcp и /healthz — 404', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const res = await rpc(service.base, { jsonrpc: '2.0', id: 1, method: 'ping' }, { path: '/admin' })
  assert.equal(res.status, 404)
})

test('пачка: ответы только на запросы с id, уведомление ответа не даёт', async (t) => {
  const service = await startService({ fetchImpl: recorder([]).fetchImpl })
  t.after(() => service.close())

  const body = (
    await rpc(service.base, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
  ).json()
  assert.equal(Array.isArray(body), true)
  assert.deepEqual(
    body.map((item) => item.id),
    [1, 2],
  )
})

// Контракт протокола единицы `mcpstore`: та же форма, что у `mcpnews` и у
// службы дня 16. Копия единицы должна вести себя ОДИНАКОВО — тесты здесь
// свои, потому что и код свой (ADR 2026-09-28-0736, п. 3).

import assert from 'node:assert/strict'
import test from 'node:test'
import { call, rawPost, rpc, startService } from './helpers.js'

test('initialize отдаёт ревизию 2025-11-25 и способность tools', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const body = (await rpc(service.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json()
  assert.equal(body.result.protocolVersion, '2025-11-25')
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } })
  assert.equal(body.result.serverInfo.name, 'ai-advent-2026-store')
})

test('notifications/initialized — 202 без тела', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, { jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res.status, 202)
  assert.equal(res.text(), '')
})

test('ping отвечает пустым результатом', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  assert.deepEqual((await rpc(service.base, { jsonrpc: '2.0', id: 7, method: 'ping' })).json(), {
    jsonrpc: '2.0',
    id: 7,
    result: {},
  })
})

test('tools/list детерминирован: три имени в том же порядке', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const first = (await rpc(service.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
  const second = (await rpc(service.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
  assert.deepEqual(
    first.result.tools.map((x) => x.name),
    ['file.save', 'file.read', 'file.list'],
  )
  assert.deepEqual(first.result.tools, second.result.tools)
})

test('неизвестный метод — -32601', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  assert.equal((await rpc(service.base, { jsonrpc: '2.0', id: 3, method: 'file/save' })).json().error.code, -32601)
})

test('неизвестный инструмент — -32602', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  assert.equal((await call(service.base, 'file.delete', {})).json().error.code, -32602)
})

test('негодный JSON — -32700 и код 400', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rawPost(service.base, '{ не json')
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.text()).error.code, -32700)
})

test('GET на /mcp — 405 с allow: POST', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, undefined, { method: 'GET' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('тело сверх потолка единицы (256 КБ) до разбора не доходит', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  // Потолок здесь ВЫШЕ 64 КБ намеренно: файл предельного размера обязан
  // пролезать в конверте (`STORE_MAX_BODY`). Два утверждения, а не одно:
  // тело чуть ниже потолка проходит, тело сверх — нет. Одно утверждение не
  // отличило бы поднятый потолок от снятого.
  const fits = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(200 * 1024) })
  assert.equal((await rawPost(service.base, fits)).status, 200)
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(300 * 1024) })
  assert.notEqual((await rawPost(service.base, huge)).status, 200)
})

test('/healthz открыт и называет инструменты и состояние хранилища', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const res = await rpc(service.base, undefined, { method: 'GET', path: '/healthz' })
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.tools, ['file.save', 'file.read', 'file.list'])
  assert.deepEqual({ files: body.files, limit: body.limit, ttlHours: body.ttlHours }, { files: 0, limit: 200, ttlHours: 30 })
})

test('путь мимо /mcp и /healthz — 404', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  assert.equal((await rpc(service.base, { jsonrpc: '2.0', id: 1, method: 'ping' }, { path: '/data' })).status, 404)
})

// Клиент MCP против поддельного сервера: живой службы в тестах нет.
// Поддельный сервер — настоящий `node:http` на порту 0, а не подменённый
// `fetch`: предмет проверки — заголовки, конверт и поведение сети.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  createMcpClient,
  McpError,
  PROTOCOL_VERSION,
  RESPONSE_LIMIT,
  TRACE_BODY_LIMIT,
} from '../src/mcp/client.js'
import { rpcEvent } from '../src/mcp/pipeline.js'
import { loadServers } from '../src/mcp/servers.js'

/** Поддельный сервер: `handler(request, req)` отдаёт `{status, body, headers}`. */
async function fakeServer(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', async () => {
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
      seen.push({ headers: req.headers, body: parsed, raw })
      const out = (await handler(parsed, req)) ?? {}
      // `connection: close` — чтобы пул `fetch` не переиспользовал сокет
      // закрытого поддельного сервера на переиспользованном порту.
      res.writeHead(out.status ?? 200, {
        'content-type': 'application/json',
        connection: 'close',
        ...(out.headers ?? {}),
      })
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  return {
    url,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}

const ok = (id, result) => ({ body: { jsonrpc: '2.0', id, result } })

test('initialize уходит с заголовками ревизии 2025-11-25 и возвращает объявленное имя', async () => {
  const fake = await fakeServer((rpc) => ok(rpc.id, { serverInfo: { name: 'объявленное' }, protocolVersion: PROTOCOL_VERSION }))
  const client = createMcpClient({ name: 'news', url: fake.url })

  const { declaredName, trace } = await client.initialize()

  assert.equal(declaredName, 'объявленное')
  assert.equal(fake.seen[0].headers['mcp-protocol-version'], PROTOCOL_VERSION)
  assert.equal(fake.seen[0].headers['content-type'], 'application/json')
  assert.equal(fake.seen[0].headers.accept, 'application/json, text/event-stream')
  assert.equal(fake.seen[0].body.method, 'initialize')
  assert.equal(fake.seen[0].body.params.protocolVersion, PROTOCOL_VERSION)
  assert.equal(trace.server, 'news')
  await fake.close()
})

test('ключ подставляется только тому серверу, у которого он задан', async () => {
  const fake = await fakeServer((rpc) => ok(rpc.id, {}))
  await createMcpClient({ name: 'withkey', url: fake.url, key: 'secret-key' }).call('ping')
  await createMcpClient({ name: 'nokey', url: fake.url }).call('ping')

  assert.equal(fake.seen[0].headers.authorization, 'Bearer secret-key')
  assert.equal(fake.seen[1].headers.authorization, undefined)
  await fake.close()
})

test('tools/list кладёт имя сервера рядом с каждым инструментом', async () => {
  const fake = await fakeServer((rpc) =>
    ok(rpc.id, { tools: [{ name: 'news.search' }, { name: 'news.summarize' }] }),
  )
  const { tools } = await createMcpClient({ name: 'mcpnews', url: fake.url }).listTools()

  assert.deepEqual(
    tools.map((t) => [t.name, t.server]),
    [
      ['news.search', 'mcpnews'],
      ['news.summarize', 'mcpnews'],
    ],
  )
  await fake.close()
})

test('isError: true — отказ инструмента признаком, а не исключением', async () => {
  const fake = await fakeServer((rpc) =>
    ok(rpc.id, { isError: true, content: [{ type: 'text', text: 'файл не найден' }] }),
  )
  const out = await createMcpClient({ name: 'store', url: fake.url }).callTool('file.read', { name: 'нет' })

  assert.equal(out.isError, true)
  assert.equal(out.text, 'файл не найден')
  await fake.close()
})

test('ошибка JSON-RPC — McpError с кодом в сообщении и записью трейса', async () => {
  const fake = await fakeServer((rpc) => ({
    body: { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found' } },
  }))
  const client = createMcpClient({ name: 'store', url: fake.url })

  const error = await client.callTool('нет.такого').then(
    () => null,
    (e) => e,
  )
  assert.ok(error instanceof McpError)
  assert.equal(error.reason, 'rpc_error')
  assert.match(error.message, /-32601/)
  assert.equal(error.trace.server, 'store')
  await fake.close()
})

test('недоступный сервер — понятная ошибка с именем сервера, а не стек fetch', async () => {
  // Порт, на котором никто не слушает: сервер поднят и сразу закрыт.
  const fake = await fakeServer(() => ok(1, {}))
  const url = fake.url
  await fake.close()

  const error = await createMcpClient({ name: 'mcpnews', url }).listTools().then(
    () => null,
    (e) => e,
  )
  assert.ok(error instanceof McpError)
  assert.equal(error.reason, 'network')
  assert.equal(error.message, 'Сервер MCP «mcpnews» недоступен.')
  assert.equal(error.trace.method, 'tools/list')
})

test('молчащий сервер обрывается по таймауту, а не висит', async () => {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/mcp`

  const error = await createMcpClient({ name: 'тихий', url, timeoutMs: 120 }).listTools().then(
    () => null,
    (e) => e,
  )
  assert.equal(error.reason, 'timeout')
  assert.match(error.message, /не ответил за 120 мс/)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

test('ответ больше потолка обрывается на чтении, а не грузится в память', async () => {
  const fake = await fakeServer((rpc) => ({
    body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { pad: 'x'.repeat(RESPONSE_LIMIT + 1024) } }),
  }))
  const error = await createMcpClient({ name: 'жирный', url: fake.url }).listTools().then(
    () => null,
    (e) => e,
  )
  assert.equal(error.reason, 'too_large')
  assert.match(error.message, new RegExp(String(RESPONSE_LIMIT)))
  await fake.close()
})

test('тело в трейсе обрезается по 64 КБ и помечается clipped', async () => {
  const fake = await fakeServer((rpc) => ok(rpc.id, { pad: 'y'.repeat(TRACE_BODY_LIMIT) }))
  const { trace } = await createMcpClient({ name: 'болтливый', url: fake.url }).call('tools/list')

  assert.equal(Buffer.byteLength(trace.response), TRACE_BODY_LIMIT)
  assert.equal(trace.clipped, true)
  await fake.close()
})

test('трейс несёт сырые тела, имя сервера, метод и длительность', async () => {
  const fake = await fakeServer((rpc) => ok(rpc.id, { tools: [] }))
  let clock = 1000
  const client = createMcpClient({
    name: 'mcpnews',
    url: fake.url,
    now: () => {
      clock += 7
      return clock
    },
  })
  const { trace } = await client.listTools()

  assert.equal(trace.server, 'mcpnews')
  assert.equal(trace.method, 'tools/list')
  assert.equal(JSON.parse(trace.request).method, 'tools/list')
  assert.deepEqual(JSON.parse(trace.response).result.tools, [])
  assert.equal(trace.status, 200)
  assert.ok(trace.ms > 0)
  await fake.close()
})

test('ответ не JSON и не конверт 2.0 различаются от ошибки сети', async () => {
  const fake = await fakeServer(() => ({ body: 'не json' }))
  const first = await createMcpClient({ name: 's', url: fake.url }).call('ping').catch((e) => e)
  assert.equal(first.reason, 'malformed')
  await fake.close()

  const second = await fakeServer((rpc) => ({ body: { id: rpc.id, result: {} } }))
  const error = await createMcpClient({ name: 's', url: second.url }).call('ping').catch((e) => e)
  assert.equal(error.reason, 'malformed')
  await second.close()
})

test('HTTP-отказ сервера отличается от ошибки инструмента', async () => {
  const fake = await fakeServer(() => ({ status: 401, body: { error: 'нет ключа' } }))
  const error = await createMcpClient({ name: 'day16', url: fake.url }).listTools().catch((e) => e)

  assert.equal(error.reason, 'http')
  assert.equal(error.status, 401)
  await fake.close()
})

// Ключ службы дня 16 — первый настоящий ключ у клиента хоста (ADR
// 2026-09-29-0236, п. 5 и 8). До него `key` у каждого клиента был `null`:
// запись `day16` без `MCP_DAY16_URL` всегда уходила в `skipped`, и обещание
// «в трейс ключ не попадает» (`src/mcp/client.js:96-97`) охраняло пустоту.
//
// Обещание это не мелочь: трейс уходит в `rpcEvent(...).data`, оттуда потоком
// SSE в браузер ПОСЕТИТЕЛЯ дня 20. Закрытый список полей в `parseCall` на
// странице — про отрисовку, а не про провод: до него данные уже у клиента.
//
// Судим по СОДЕРЖИМОМУ, а не по списку полей: `assert.deepEqual` на ключах
// трейса пропустил бы ключ, доехавший внутри известного поля. Ищем сам
// секрет и слово `authorization` в целиком сериализованном трейсе и в
// готовом событии — и на удачном вызове, и на неудачном, потому что
// `error.trace` едет на экран так же.
test('ключ службы не попадает в трейс ни удачного вызова, ни отказа', async () => {
  const KEY = 'secret-day16-key-do-not-leak'
  const leaks = (value, what) => {
    const text = JSON.stringify(value)
    assert.ok(!text.includes(KEY), `${what}: в трейсе нашёлся ключ службы`)
    assert.ok(!/authorization/i.test(text), `${what}: в трейсе нашлось слово authorization`)
  }

  const ok = await fakeServer((rpc) => ({ body: { jsonrpc: '2.0', id: rpc.id, result: { tools: [] } } }))
  const client = createMcpClient({ name: 'day16', url: ok.url, key: KEY })
  const { trace } = await client.listTools()

  // Сначала — что проверка вообще о чём-то: ключ ДОШЁЛ до сервера. Без этого
  // тест зеленел бы и у клиента, который ключ не шлёт вовсе.
  assert.equal(ok.seen.at(-1).headers.authorization, `Bearer ${KEY}`)
  leaks(trace, 'удачный вызов')
  leaks(rpcEvent(trace, 'Получен список инструментов'), 'событие удачного вызова')
  await ok.close()

  // Отказ: его трейс живёт в `error.trace` и уходит на экран тем же событием.
  const bad = await fakeServer(() => ({ status: 401, body: { error: 'нет ключа' } }))
  const error = await createMcpClient({ name: 'day16', url: bad.url, key: KEY })
    .listTools()
    .catch((e) => e)
  assert.equal(error.reason, 'http')
  assert.equal(bad.seen.at(-1).headers.authorization, `Bearer ${KEY}`)
  leaks(error.trace, 'отказ')
  leaks(rpcEvent(error.trace, 'Сервер не отдал список', 'warn'), 'событие отказа')
  await bad.close()
})

test('реестр берёт адреса из окружения и пропускает сервер без переменной', () => {
  const raw = {
    servers: [
      { name: 'mcpnews', title: 'Новости', urlEnv: 'MCP_NEWS_URL' },
      { name: 'day16', title: 'День 16', urlEnv: 'MCP_DAY16_URL', keyEnv: 'MCP_KEY' },
    ],
  }
  const { servers, skipped } = loadServers(raw, { MCP_NEWS_URL: 'http://mcpnews:8084/mcp' })

  assert.deepEqual([...servers.keys()], ['mcpnews'])
  assert.equal(servers.get('mcpnews').url, 'http://mcpnews:8084/mcp')
  assert.deepEqual(skipped, [{ name: 'day16', reason: 'MCP_DAY16_URL не задан' }])
})

test('битая запись реестра валит загрузку', () => {
  assert.throws(() => loadServers({ servers: [] }), /непустой список/)
  assert.throws(() => loadServers({ servers: [{ name: 'Плохое', title: 'т', urlEnv: 'X' }] }), /name/)
  assert.throws(() => loadServers({ servers: [{ name: 'ok', title: 'т' }] }), /urlEnv/)
})

test('ключ из окружения достаётся только серверу, который его объявил', () => {
  // Держатель границы I-1: до находки гейта (PR #233) единственный тест про
  // ключ строил клиентов напрямую, и мутация «ключ каждому серверу реестра»
  // оставалась зелёной. Здесь ключ в окружении ЕСТЬ, и проверяется, что
  // серверу без `keyEnv` он не достался.
  const made = []
  loadServers(
    {
      servers: [
        { name: 'mcpnews', title: 'Новости', urlEnv: 'MCP_NEWS_URL' },
        { name: 'mcpstore', title: 'Файлы', urlEnv: 'MCP_STORE_URL' },
        { name: 'day16', title: 'День 16', urlEnv: 'MCP_DAY16_URL', keyEnv: 'MCP_KEY' },
      ],
    },
    {
      MCP_NEWS_URL: 'http://mcpnews:8084/mcp',
      MCP_STORE_URL: 'http://mcpstore:8085/mcp',
      MCP_DAY16_URL: 'http://challenge.zpq.ai/mcp',
      MCP_KEY: 'ключ-дня-16',
    },
    { make: (args) => (made.push(args), { name: args.name }) },
  )

  assert.deepEqual(
    made.map((a) => [a.name, a.key]),
    [
      ['mcpnews', null],
      ['mcpstore', null],
      ['day16', 'ключ-дня-16'],
    ],
  )
})

test('объявленный ключ, которого нет в окружении, не становится чужим значением', () => {
  const made = []
  loadServers(
    { servers: [{ name: 'day16', title: 'День 16', urlEnv: 'U', keyEnv: 'MCP_KEY' }] },
    { U: 'http://challenge.zpq.ai/mcp' },
    { make: (args) => (made.push(args), { name: args.name }) },
  )
  assert.equal(made[0].key, null)
})

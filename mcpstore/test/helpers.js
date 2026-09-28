// Стенд: та же сборка, что в `server.js`, но база — в памяти и «сейчас»
// управляется тестом. Подменяются ровно два обстоятельства — файл базы и
// часы; предмет проверки (служба, JSON-RPC, разбор аргументов, SQL) настоящий.

import http from 'node:http'
import { createRpc } from '../src/rpc.js'
import { createService, STORE_MAX_BODY } from '../src/service.js'
import { createStore } from '../src/store.js'
import { buildTools } from '../src/tools.js'

export const T0 = Date.UTC(2026, 8, 28, 0, 0, 0)

export async function startService({ path = ':memory:', clock } = {}) {
  const time = clock ?? { ms: T0 }
  const store = createStore({ path, now: () => time.ms })
  const tools = buildTools({ store })
  const logs = []
  const server = http.createServer(
    createService({
      handleOne: createRpc({ serverInfo: { name: 'ai-advent-2026-store', version: '1.0.0' }, tools }),
      tools: tools.map((t) => t.name),
      health: () => store.stats(),
      maxBody: STORE_MAX_BODY,
      log: (entry) => logs.push(entry),
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    time,
    logs,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      store.close()
    },
  }
}

export function rpc(base, body, { method = 'POST', path = '/mcp' } = {}) {
  const url = new URL(`${base}${path}`)
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (payload) headers['content-length'] = String(Buffer.byteLength(payload))
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method, headers, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode, headers: res.headers, text: () => text, json: () => JSON.parse(text) })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export function rawPost(base, payload, { path = '/mcp' } = {}) {
  const url = new URL(`${base}${path}`)
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, text: () => Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', () => resolve({ status: 0, text: () => '' }))
    req.write(payload)
    req.end()
  })
}

export const call = (base, name, args) =>
  rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

export const toolPayload = (response) => JSON.parse(response.result.content[0].text)

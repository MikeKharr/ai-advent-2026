// Стенд: та же сборка, что в `server.js`, но с подменённым `fetch`
// инструментов и своим окружением. Подменяется ровно одно — дверь наружу;
// предмет проверки (служба, транспорт, лимитер) не подменяется ничем.

import http from 'node:http'
import { parseEnv } from '../src/env.js'
import { createLimiter } from '../src/limits.js'
import { createSession } from '../src/mcp.js'
import { createService } from '../src/service.js'
import { TOOLS } from '../src/tools.js'

export const KEY = 'test-mcp-key'

export const RPC_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

export async function startService({ envSource = {}, fetchImpl } = {}) {
  const { env, errors } = parseEnv({ MCP_KEY: KEY, ...envSource })
  if (errors.length > 0) throw new Error(errors.join('; '))

  const limiter = createLimiter(env)
  // Счётчик собранных сессий: он отличает «служба ответила 405 сама» от
  // «405 пришёл из транспорта SDK». Коды ответа у обоих одинаковы, и без
  // этого счётчика тест на 405 не различал бы гипотезы.
  const built = { sessions: 0 }
  const handler = createService({
    env,
    limiter,
    createSession: () => {
      built.sessions += 1
      return createSession({ fetchImpl, now: () => Date.UTC(2026, 8, 23, 12, 0, 0) })
    },
    tools: TOOLS.map((t) => t.name),
  })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    base: `http://127.0.0.1:${port}`,
    built,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Запрос к эндпоинту через `node:http` без keep-alive: переиспользованное
 * соединение к уже закрытому стенду давало бы пустой ответ и «красный» тест
 * по причине, к предмету проверки не относящейся.
 */
export function rpc(base, body, { key = KEY, method = 'POST' } = {}) {
  const url = new URL(`${base}/mcp`)
  const payload = method === 'POST' ? JSON.stringify(body) : null
  const headers = { ...RPC_HEADERS }
  if (key) headers.authorization = `Bearer ${key}`
  if (payload) headers['content-length'] = String(Buffer.byteLength(payload))

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method, headers, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: () => text,
            json: () => JSON.parse(text),
          })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Ответ инструмента: наш JSON лежит текстом в первом блоке содержимого. */
export function toolPayload(rpcResponse) {
  return JSON.parse(rpcResponse.result.content[0].text)
}

// Стенд: та же сборка, что в `server.js`, но с подменённым `fetch`
// инструментов. Подменяется ровно одно — дверь наружу; предмет проверки
// (служба, JSON-RPC, разбор аргументов) настоящий.

import http from 'node:http'
import { createRpc } from '../src/rpc.js'
import { createService } from '../src/service.js'
import { buildTools } from '../src/tools.js'

export async function startService({ fetchImpl } = {}) {
  const logs = []
  const tools = buildTools({ fetchImpl })
  const server = http.createServer(
    createService({
      handleOne: createRpc({ serverInfo: { name: 'ai-advent-2026-translate', version: '1.0.0' }, tools }),
      tools: tools.map((t) => t.name),
      log: (entry) => logs.push(entry),
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Запрос без keep-alive: переиспользованное соединение к уже закрытому
 * стенду давало бы пустой ответ и «красный» тест по причине, к предмету
 * проверки не относящейся.
 */
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

/** Сырой POST: тело уходит строкой, не пройдя через JSON.stringify. */
export function rawPost(base, payload, { path = '/mcp' } = {}) {
  const url = new URL(`${base}${path}`)
  return new Promise((resolve, reject) => {
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
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode, text: () => text })
        })
      },
    )
    req.on('error', () => resolve({ status: 0, text: () => '' }))
    req.write(payload)
    req.end()
  })
}

export const call = (base, name, args) =>
  rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

/** Ответ инструмента: наш JSON лежит текстом в первом блоке содержимого. */
export const toolPayload = (response) => JSON.parse(response.result.content[0].text)

/**
 * Записывающий `fetch`: отдаёт заготовленные ответы и копит запрошенные
 * адреса. Ответ задаётся парой `{status, body}` — в отличие от `mcpnews`
 * код ответа здесь предмет проверки, а не подробность: по нему единица
 * отличает исчерпанную квоту от прочих отказов.
 */
export function recorder(replies) {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    const reply = replies.shift()
    if (reply === undefined) throw new Error('лишний запрос наружу')
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { urls, fetchImpl }
}

/** Успешный ответ MyMemory в той форме, в какой он приходит на самом деле. */
export const ok = (translatedText, extra = {}) => ({
  status: 200,
  body: {
    responseData: { translatedText, match: 0.85, ...extra },
    quotaFinished: false,
    mtLangSupported: null,
    responseDetails: '',
    responseStatus: 200,
    responderId: null,
    exception_code: null,
    matches: [],
  },
})

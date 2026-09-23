// HTTP-контракт службы MCP (ADR 2026-09-23-1227, пп. 3–4).
//
// Порядок в `handler` читается сверху вниз и таков намеренно:
//   1) /healthz — открыт, его проверяет compose;
//   2) ключ — до чтения тела: тело неавторизованного запроса не читается;
//   3) GET и DELETE — 405: без сессий поднимать поток нечему;
//   4) тело с потолком;
//   5) лимитер — ДО передачи `tools/call` транспорту, а не после (I-4 по духу:
//      проверка предшествует исполнению);
//   6) и только теперь транспорт SDK — свой на этот запрос (`src/mcp.js`).

import { timingSafeEqual } from 'node:crypto'

/** Тело JSON-RPC больше этого не читаем: у наших инструментов два коротких аргумента. */
const MAX_BODY = 64 * 1024

export const MCP_PATH = '/mcp'

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

/** Ошибка протокола: наружу уходит JSON-RPC, а не наша самодеятельность. */
function rpcError(res, status, id, code, message, headers = {}) {
  send(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, headers)
}

function bearer(req) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * Адрес клиента. Caddy ДОПИСЫВАЕТ реальный адрес в конец X-Forwarded-For,
 * поэтому берём последний элемент: первый подделывается заголовком, и тогда
 * окна на адрес обходятся сменой значения.
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const parts = forwarded.split(',')
    const last = parts[parts.length - 1].trim()
    if (last) return last
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('тело больше 64 КБ'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Сколько вызовов инструментов в этом теле. Пачка считается поштучно. */
function toolCalls(body) {
  const items = Array.isArray(body) ? body : [body]
  return items.filter((item) => item && item.method === 'tools/call').length
}

function firstId(body) {
  const items = Array.isArray(body) ? body : [body]
  for (const item of items) if (item && item.id !== undefined) return item.id
  return null
}

export function createService({ env, limiter, createSession, tools = [], log = () => {} }) {
  async function route(req, res) {
    let url
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'mcp'}`)
    } catch {
      return send(res, 400, { ok: false, code: 'bad_request' })
    }

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method_not_allowed' })
      return send(res, 200, { ok: true, tools, limits: limiter.stats() })
    }

    if (url.pathname !== MCP_PATH) return send(res, 404, { ok: false, code: 'not_found' })

    // Ключ — первое, что происходит на эндпоинте. Тело здесь ещё не прочитано.
    if (!safeEqual(bearer(req), env.MCP_KEY)) {
      log({ event: 'refuse', path: url.pathname, code: 'unauthorized' })
      return rpcError(res, 401, null, -32001, 'unauthorized')
    }

    // Только POST. GET открывал бы поток от сервера, DELETE закрывал бы
    // сессию — в режиме без сессий ни того, ни другого нет (ADR, п. 3).
    if (req.method !== 'POST') {
      return rpcError(res, 405, null, -32000, 'method not allowed', { allow: 'POST' })
    }

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return rpcError(res, 400, null, -32700, 'parse error')
    }

    // Лимитер ДО исполнения: транспорт вызывается ниже этой строки.
    const calls = toolCalls(body)
    if (calls > 0) {
      const gate = limiter.reserve(clientIp(req), calls)
      if (!gate.ok) {
        log({ event: 'refuse', path: url.pathname, code: 'rate_limited', reason: gate.reason })
        return rpcError(res, 429, firstId(body), -32002, gate.message)
      }
    }

    // Сервер и транспорт — на этот запрос: см. `src/mcp.js`.
    const { server, transport } = await createSession()
    try {
      await transport.handleRequest(req, res, body)
    } finally {
      await transport.close()
      await server.close()
    }
  }

  // Необработанный отказ в обработчике `http` валит процесс: служба должна
  // отвечать 500, а не падать. Подробности наружу не уходят.
  return async function handler(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      log({ event: 'error', message: String(error?.message ?? error) })
      if (!res.headersSent) send(res, 500, { ok: false, code: 'internal_error' })
      else res.end()
    }
  }
}

// День 16: консоль MCP (ADR 2026-09-23-1227, п. 7). Сервер дня говорит со
// службой MCP голым JSON-RPC через fetch, БЕЗ SDK: граница исключения по
// зависимостям проходит по mcp/, и у дня 16 зависимостей быть не должно
// (ADR 2026-09-23-1227, п. 2; страж — шаг «Граница runtime-зависимостей» в ci.yml).
//
// Ключ держит этот процесс. Страница его не знает, не получает и не
// показывает (I-1): она просит «не подставляй ключ», а не «дай ключ».
//
// Ручка одна — POST /api/rpc. Три её правила заданы раскладкой
// (agent_docs/design/2026-09-23-1242-mcp-console-layout.md, п. 17):
//   1. два признака проб: `http:"GET"` и `noKey:true` — без них посетитель не
//      увидит 405 и 404 нажатием;
//   2. тело ответа службы уходит на страницу КАК ЕСТЬ — те же байты, тот же
//      код; свой конверт сверху сделал бы предметом показа обёртку;
//   3. отказ лимитера несёт число секунд до повтора.
//
// Раз своего конверта нет, исход запроса называется заголовком, а не телом:
//   X-Rpc-Outcome: upstream   — байты ниже пришли от службы, код — её код;
//                  limited    — до службы не дошло, отказал лимитер страницы;
//                  unreachable — служба не ответила вовсе (единственный случай
//                                красного на экране);
//                  rejected   — запрос страницы не разобран (защитная ветка).

import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from './env.js'
import { createLimiter } from './limits.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(here, 'public')
const MAX_BODY = 64 * 1024
/** Ревизия протокола — та же, что страница показывает в строке соединения. */
const PROTOCOL_VERSION = '2025-11-25'
/** Разрешены ровно два метода: POST — работа, GET — проба на 405. */
const PROBE_METHODS = new Set(['POST', 'GET'])
/** Что можно скопировать из ответа службы: тип и только он, без параметров сверх charset. */
const SAFE_CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(; ?charset=[\w-]+)?$/i

const { env, errors: envErrors } = parseEnv()
for (const message of envErrors) console.error(`конфигурация: ${message}`)

const limiter = createLimiter(env)

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(payload))
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

/**
 * Адрес клиента. Caddy ДОПИСЫВАЕТ реальный адрес в конец X-Forwarded-For,
 * поэтому берётся последний элемент, а не первый: первый подделывается
 * заголовком запроса, и тогда окно на адрес обходится сменой значения.
 */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const parts = forwarded.split(',')
    const last = parts[parts.length - 1].trim()
    if (last) return last
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * Заголовки к службе. Ключ подставляется здесь и только здесь; признак
 * `noKey` его снимает — это и есть проба ключа. Остальные три заголовка
 * обязаны совпадать со строкой соединения на странице: расхождение делает
 * подпись ложной (раскладка, п. 3.3).
 */
function mcpHeaders({ noKey, withBody }) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
  }
  if (withBody) headers['content-type'] = 'application/json'
  if (!noKey) headers.authorization = `Bearer ${env.MCP_KEY}`
  return headers
}

async function handleRpc(req, res) {
  let ask
  try {
    ask = JSON.parse(await readBody(req))
  } catch (error) {
    return send(
      res,
      400,
      { error: error.message === 'тело больше 64 КБ' ? error.message : 'тело не JSON' },
      { 'x-rpc-outcome': 'rejected' },
    )
  }
  if (!ask || typeof ask !== 'object' || Array.isArray(ask))
    return send(res, 400, { error: 'тело должно быть объектом' }, { 'x-rpc-outcome': 'rejected' })

  const method = ask.http === undefined ? 'POST' : ask.http
  if (typeof method !== 'string' || !PROBE_METHODS.has(method))
    return send(res, 400, { error: 'http: допустимы только POST и GET' }, { 'x-rpc-outcome': 'rejected' })
  if (ask.noKey !== undefined && typeof ask.noKey !== 'boolean')
    return send(res, 400, { error: 'noKey: допустимо только true или false' }, { 'x-rpc-outcome': 'rejected' })
  // Конверт JSON-RPC собирает страница — предмет показа принадлежит ей.
  // Сервер проверяет только форму: объект и не массив.
  const withBody = method === 'POST'
  if (withBody && (!ask.rpc || typeof ask.rpc !== 'object' || Array.isArray(ask.rpc)))
    return send(res, 400, { error: 'rpc: ожидался объект конверта JSON-RPC' }, { 'x-rpc-outcome': 'rejected' })

  // Слот берётся ДО обращения к службе (I-4): лимитер защищает не наш бюджет,
  // а чужие API, куда служба ходит с нашего адреса.
  const slot = limiter.reserve(clientIp(req))
  if (!slot.ok)
    return send(
      res,
      429,
      { error: slot.message, retryAfterSec: slot.retryAfterSec },
      { 'x-rpc-outcome': 'limited', 'retry-after': String(slot.retryAfterSec) },
    )

  const started = Date.now()
  let upstream
  let text
  try {
    upstream = await fetch(env.MCP_URL, {
      method,
      headers: mcpHeaders({ noKey: ask.noKey === true, withBody }),
      body: withBody ? JSON.stringify(ask.rpc) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(env.MCP_TIMEOUT_MS),
    })
    text = await upstream.text()
  } catch (error) {
    // Имя ошибки, а не её текст: текст fetch может нести адрес службы, а
    // причина страницу интересует одной из двух.
    const reason = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'network'
    console.error(`служба MCP: ${error.name}`)
    return send(
      res,
      502,
      { error: 'Служба MCP не ответила.' },
      { 'x-rpc-outcome': 'unreachable', 'x-rpc-reason': reason },
    )
  }

  // Байты уходят как есть. Из заголовков службы копируется только тип
  // содержимого и только знакомой формы: остальные — её дело, не страницы.
  //
  // Не прислала типа — не дописываем свой. Раньше здесь стояло умолчание
  // `application/json`, и пустой ответ службы уезжал на страницу с обещанием
  // JSON, которого в нём нет. Обещание на пустом теле — та же ложь, что
  // переупаковка непустого.
  const upstreamType = upstream.headers.get('content-type') ?? ''
  res.writeHead(upstream.status, {
    ...(SAFE_CONTENT_TYPE.test(upstreamType) ? { 'content-type': upstreamType } : {}),
    'cache-control': 'no-store',
    'x-rpc-outcome': 'upstream',
    'x-rpc-ms': String(Date.now() - started),
    'x-rpc-bytes': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Без этой строки страница не работает вовсе: модуль, отданный как
  // application/octet-stream, браузер не исполняет.
  '.js': 'text/javascript; charset=utf-8',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    const ok = envErrors.length === 0
    return send(res, ok ? 200 : 503, { ok, errors: envErrors, limiter: limiter.stats() })
  }

  if (url.pathname === '/api/rpc' && req.method === 'POST') return handleRpc(req, res)

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = normalize(join(PUBLIC, rel))
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const data = await readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('не найдено')
  }
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(env.PORT, () => console.log(`день 16 слушает :${env.PORT}`))
}

export { env, server }
